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
import { commitFile } from "./git.js";
import { getWorkspaceAdapter } from "./workspace.js";

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
    orderBy: { createdAt: "desc" },
  });
  return conn ? decryptToken(conn.encryptedToken) : null;
}

export async function runJob(jobId: string): Promise<void> {
  const job = await prisma.tfJob.findUniqueOrThrow({
    where: { id: jobId },
    include: {
      project: { include: { templateVersion: { include: { template: true } } } },
    },
  });
  const project = job.project;
  const version = project.templateVersion;
  const args = job.argumentsJson as TfArguments;

  try {
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
      await setStage(
        jobId,
        "commit",
        "errored",
        "no github connection for org — add one under /connections with provider \"github\""
      );
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
