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
import {
  commitFile,
  commitFiles,
  createBranch,
  deleteBranch,
  ensureRepo,
  fileExists,
  findOpenPullRequest,
  openPullRequest,
} from "./git.js";
import { getStack, renderStack } from "../stacks/index.js";
import { getWorkspaceAdapter } from "./workspace.js";
import { generateHcl } from "./codegen.js";
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

/** Renders a stack into the customer's app repository as a pull request.
 *
 * Unlike codegen, the destination is a repository the customer works in, so
 * nothing is pushed to destBranch: the files arrive on a branch of their own
 * and the customer merges them. Seed files (overrides.tf) are left out when
 * the repository already has them, which is what makes them the customer's.
 */
async function runStackJob(jobId: string, job: CodegenJob): Promise<void> {
  const project = job.project;
  // Set once this job has created a branch of its own, so a failure before
  // the PR exists can remove it rather than leave debris in the customer's
  // repository.
  let createdBranch: { token: string; branch: string } | null = null;
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
    const args = (job.argumentsJson ?? {}) as TfArguments;
    const rendered = renderStack(stack, args);

    // -- commit ------------------------------------------------------------
    await setStage(jobId, "commit", "running");
    const token = await getGithubToken(project.orgId);
    if (!token) {
      await setStage(jobId, "commit", "errored", NO_GITHUB);
      return;
    }
    const prefix = project.destPath ? `${project.destPath.replace(/^\/+|\/+$/g, "")}/` : "";
    const files = [];
    let seedsKept = 0;
    for (const f of rendered) {
      if (
        f.ownership === "seed" &&
        (await fileExists({
          token,
          repo: project.destRepo,
          path: `${prefix}${f.path}`,
          branch: project.destBranch,
        }))
      ) {
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

    // A PR from an earlier run that is still open gets this run's commit, so
    // the customer reviews one PR per project rather than one per click.
    const openPr = await findOpenPullRequest({
      token,
      repo: project.destRepo,
      base: project.destBranch,
      headPrefix: stackBranchPrefix(project.name),
    });
    const branch = openPr?.branch ?? stackBranchName(project.name, jobId);
    if (!openPr) {
      await createBranch({
        token,
        repo: project.destRepo,
        from: project.destBranch,
        branch,
      });
      createdBranch = { token, branch };
    }
    const result = await commitFiles({
      token,
      repo: project.destRepo,
      branch,
      workDir: project.destPath,
      files,
      message:
        `infralift: ${stack.slug} for ${project.name}\n\n` +
        `Rendered from stack ${stack.slug} (source ${stack.source.repo}@${stack.source.commit.slice(0, 7)}).`,
    });
    if (result.noop) {
      // Nothing new. A fresh branch would make an empty PR, so it goes; an
      // existing PR already carries these files and stays as it is.
      if (createdBranch) {
        await deleteBranch({ token, repo: project.destRepo, branch });
        createdBranch = null;
      }
      await setStage(
        jobId,
        "complete",
        "success",
        openPr
          ? `already up to date in ${openPr.url}`
          : `${files.length} files already up to date; no pull request`
      );
      return;
    }
    const pr = openPr ?? await openPullRequest({
      token,
      repo: project.destRepo,
      head: branch,
      base: project.destBranch,
      title: `infralift: ${stack.name} for ${project.name}`,
      body: [
        `Rendered by infralift from the \`${stack.slug}\` stack.`,
        "",
        `- ${files.length} files written; files under \`deploy/infra/generated/\` and the workflows are managed by infralift and rewritten on every change.`,
        seedsKept
          ? `- ${seedsKept} file(s) you own (such as \`deploy/infra/overrides.tf\`) already existed and were left alone.`
          : "- `deploy/infra/overrides.tf` is yours from here on; infralift never rewrites it.",
        "",
        "See `deploy/README.md` for the credentials and first apply.",
      ].join("\n"),
    });
    createdBranch = null; // the PR owns the branch now
    await prisma.tfJob.update({
      where: { id: jobId },
      data: { commitSha: result.commitSha, prUrl: pr.url },
    });
    await prisma.tfRendering.updateMany({
      where: { projectId: project.id, fileName: { in: files.map((f) => f.fileName) } },
      data: { commitSha: result.commitSha },
    });

    // -- workspace ---------------------------------------------------------
    // Only a Terraform Cloud backend has a workspace to create. It tracks
    // destBranch, so it plans the change once the customer merges the PR.
    await setStage(jobId, "workspace", "running");
    let workspaceNote = "state in R2; no workspace";
    if (args.backend === "tfc") {
      const workspaceName = String(args.tfc_workspace ?? args.name);
      const adapter = getWorkspaceAdapter();
      await adapter.createWorkspace({
        workspaceName,
        repo: project.destRepo,
        branch: project.destBranch,
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
      `${openPr ? "updated" : "opened"} ${pr.url} (${files.length} files); ${workspaceNote}`
    );
  } catch (err) {
    if (createdBranch) {
      await deleteBranch({
        token: createdBranch.token,
        repo: project.destRepo,
        branch: createdBranch.branch,
      }).catch(() => {});
    }
    const msg = err instanceof Error ? err.message : String(err);
    const current = await prisma.tfJob.findUnique({
      where: { id: jobId },
      select: { stage: true },
    });
    await setStage(jobId, current?.stage ?? "render", "errored", msg);
  }
}
