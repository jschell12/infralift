import { Prisma } from "@prisma/client";
import { prisma } from "../lib/db.js";
import { InvalidInput, NotFound } from "../lib/errors.js";
import { startJob } from "../lib/jobs/start.js";
import type { TfArguments } from "../lib/tf/render.js";

// Jobs a person starts by hand, and reading jobs back. Every query is scoped
// through the project to the caller's org.

/** Queues a job for a project. A stack project re-renders from its stored
 *  settings; ad-hoc arguments would let a job disagree with what the project
 *  says it is. */
export async function queueProjectJob(orgId: string, projectId: string, args: TfArguments) {
  const project = await prisma.tfProject.findFirst({ where: { id: projectId, orgId } });
  if (!project) throw new NotFound("project not found");
  const isStack = project.source === "stack";
  const job = await prisma.tfJob.create({
    data: {
      projectId: project.id,
      kind: isStack ? "stack" : "template",
      argumentsJson: isStack ? (project.providerConfig as Prisma.InputJsonObject) : args,
    },
  });
  startJob(job.id);
  return job;
}

export async function listJobs(orgId: string, projectId: string) {
  if (!projectId) throw new InvalidInput("projectId required");
  return prisma.tfJob.findMany({
    where: { projectId, project: { orgId } },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
}

export async function getJob(orgId: string, jobId: string) {
  const job = await prisma.tfJob.findFirst({
    where: { id: jobId, project: { orgId } },
    include: { rendering: true },
  });
  if (!job) throw new NotFound("job not found");
  return job;
}
