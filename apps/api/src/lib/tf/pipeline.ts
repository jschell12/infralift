import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { decryptToken } from "../crypto.js";
import {
  renderTemplate,
  validateArguments,
  renderedFileName,
  renderProviderFile,
  TfInputValidationError,
  type TfArguments,
  type ProviderConfig,
} from "./render.js";
import { commitFile, commitFiles, ensureRepo } from "./git.js";
import { deliveryFor, getStack, renderStack } from "../stacks/index.js";
import { gitHostClient, type GitHostClient, type HostFile } from "../git/hosts.js";
import { isGitHost, PROVIDER_LABELS, type GitHost } from "@infralift/shared";
import { getWorkspaceAdapter } from "./workspace.js";
import { generateHcl } from "./codegen.js";
import { checkEnv, renderImportCheck } from "../import/check.js";
import type { RootModule } from "../import/scan.js";
import type { Provider, ResourceInventoryItem } from "@infralift/shared";

// Staged pipeline: queued -> render -> commit -> workspace -> complete.
// Each stage flips status pending -> running -> success (or errored, which
// halts the job with a short statusMessage).

async function setStage(jobId: string, stage: string, status: string, message = "") {
  await prisma.tfJob.update({
    where: { id: jobId },
    data: { stage, status, statusMessage: message.slice(0, 280) },
  });
}

async function getGithubToken(orgId: string): Promise<string | null> {
  const conn = await prisma.providerConnection.findFirst({
    where: { orgId, provider: "github" },
    // Prefer a connection that last verified successfully. findFirst on
    // createdAt alone happily hands back a token already known to be invalid,
    // and the failure then surfaces from the GitHub API instead of from here.
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
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

  const project = job.project;
  const version = project.templateVersion;
  const args = job.argumentsJson as TfArguments;

  try {
    if (!version) {
      await setStage(
        jobId,
        "render",
        "errored",
        "template job on a project with no template version"
      );
      return;
    }

    // -- render ------------------------------------------------------------
    await setStage(jobId, "render", "running");
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
    await setStage(jobId, "commit", "running");
    const token = await getGithubToken(project.orgId);
    if (!token) {
      await setStage(jobId, "commit", "errored", NO_GITHUB);
      return;
    }
    const providerCfg = project.providerConfig as unknown as ProviderConfig;
    const providerResult = await commitFile({
      token,
      repo: project.destRepo,
      workDir: project.destPath,
      fileName: "provider.tf",
      content: renderProviderFile(providerCfg),
      message: `infralift: pin ${providerCfg.name} provider for ${project.name}`,
      branch: project.destBranch,
    });
    const fileResult = await commitFile({
      token,
      repo: project.destRepo,
      workDir: project.destPath,
      fileName,
      content: body,
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
    await setStage(jobId, "workspace", "running");
    const workspaceName = `${project.name}-${providerCfg.region ?? "default"}`;
    const adapter = getWorkspaceAdapter();
    await adapter.createWorkspace({
      workspaceName,
      repo: project.destRepo,
      branch: project.destBranch,
      workingDirectory: project.destPath,
      autoApply: false,
    });
    const run = await adapter.queueRun(
      workspaceName,
      `infralift job ${jobId}`
    );
    await prisma.tfJob.update({
      where: { id: jobId },
      data: { workspaceName },
    });

    // -- complete ----------------------------------------------------------
    await setStage(
      jobId,
      "complete",
      "success",
      fileResult.noop
        ? `up to date; workspace run ${run.status}`
        : `committed ${commitSha ?? "?"}; workspace run ${run.status}`
    );
  } catch (err) {
    const msg =
      err instanceof TfInputValidationError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
    const current = await prisma.tfJob.findUnique({
      where: { id: jobId },
      select: { stage: true },
    });
    await setStage(jobId, current?.stage ?? "render", "errored", msg);
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
  const project = job.project;
  const assessment = project.assessment;

  try {
    // -- render ------------------------------------------------------------
    await setStage(jobId, "render", "running");

    if (!assessment) {
      await setStage(
        jobId,
        "render",
        "errored",
        "codegen job on a project with no assessment"
      );
      return;
    }
    if (assessment.status !== "completed") {
      await setStage(
        jobId,
        "render",
        "errored",
        `assessment is ${assessment.status}, not completed`
      );
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
    await setStage(jobId, "commit", "running");
    const token = await getGithubToken(project.orgId);
    if (!token) {
      await setStage(jobId, "commit", "errored", NO_GITHUB);
      return;
    }

    // infralift promises to create the infra repo as part of approval, so a
    // repo that does not exist yet is the expected case, not an error.
    const repo = await ensureRepo({
      token,
      repo: project.destRepo,
      description: `Infrastructure for ${project.name}, generated by infralift`,
      private: true,
    });
    const branch = repo.created ? repo.defaultBranch : project.destBranch;

    const result = await commitFiles({
      token,
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
    await setStage(jobId, "workspace", "running");
    const workspaceName = project.name;
    const adapter = getWorkspaceAdapter();
    await adapter.createWorkspace({
      workspaceName,
      repo: repo.repo,
      branch,
      workingDirectory: project.destPath,
      autoApply: false,
    });
    const run = await adapter.queueRun(workspaceName, `infralift job ${jobId}`);
    await prisma.tfJob.update({
      where: { id: jobId },
      data: { workspaceName },
    });

    // -- complete ----------------------------------------------------------
    const what = result.noop
      ? `${files.length} files already up to date`
      : `committed ${files.length} files as ${result.commitSha?.slice(0, 7)}`;
    await setStage(
      jobId,
      "complete",
      "success",
      `${repo.created ? "created " + repo.repo + "; " : ""}${what}; workspace run ${run.status}`
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const current = await prisma.tfJob.findUnique({
      where: { id: jobId },
      select: { stage: true },
    });
    await setStage(jobId, current?.stage ?? "render", "errored", msg);
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
): Promise<string | null> {
  const conn = await prisma.providerConnection.findFirst({
    where: { orgId, provider: host, ...(connectionId ? { id: connectionId } : {}) },
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
  });
  return conn ? decryptToken(conn.encryptedToken) : null;
}

async function runStackJob(jobId: string, job: CodegenJob): Promise<void> {
  const project = job.project;
  const host = (isGitHost(project.gitHost) ? project.gitHost : "github") as GitHost;
  let client: GitHostClient | null = null;
  // Set once this job has created a branch of its own, so a failure before
  // the change request exists can remove it rather than leave debris in the
  // customer's repository.
  let createdBranch: string | null = null;
  try {
    // -- render ------------------------------------------------------------
    await setStage(jobId, "render", "running");
    const stack = project.stackSlug ? getStack(project.stackSlug) : null;
    if (!stack) {
      await setStage(
        jobId,
        "render",
        "errored",
        `stack ${project.stackSlug ?? "(none)"} not found`
      );
      return;
    }
    // A delivery runs on one git host; the project's settings must name one
    // that runs where the project's repository lives (or name none, and get
    // the stack's delivery for that host).
    const stored = (job.argumentsJson ?? {}) as TfArguments;
    const delivery = deliveryFor(stack, host, stored.delivery);
    if (!delivery) {
      const names = stack.deliveries.filter((d) => d.gitHost === host).map((d) => d.name);
      await setStage(
        jobId,
        "render",
        "errored",
        names.length
          ? `delivery ${String(stored.delivery)} does not run on ${PROVIDER_LABELS[host]}; use ${names.join(" or ")}`
          : `${stack.name} has no delivery that runs on ${PROVIDER_LABELS[host]}`
      );
      return;
    }
    const args: TfArguments = {
      ...stored,
      delivery: delivery.slug,
      ...(host === "gitlab" ? { gitlab_project: project.destRepo } : {}),
    };
    const rendered = renderStack(stack, args);

    const token = await getGitToken(project.orgId, host, project.gitConnectionId);
    if (!token) {
      await setStage(
        jobId,
        "repo",
        "errored",
        `no ${PROVIDER_LABELS[host]} connection for this org: add one under Connections`
      );
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
      await setStage(jobId, "repo", "running");
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
    await setStage(jobId, "commit", "running");
    const repo = project.destRepo;
    const prefix = project.destPath ? `${project.destPath.replace(/^\/+|\/+$/g, "")}/` : "";

    // A change request from an earlier run that is still open gets this
    // run's commit, so the customer reviews one per project, not per click.
    const openCr = await client.findOpenChangeRequest({
      repo,
      base: destBranch,
      isMine: (ref) => isStackBranch(project.name, ref),
    });

    // A seed file is the customer's once it exists anywhere they might have
    // edited it: the default branch, or the open request's branch this commit
    // lands on.
    const seedBranches = openCr ? [destBranch, openCr.branch] : [destBranch];
    const files: HostFile[] = [];
    let seedsKept = 0;
    for (const f of rendered) {
      let exists = false;
      if (f.ownership === "seed") {
        for (const b of seedBranches) {
          if (await client.fileExists({ repo, path: `${prefix}${f.path}`, branch: b })) {
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
        create: {
          projectId: project.id,
          fileName: f.fileName,
          argumentsJson: args,
          renderedBody: f.content,
        },
        update: { argumentsJson: args, renderedBody: f.content },
      });
    }
    await prisma.tfJob.update({
      where: { id: jobId },
      data: { fileCount: files.length },
    });

    const branch = openCr?.branch ?? stackBranchName(project.name, jobId);
    if (!openCr) {
      await client.createBranch({ repo, from: destBranch, branch });
      createdBranch = branch;
    }
    const result = await client.commitFiles({
      repo,
      branch,
      workDir: project.destPath,
      files,
      message:
        `infralift: ${stack.slug} for ${project.name}\n\n` +
        `Rendered from stack ${stack.slug} (source ${stack.source.repo}@${stack.source.commit.slice(0, 7)}).`,
    });
    if (result.noop) {
      // Nothing new. A fresh branch would make an empty request, so it goes;
      // an existing request already carries these files and stays as it is.
      if (createdBranch) {
        await client.deleteBranch({ repo, branch });
        createdBranch = null;
      }
      await setStage(
        jobId,
        "complete",
        "success",
        openCr
          ? `${createdRepoNote}already up to date in ${openCr.url}`
          : `${createdRepoNote}${files.length} files already up to date; no ${noun}`
      );
      return;
    }
    const cr = openCr ?? await client.openChangeRequest({
      repo,
      head: branch,
      base: destBranch,
      title: `infralift: ${stack.name} for ${project.name}`,
      body: [
        `Rendered by infralift from the \`${stack.slug}\` stack.`,
        "",
        `- ${files.length} files written; files under \`deploy/infra/generated/\` and the CI files are managed by infralift and rewritten on every change.`,
        seedsKept
          ? `- ${seedsKept} file(s) you own (such as \`deploy/infra/overrides.tf\`) already existed and were left alone.`
          : "- `deploy/infra/overrides.tf` is yours from here on; infralift never rewrites it.",
        "",
        "See `deploy/README.md` for the credentials and first apply.",
      ].join("\n"),
    });
    createdBranch = null; // the change request owns the branch now
    await prisma.tfJob.update({
      where: { id: jobId },
      data: { commitSha: result.commitSha, prUrl: cr.url },
    });
    await prisma.tfRendering.updateMany({
      where: { projectId: project.id, fileName: { in: files.map((f) => f.fileName) } },
      data: { commitSha: result.commitSha },
    });

    // -- workspace ---------------------------------------------------------
    // Only a Terraform Cloud backend has a workspace to create. It tracks the
    // default branch, so it plans the change once the request is merged.
    await setStage(jobId, "workspace", "running");
    let workspaceNote = "state in R2; no workspace";
    if (args.backend === "tfc") {
      const workspaceName = String(args.tfc_workspace ?? args.name);
      const adapter = getWorkspaceAdapter();
      await adapter.createWorkspace({
        workspaceName,
        repo,
        branch: destBranch,
        workingDirectory: `${prefix}deploy/infra`,
        autoApply: false,
      });
      await prisma.tfJob.update({ where: { id: jobId }, data: { workspaceName } });
      workspaceNote = `workspace ${workspaceName}`;
    }

    // -- complete ----------------------------------------------------------
    await setStage(
      jobId,
      "complete",
      "success",
      `${createdRepoNote}${openCr ? "updated" : "opened"} ${cr.url} (${files.length} files); ${workspaceNote}`
    );
  } catch (err) {
    if (createdBranch && client) {
      await client.deleteBranch({ repo: project.destRepo, branch: createdBranch }).catch(() => {});
    }
    const msg = err instanceof Error ? err.message : String(err);
    const current = await prisma.tfJob.findUnique({
      where: { id: jobId },
      select: { stage: true },
    });
    await setStage(jobId, current?.stage ?? "render", "errored", msg);
  }
}

// ---------------------------------------------------------------------------
// Import jobs: scan -> read-only plan check -> pull request
// ---------------------------------------------------------------------------

/** Adds the import check for an existing root module to the customer's
 *  repository as a pull request. Nothing in their Terraform is changed: the
 *  only file is the workflow, and it plans without applying or locking. */
async function runImportJob(jobId: string, job: CodegenJob): Promise<void> {
  const project = job.project;
  let client: GitHostClient | null = null;
  let createdBranch: string | null = null;
  try {
    await setStage(jobId, "render", "running");
    const root = project.importJson as unknown as RootModule | null;
    if (!root || project.gitHost !== "github") {
      await setStage(jobId, "render", "errored", "import needs a scanned module in a GitHub repository");
      return;
    }
    const args = (job.argumentsJson ?? {}) as { backendConfigFile?: string | null };
    const check = renderImportCheck(root, { backendConfigFile: args.backendConfigFile ?? null });

    const token = await getGitToken(project.orgId, "github", project.gitConnectionId);
    if (!token) {
      await setStage(jobId, "commit", "errored", "no GitHub connection for this org: add one under Connections");
      return;
    }
    client = gitHostClient("github", token);

    await setStage(jobId, "commit", "running");
    const repo = project.destRepo;
    const openCr = await client.findOpenChangeRequest({
      repo,
      base: project.destBranch,
      isMine: (ref) => isStackBranch(project.name, ref),
    });
    await prisma.tfRendering.upsert({
      where: { projectId_fileName: { projectId: project.id, fileName: check.path } },
      create: { projectId: project.id, fileName: check.path, argumentsJson: args, renderedBody: check.content },
      update: { argumentsJson: args, renderedBody: check.content },
    });
    await prisma.tfJob.update({ where: { id: jobId }, data: { fileCount: 1 } });

    const branch = openCr?.branch ?? stackBranchName(project.name, jobId);
    if (!openCr) {
      await client.createBranch({ repo, from: project.destBranch, branch });
      createdBranch = branch;
    }
    const label = root.path || "the repository root";
    const result = await client.commitFiles({
      repo,
      branch,
      workDir: "",
      files: [{ fileName: check.path, content: check.content }],
      message: `infralift: import check for ${label}\n\nRead-only plan against the existing state; applies nothing.`,
    });
    if (result.noop) {
      if (createdBranch) {
        await client.deleteBranch({ repo, branch });
        createdBranch = null;
      }
      await setStage(
        jobId,
        "complete",
        "success",
        openCr ? `already up to date in ${openCr.url}` : "the import check is already in the repository"
      );
      return;
    }
    const env = checkEnv(root);
    const cr =
      openCr ??
      (await client.openChangeRequest({
        repo,
        head: branch,
        base: project.destBranch,
        title: `infralift: import check for ${label}`,
        body: [
          `infralift is importing the Terraform in \`${label}\` (${root.resources} resources, state in ${root.backend.kind}).`,
          "",
          "This pull request adds one file, a workflow that runs a **read-only** plan against the existing state. It applies nothing and runs with `-lock=false`, so it cannot change your infrastructure or block your own pipeline. infralift never sees your state or your credentials: the plan runs here, with your secrets.",
          "",
          "The import is safe to finish when the check passes, which means the plan changes nothing: the code already matches what is running, so taking it over cannot cause downtime. If it fails, the job summary lists each resource that would change.",
          "",
          env.length
            ? `Add these repository secrets before the check can run (Settings, Secrets and variables, Actions):\n\n${env.map((e) => `- \`${e.secret}\``).join("\n")}`
            : "The check needs no secrets.",
          ...(root.notes.length ? ["", "Notes from the scan:", "", ...root.notes.map((n) => `- ${n}`)] : []),
        ].join("\n"),
      }));
    createdBranch = null;
    await prisma.tfJob.update({ where: { id: jobId }, data: { commitSha: result.commitSha, prUrl: cr.url } });
    await setStage(
      jobId,
      "complete",
      "success",
      `${openCr ? "updated" : "opened"} ${cr.url}; ${env.length ? `add ${env.length} secret(s), then ` : ""}the check plans read-only`
    );
  } catch (err) {
    if (createdBranch && client) {
      await client.deleteBranch({ repo: project.destRepo, branch: createdBranch }).catch(() => {});
    }
    const msg = err instanceof Error ? err.message : String(err);
    const current = await prisma.tfJob.findUnique({ where: { id: jobId }, select: { stage: true } });
    await setStage(jobId, current?.stage ?? "render", "errored", msg);
  }
}
