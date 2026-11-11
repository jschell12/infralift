import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { decryptToken } from "../crypto.js";
import {
  renderTemplate,
  validateArguments,
  renderedFileName,
  renderProviderFile,
  type TfArguments,
  type ProviderConfig,
} from "./render.js";
import { deliverChangeRequest } from "../git/deliver.js";
import { deliveryFor, getStack, renderStack } from "../stacks/index.js";
import { gitHostClient, type GitHostClient, type HostFile } from "../git/hosts.js";
import { isGitHost, PROVIDER_LABELS, type GitHost } from "@infralift/shared";
import { tfcAdapterFor } from "./tfc-connection.js";
import { recordJobWorkspaceNote } from "./workspace-record.js";
import type { CreatedWorkspace } from "./workspace.js";
import { JobRun } from "../jobs/state.js";
import { generateHcl } from "./codegen.js";
import { checkEnv, checkSetupLines, renderImportCheck } from "../import/check.js";
import { renderApplyWorkflow } from "../import/apply.js";
import type { RootModule } from "../import/scan.js";
import type { Provider, ResourceInventoryItem } from "@infralift/shared";
import { markInvalidOnAuthFailure } from "../../services/connections.js";
import { PREFER_USABLE_CONNECTION } from "../connection-order.js";

// Staged pipeline. Stages and statuses move only through the job state
// machine (lib/jobs/state.ts); each runner holds one JobRun and reports to it.

/** A JobRun that records each state on the TfJob row. */
function jobRun(jobId: string): JobRun {
  return new JobRun(jobId, async (id, s) => {
    await prisma.tfJob.update({
      where: { id },
      data: { stage: s.stage, status: s.status, statusMessage: s.message },
    });
  });
}

async function getGithubToken(orgId: string): Promise<string | null> {
  const conn = await prisma.providerConnection.findFirst({
    where: { orgId, provider: "github" },
    // Prefer a connection that last verified successfully. findFirst on
    // createdAt alone happily hands back a token already known to be invalid,
    // and the failure then surfaces from the GitHub API instead of from here.
    orderBy: PREFER_USABLE_CONNECTION,
  });
  return conn ? decryptToken(conn.encryptedToken) : null;
}

const NO_GITHUB =
  'no github connection for org — add one under /connections with provider "github"';

const JOB_INCLUDE = {
  project: {
    include: {
      templateVersion: { include: { template: true } },
      assessment: { include: { inventory: true } },
    },
  },
} satisfies Prisma.TfJobInclude;

export async function runJob(jobId: string): Promise<void> {
  const job = await prisma.tfJob.findUniqueOrThrow({
    where: { id: jobId },
    include: JOB_INCLUDE,
  });

  if (job.kind === "codegen") {
    return runCodegenJob(jobId, job);
  }
  if (job.kind === "stack") {
    return runStackJob(jobId, job);
  }
  if (job.kind === "import") {
    return runImportJob(jobId, job);
  }

  const run = jobRun(jobId);
  const project = job.project;
  const version = project.templateVersion;
  const args = job.argumentsJson as TfArguments;

  try {
    if (!version) {
      await run.fail("template job on a project with no template version", "render");
      return;
    }

    // -- render ------------------------------------------------------------
    await run.start("render");
    validateArguments(version.inputSchema as object, args);
    const body = renderTemplate(version.templateBody, args);
    const fileName = renderedFileName(project.name, jobId);
    const rendering = await prisma.tfRendering.upsert({
      where: { projectId_fileName: { projectId: project.id, fileName } },
      create: {
        projectId: project.id,
        templateVersionId: version.id,
        fileName,
        argumentsJson: args,
        renderedBody: body,
      },
      update: { argumentsJson: args, renderedBody: body },
    });
    await prisma.tfJob.update({
      where: { id: jobId },
      data: { renderingId: rendering.id },
    });

    // -- commit ------------------------------------------------------------
    await run.start("commit");
    const token = await getGithubToken(project.orgId);
    if (!token) {
      await run.fail(NO_GITHUB, "commit");
      return;
    }
    // Template projects commit straight to destBranch of a repository
    // infralift renders into (legacy flow; stacks and imports open requests).
    const github = gitHostClient("github", token);
    const providerCfg = project.providerConfig as unknown as ProviderConfig;
    const providerResult = await github.commitFiles({
      repo: project.destRepo,
      workDir: project.destPath,
      files: [{ fileName: "provider.tf", content: renderProviderFile(providerCfg) }],
      message: `infralift: pin ${providerCfg.name} provider for ${project.name}`,
      branch: project.destBranch,
    });
    const fileResult = await github.commitFiles({
      repo: project.destRepo,
      workDir: project.destPath,
      files: [{ fileName, content: body }],
      message: `infralift: render ${version.template.slug}@${version.releaseTag} for ${project.name}`,
      branch: project.destBranch,
    });
    const commitSha = fileResult.commitSha ?? providerResult.commitSha;
    if (commitSha) {
      await prisma.tfRendering.update({
        where: { id: rendering.id },
        data: { commitSha },
      });
    }

    // -- workspace ---------------------------------------------------------
    await run.start("workspace");
    // Only in the customer's own Terraform Cloud, through their connection.
    let workspaceNote = "no Terraform Cloud connection; no workspace";
    if (project.tfcConnectionId) {
      const workspaceName = `${project.name}-${providerCfg.region ?? "default"}`;
      const { adapter, cred } = await tfcAdapterFor(project.orgId, project.tfcConnectionId);
      const ws = await adapter.createWorkspace({
        workspaceName,
        repo: project.destRepo,
        branch: project.destBranch,
        workingDirectory: project.destPath,
        autoApply: false,
      });
      const run = await adapter.queueRun(workspaceName, `infralift job ${jobId}`);
      await prisma.tfJob.update({ where: { id: jobId }, data: { workspaceName } });
      const listed = await recordJobWorkspaceNote({ orgId: project.orgId, projectId: project.id, connectionId: project.tfcConnectionId, cred, ws });
      workspaceNote = `workspace ${cred.organization}/${workspaceName} run ${run.status}; ${vcsNote(ws, run.runId !== "none")}; ${listed}`;
    }

    // -- complete ----------------------------------------------------------
    await run.succeed(fileResult.noop ? `up to date; ${workspaceNote}` : `committed ${commitSha ?? "?"}; ${workspaceNote}`);
  } catch (err) {
    await run.failSafely(err);
  }
}

// ---------------------------------------------------------------------------
// Codegen jobs: assessment -> HCL -> repo -> workspace
// ---------------------------------------------------------------------------

type CodegenJob = Prisma.TfJobGetPayload<{ include: typeof JOB_INCLUDE }>;

/** The approval half of the funnel: the customer has picked a target, so turn
 * their assessment into a repository of Terraform and a workspace to run it.
 *
 * This shares the template pipeline's stages and status vocabulary so the
 * dashboard renders both the same way, but the render and commit stages differ
 * in kind: there is no template to fill in, and the output is a directory that
 * only makes sense committed together.
 */
async function runCodegenJob(jobId: string, job: CodegenJob): Promise<void> {
  const run = jobRun(jobId);
  const project = job.project;
  const assessment = project.assessment;

  try {
    // -- render ------------------------------------------------------------
    await run.start("render");

    if (!assessment) {
      await run.fail("codegen job on a project with no assessment", "render");
      return;
    }
    if (assessment.status !== "completed") {
      await run.fail(`assessment is ${assessment.status}, not completed`, "render");
      return;
    }

    const inventory: ResourceInventoryItem[] = assessment.inventory.map((i) => ({
      provider: i.provider as Provider,
      type: i.type,
      externalId: i.externalId,
      name: i.name,
      region: i.region ?? undefined,
      monthlyCostCents: i.monthlyCostCents ?? undefined,
      metadata: (i.metadata as Record<string, unknown> | null) ?? undefined,
    }));

    const args = (job.argumentsJson ?? {}) as Prisma.InputJsonObject &
      Record<string, unknown>;
    const files = generateHcl({
      provider: assessment.provider as Provider,
      inventory,
      backend: (args.backend as "tfc" | "s3" | "local") ?? "local",
      tfcOrg: args.tfcOrg as string | undefined,
      s3Bucket: args.s3Bucket as string | undefined,
      s3Endpoint: args.s3Endpoint as string | undefined,
      projectName: project.name,
      migrationTarget:
        (project.migrationTarget as "cloudflare" | "hetzner" | null) ?? null,
    });

    // One rendering row per generated file so the dashboard can list what was
    // written. Filenames are stable across runs, so these upsert in place
    // rather than accumulating a row per job the way template renders do.
    for (const file of files) {
      await prisma.tfRendering.upsert({
        where: {
          projectId_fileName: { projectId: project.id, fileName: file.fileName },
        },
        create: {
          projectId: project.id,
          fileName: file.fileName,
          argumentsJson: args,
          renderedBody: file.content,
        },
        update: { argumentsJson: args, renderedBody: file.content },
      });
    }
    await prisma.tfJob.update({
      where: { id: jobId },
      data: { fileCount: files.length },
    });

    // -- commit ------------------------------------------------------------
    await run.start("commit");
    const token = await getGithubToken(project.orgId);
    if (!token) {
      await run.fail(NO_GITHUB, "commit");
      return;
    }

    // infralift promises to create the infra repo as part of approval, so a
    // repo that does not exist yet is the expected case, not an error.
    const github = gitHostClient("github", token);
    const repo = await github.ensureRepo({
      repo: project.destRepo,
      description: `Infrastructure for ${project.name}, generated by infralift`,
      private: true,
    });
    const branch = repo.created ? repo.defaultBranch : project.destBranch;

    const result = await github.commitFiles({
      repo: repo.repo,
      branch,
      workDir: project.destPath,
      files,
      message:
        `infralift: ${project.migrationTarget ?? "infrastructure"} for ${project.name}\n\n` +
        `Generated from assessment ${assessment.id} (${assessment.provider}, ` +
        `${inventory.length} resources).`,
    });

    await prisma.tfJob.update({
      where: { id: jobId },
      data: { commitSha: result.commitSha, ...(repo.created ? {} : {}) },
    });
    if (result.commitSha) {
      await prisma.tfRendering.updateMany({
        where: { projectId: project.id },
        data: { commitSha: result.commitSha },
      });
    }
    // A repo created just now may have a different default branch than the
    // project recorded; keep them in step so later jobs commit to one place.
    if (branch !== project.destBranch) {
      await prisma.tfProject.update({
        where: { id: project.id },
        data: { destBranch: branch },
      });
    }

    // -- workspace ---------------------------------------------------------
    await run.start("workspace");
    // Only in the customer's own Terraform Cloud, through their connection.
    let workspaceNote = "no Terraform Cloud connection; no workspace";
    if (project.tfcConnectionId) {
      const workspaceName = project.name;
      const { adapter, cred } = await tfcAdapterFor(project.orgId, project.tfcConnectionId);
      const ws = await adapter.createWorkspace({
        workspaceName,
        repo: repo.repo,
        branch,
        workingDirectory: project.destPath,
        autoApply: false,
      });
      const run = await adapter.queueRun(workspaceName, `infralift job ${jobId}`);
      await prisma.tfJob.update({ where: { id: jobId }, data: { workspaceName } });
      const listed = await recordJobWorkspaceNote({ orgId: project.orgId, projectId: project.id, connectionId: project.tfcConnectionId, cred, ws });
      workspaceNote = `workspace ${cred.organization}/${workspaceName} run ${run.status}; ${vcsNote(ws, run.runId !== "none")}; ${listed}`;
    }

    // -- complete ----------------------------------------------------------
    const what = result.noop
      ? `${files.length} files already up to date`
      : `committed ${files.length} files as ${result.commitSha?.slice(0, 7)}`;
    await run.succeed(`${repo.created ? "created " + repo.repo + "; " : ""}${what}; ${workspaceNote}`);
  } catch (err) {
    await run.failSafely(err);
  }
}

// ---------------------------------------------------------------------------
// Stack jobs: settings -> deploy setup -> pull request -> (TFC) workspace
// ---------------------------------------------------------------------------

/** Branch a stack job's pull request comes from. Unique per job; a re-run
 * while an earlier PR is still open reuses that PR's branch instead. */
export function stackBranchName(projectName: string, jobId: string): string {
  return `${stackBranchPrefix(projectName)}${jobId.slice(-8)}`;
}

export function stackBranchPrefix(projectName: string): string {
  return `infralift/${projectName}-`;
}

/** True only for a branch stackBranchName made for this exact project. A
 * prefix test would let project "app" claim "app-staging"'s branch, because
 * "infralift/app-" is a prefix of "infralift/app-staging-...". */
export function isStackBranch(projectName: string, ref: string): boolean {
  const prefix = stackBranchPrefix(projectName);
  return ref.startsWith(prefix) && /^[a-z0-9]{8}$/.test(ref.slice(prefix.length));
}

/** Renders a stack into the customer's app repository as a pull request.
 *
 * Unlike codegen, the destination is a repository the customer works in, so
 * nothing is pushed to destBranch: the files arrive on a branch of their own
 * and the customer merges them. Seed files (overrides.tf) are left out when
 * the repository already has them, which is what makes them the customer's.
 */
/** Token for the project's git host: its own connection if it names one,
 *  otherwise the org's best connection to that host. */
async function getGitToken(
  orgId: string,
  host: GitHost,
  connectionId: string | null
): Promise<{ token: string; connection: { id: string; provider: string } } | null> {
  const conn = await prisma.providerConnection.findFirst({
    where: { orgId, provider: host, ...(connectionId ? { id: connectionId } : {}) },
    orderBy: PREFER_USABLE_CONNECTION,
  });
  return conn ? { token: decryptToken(conn.encryptedToken), connection: { id: conn.id, provider: conn.provider } } : null;
}

async function runStackJob(jobId: string, job: CodegenJob): Promise<void> {
  const run = jobRun(jobId);
  const project = job.project;
  const host = (isGitHost(project.gitHost) ? project.gitHost : "github") as GitHost;
  let client: GitHostClient | null = null;
  let gitConnection: { id: string; provider: string } | null = null;
  try {
    // -- render ------------------------------------------------------------
    await run.start("render");
    const stack = project.stackSlug ? getStack(project.stackSlug) : null;
    if (!stack) {
      await run.fail(`stack ${project.stackSlug ?? "(none)"} not found`, "render");
      return;
    }
    // A delivery runs on one git host; the project's settings must name one
    // that runs where the project's repository lives (or name none, and get
    // the stack's delivery for that host).
    const stored = (job.argumentsJson ?? {}) as TfArguments;
    const delivery = deliveryFor(stack, host, stored.delivery);
    if (!delivery) {
      const names = stack.deliveries.filter((d) => d.gitHost === host).map((d) => d.name);
      await run.fail(
        names.length
          ? `delivery ${String(stored.delivery)} does not run on ${PROVIDER_LABELS[host]}; use ${names.join(" or ")}`
          : `${stack.name} has no delivery that runs on ${PROVIDER_LABELS[host]}`,
        "render"
      );
      return;
    }
    const args: TfArguments = {
      ...stored,
      delivery: delivery.slug,
      ...(host === "gitlab" ? { gitlab_project: project.destRepo } : {}),
    };
    const rendered = renderStack(stack, args);

    const git = await getGitToken(project.orgId, host, project.gitConnectionId);
    gitConnection = git?.connection ?? null;
    const token = git?.token;
    if (!token) {
      await run.fail(`no ${PROVIDER_LABELS[host]} connection for this org: add one under Connections`, "repo");
      return;
    }
    client = gitHostClient(host, token);
    const noun = client.changeRequestNoun;

    // -- repo --------------------------------------------------------------
    // Greenfield: the repository is created from the stack's app template,
    // then the infrastructure lands in it the same way as anywhere else.
    let destBranch = project.destBranch;
    let createdRepoNote = "";
    if (project.createRepo) {
      await run.start("repo");
      if (!(await client.repoExists(project.destRepo))) {
        const created = await client.createFromTemplate({
          template: stack.template.repo,
          repo: project.destRepo,
          private: true,
        });
        destBranch = created.defaultBranch;
        createdRepoNote = `created ${created.url}; `;
      }
      await prisma.tfProject.update({
        where: { id: project.id },
        data: { createRepo: false, destBranch },
      });
    }

    // -- commit ------------------------------------------------------------
    await run.start("commit");
    const repo = project.destRepo;
    const prefix = project.destPath ? `${project.destPath.replace(/^\/+|\/+$/g, "")}/` : "";

    let seedsKept = 0;
    let fileCount = 0;
    const landed = await deliverChangeRequest(client, {
      repo,
      base: destBranch,
      isMine: (ref) => isStackBranch(project.name, ref),
      newBranch: stackBranchName(project.name, jobId),
      workDir: project.destPath,
      // A seed file is the customer's once it exists anywhere they might have
      // edited it: the default branch, or the open request's branch this
      // commit lands on.
      files: async (existing) => {
        const seedBranches = existing ? [destBranch, existing.branch] : [destBranch];
        const files: HostFile[] = [];
        for (const f of rendered) {
          let exists = false;
          if (f.ownership === "seed") {
            for (const b of seedBranches) {
              if (await client!.fileExists({ repo, path: `${prefix}${f.path}`, branch: b })) {
                exists = true;
                break;
              }
            }
          }
          if (exists) {
            seedsKept++;
            continue;
          }
          files.push({ fileName: f.path, content: f.content, mode: f.mode });
        }
        // Rendering rows mirror what this job wrote, for the dashboard.
        for (const f of files) {
          await prisma.tfRendering.upsert({
            where: { projectId_fileName: { projectId: project.id, fileName: f.fileName } },
            create: { projectId: project.id, fileName: f.fileName, argumentsJson: args, renderedBody: f.content },
            update: { argumentsJson: args, renderedBody: f.content },
          });
        }
        await prisma.tfJob.update({ where: { id: jobId }, data: { fileCount: files.length } });
        fileCount = files.length;
        return files;
      },
      message:
        `infralift: ${stack.slug} for ${project.name}\n\n` +
        `Rendered from stack ${stack.slug} (source ${stack.source.repo}@${stack.source.commit.slice(0, 7)}).`,
      title: `infralift: ${stack.name} for ${project.name}`,
      body: () =>
        [
          `Rendered by infralift from the \`${stack.slug}\` stack.`,
          "",
          `- ${fileCount} files written; files under \`deploy/infra/generated/\` and the CI files are managed by infralift and rewritten on every change.`,
          seedsKept
            ? `- ${seedsKept} file(s) you own (such as \`deploy/infra/overrides.tf\`) already existed and were left alone.`
            : "- `deploy/infra/overrides.tf` is yours from here on; infralift never rewrites it.",
          "",
          "See `deploy/README.md` for the credentials and first apply.",
        ].join("\n"),
    });
    const files = landed.files;
    if (landed.outcome === "unchanged") {
      await run.succeed(
        landed.existing
          ? `${createdRepoNote}already up to date in ${landed.existing.url}`
          : `${createdRepoNote}${files.length} files already up to date; no ${noun}`
      );
      return;
    }
    const cr = { url: landed.url };
    const openCr = landed.outcome === "updated";
    await prisma.tfJob.update({
      where: { id: jobId },
      data: { commitSha: landed.commitSha, prUrl: cr.url },
    });
    await prisma.tfRendering.updateMany({
      where: { projectId: project.id, fileName: { in: files.map((f) => f.fileName) } },
      data: { commitSha: landed.commitSha },
    });

    // -- workspace ---------------------------------------------------------
    // Only a Terraform Cloud backend has a workspace to create. It plans the
    // change once the request is merged only if it is linked to the repo,
    // which needs a VCS connection picked for the TFC connection.
    await run.start("workspace");
    let workspaceNote = "state in R2; no workspace";
    if (args.backend === "tfc") {
      // The generated cloud {} block names the connection's organization
      // (the API derives tfc_organization from it), so the workspace lands in
      // the org the code points at.
      if (!project.tfcConnectionId) {
        await run.fail(`opened ${cr.url}, but no Terraform Cloud connection is set: pick one in the project's settings`, "workspace");
        return;
      }
      const workspaceName = String(args.tfc_workspace ?? args.name);
      const { adapter, cred } = await tfcAdapterFor(project.orgId, project.tfcConnectionId);
      const ws = await adapter.createWorkspace({
        workspaceName,
        repo,
        branch: destBranch,
        workingDirectory: `${prefix}deploy/infra`,
        autoApply: false,
        // No run is queued here (the change is not merged yet), so TFC would
        // hold the merge's run until someone queued one by hand.
        queueAllRuns: true,
      });
      await prisma.tfJob.update({ where: { id: jobId }, data: { workspaceName } });
      const listed = await recordJobWorkspaceNote({ orgId: project.orgId, projectId: project.id, connectionId: project.tfcConnectionId, cred, ws });
      workspaceNote = `workspace ${workspaceName}; ${vcsNote(ws, false)}; ${listed}`;
    }

    // -- complete ----------------------------------------------------------
    await run.succeed(`${createdRepoNote}${openCr ? "updated" : "opened"} ${cr.url} (${files.length} files); ${workspaceNote}`);
  } catch (err) {
    await markInvalidOnAuthFailure(gitConnection, err, "git", "a git job");
    await run.failSafely(err);
  }
}

// ---------------------------------------------------------------------------
// Import jobs: scan -> read-only plan check -> pull request
// ---------------------------------------------------------------------------

/** Adds the import check for an existing root module to the customer's
 *  repository as a pull request. Nothing in their Terraform is changed: the
 *  only file is the workflow, and it plans without applying or locking. An
 *  adoption also adds its files and the apply workflow, which applies once
 *  the pull request is merged (lib/import/apply.ts). */
async function runImportJob(jobId: string, job: CodegenJob): Promise<void> {
  const run = jobRun(jobId);
  const project = job.project;
  let client: GitHostClient | null = null;
  let gitConnection: { id: string; provider: string } | null = null;
  try {
    await run.start("render");
    const root = project.importJson as unknown as RootModule | null;
    if (!root || project.gitHost !== "github") {
      await run.fail("import needs a scanned module in a GitHub repository", "render");
      return;
    }
    const args = (job.argumentsJson ?? {}) as {
      backendConfigFile?: string | null;
      /** Adoption from a cloud account: versions/provider/imports for destPath. */
      adoptFiles?: { path: string; content: string }[];
    };
    const check = renderImportCheck(root, { backendConfigFile: args.backendConfigFile ?? null });
    // Only an adoption gets an apply: a repository import already has the
    // customer's own pipeline applying it, and a second one would race it.
    const workflows = root.generateConfig
      ? [check, renderApplyWorkflow(root, { branch: project.destBranch, repo: project.destRepo, backendConfigFile: args.backendConfigFile ?? null })]
      : [check];

    const git = await getGitToken(project.orgId, "github", project.gitConnectionId);
    gitConnection = git?.connection ?? null;
    const token = git?.token;
    if (!token) {
      await run.fail("no GitHub connection for this org: add one under Connections", "commit");
      return;
    }
    client = gitHostClient("github", token);

    await run.start("commit");
    const repo = project.destRepo;
    for (const w of workflows) {
      await prisma.tfRendering.upsert({
        where: { projectId_fileName: { projectId: project.id, fileName: w.path } },
        create: { projectId: project.id, fileName: w.path, argumentsJson: args, renderedBody: w.content },
        update: { argumentsJson: args, renderedBody: w.content },
      });
    }
    await prisma.tfJob.update({ where: { id: jobId }, data: { fileCount: workflows.length } });

    const label = root.path || "the repository root";
    const env = checkEnv(root);
    const landed = await deliverChangeRequest(client, {
      repo,
      base: project.destBranch,
      isMine: (ref) => isStackBranch(project.name, ref),
      newBranch: stackBranchName(project.name, jobId),
      // The workflow lives at the repository root; adoption files under destPath.
      workDir: "",
      files: async () => [
        ...workflows.map((w) => ({ fileName: w.path, content: w.content })),
        ...(args.adoptFiles ?? []).map((f) => ({
          fileName: project.destPath ? `${project.destPath}/${f.path}` : f.path,
          content: f.content,
        })),
      ],
      message: root.generateConfig
        ? `infralift: adopt resources into ${label}\n\nImport blocks, a read-only check, and an apply workflow that runs once this is merged.`
        : `infralift: import check for ${label}\n\nRead-only plan against the existing state; applies nothing.`,
      title: root.generateConfig
        ? `infralift: adopt ${root.resources} resources into ${label}`
        : `infralift: import check for ${label}`,
      body: () => importRequestBody(root, repo, label, project.destBranch),
    });
    if (landed.outcome === "unchanged") {
      await run.succeed(
        landed.existing ? `already up to date in ${landed.existing.url}` : "the import check is already in the repository"
      );
      return;
    }
    await prisma.tfJob.update({ where: { id: jobId }, data: { commitSha: landed.commitSha, prUrl: landed.url } });
    await run.succeed(
      `${landed.outcome} ${landed.url}; ${env.length ? `add ${env.length} secret(s), then ` : ""}the check plans read-only`
    );
  } catch (err) {
    await markInvalidOnAuthFailure(gitConnection, err, "git", "a git job");
    await run.failSafely(err);
  }
}

/** The import or adoption pull request's description. Says what happens on
 *  merge: for an adoption, the apply workflow applies; for an import, nothing. */
function importRequestBody(root: RootModule, repo: string, label: string, branch: string): string {
  const env = checkEnv(root);
  const setup = checkSetupLines(root);
  const adopt = root.generateConfig === true;
  return [
    ...(adopt
      ? [
          `infralift is adopting ${root.resources} resources that already run in your account into \`${label}\`, without changing them. This pull request adds import blocks, a provider and a backend for state in ${root.backend.kind === "r2" ? "R2" : "S3"} (\`${root.backend.settings.bucket}\`), plus two workflows: the check and the apply.`,
          "",
          "There is no hand-written resource code. The check generates it from what is actually running (`plan -generate-config-out`) and commits it to this branch as `generated.tf`, then holds it to the same rule: the plan may import, but must change and destroy nothing. Before committing, it scans `generated.tf` for values that look like secrets (attribute names such as `password` or `token` with a literal value, and gitleaks) and commits nothing if it finds one.",
          "",
          `**Merging starts the apply.** On the push to \`${branch}\`, the apply workflow plans and applies exactly that plan, in one job in the \`production\` environment; the plan file never leaves the runner. That apply is what records the resources in state; until it has run they exist only as code, and infralift shows the project as adopted, not yet applied. Add required reviewers to the \`production\` environment (Settings, Environments) to hold each run for approval; they approve before it plans, and the plan is the one this pull request's check showed. The apply needs credentials that can write state and take its lock; put those on the environment, and keep the repository secrets read-only for the check. Environment secrets win over repository secrets of the same name.`,
          "",
          "The check itself runs a **read-only** plan on pull requests and daily on the default branch. It applies nothing and runs with `-lock=false`, so it cannot change your infrastructure or block your own pipeline.",
        ]
      : [
          `infralift is importing the Terraform in \`${label}\` (${root.resources} resources, state in ${root.backend.kind}).`,
          "",
          "This pull request adds a workflow that runs a **read-only** plan against the existing state. It applies nothing and runs with `-lock=false`, so it cannot change your infrastructure or block your own pipeline. Merging it applies nothing either: your own pipeline keeps applying this module.",
        ]),
    "infralift never sees your state or your credentials: the plans run here, with your secrets.",
    "",
    "The import is safe to finish when the check passes, which means the plan changes nothing: the code already matches what is running, so taking it over cannot cause downtime. If it fails, the job summary lists each resource that would change.",
    "",
    env.length
      ? `Set these before the check can run (Settings, Secrets and variables, Actions):\n\n${setup.map((l) => `- ${l}`).join("\n")}\n\nOIDC is the better choice where a cloud offers it: CI signs in as a role for each run and no key is stored. This check runs on pull requests, so the role's trust policy (AWS) or federated credential (Azure, Google Cloud) must allow pull-request runs from this repository, not only \`main\`; on AWS that is the subject \`repo:${repo}:pull_request\`.${adopt ? ` The apply job runs in the \`production\` environment, whose subject is \`repo:${repo}:environment:production\`.` : ""} Give the check's credentials read-only roles. A plan runs provider code and data sources with whatever the secrets allow, so read-only on state is not read-only on the account unless the roles are.`
      : "The check needs no secrets.",
    ...(root.notes.length ? ["", "Notes from the scan:", "", ...root.notes.map((n) => `- ${n}`)] : []),
  ].join("\n");
}

/** Whether a merge will plan, said only when it is true: the workspace is
 *  linked, and TFC will queue a push's run (queue-all-runs, or a run was
 *  already queued by hand, which is `queuedRun`). */
export function vcsNote(ws: CreatedWorkspace, queuedRun: boolean): string {
  if (ws.vcsRepo && (ws.queueAllRuns || queuedRun)) {
    return `linked to ${ws.vcsRepo}, so it plans once the change is merged`;
  }
  if (ws.vcsRepo) {
    return `linked to ${ws.vcsRepo}, but a merge plans only after a first run: queue one under Workspaces`;
  }
  if (ws.linkError) return `${ws.linkError}, so it was created unlinked and a merge does not plan: link it under Workspaces`;
  return "not linked to a repository, so a merge does not plan: pick a VCS connection under Workspaces";
}
