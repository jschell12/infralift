import type { Provider, ResourceInventoryItem } from "@infralift/shared";
import { prisma } from "../lib/db.js";
import { toInventoryItem } from "../lib/inventory.js";
import { isAdmin } from "../lib/cf-auth.js";
import { createRateLimiter } from "../lib/rate-limit.js";
import { Conflict, InvalidInput, NotFound, TooManyRequests } from "../lib/errors.js";
import { insertJob } from "../lib/jobs/enqueue.js";
import { startJob } from "../lib/jobs/start.js";
import { isUniqueViolation } from "../lib/prisma-errors.js";
import { generateHcl, type CodegenOptions } from "../lib/tf/codegen.js";
import { toCodegenSample } from "../lib/tf/sample.js";

// ---------------------------------------------------------------------------
// Codegen: Terraform generated from an assessment, and the approval that
// turns it into a repository and a job.
//
// The assessment, the cost comparison and the ranked targets are free.
// Applyable Terraform is the deliverable: callers get the full files only if
// they are an admin or their org has been unlocked, and a sample otherwise.
// Locked or not, generation is metered per org.
// ---------------------------------------------------------------------------

export interface Caller {
  orgId: string;
  email: string;
}

/** Full output for admins and for orgs an admin has cleared. */
async function codegenUnlocked(caller: Caller): Promise<boolean> {
  if (isAdmin(caller.email)) return true;
  const org = await prisma.org.findUnique({ where: { id: caller.orgId }, select: { codegenUnlocked: true } });
  return org?.codegenUnlocked ?? false;
}

// Codegen is the most expensive thing an anonymous signup can make us do, and
// the preview renders HCL from an inventory typed by hand, so without a limit
// it is a free codegen service for anyone who can complete a login.
// Sliding-window limiter per org (lib/rate-limit.ts), in-process: a second
// replica means a second bucket, an acceptable ceiling for a CPU-bound render.
const codegenLimiter = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 20 });

function meter(orgId: string, now = Date.now()): void {
  if (codegenLimiter.limited(orgId, now)) {
    throw new TooManyRequests("Too many codegen requests. Try again later.");
  }
}

/** For tests. */
export function resetCodegenRateLimit(): void {
  codegenLimiter.reset();
}

/** The whole files when unlocked, a sample otherwise. */
async function gated(caller: Caller, files: ReturnType<typeof generateHcl>, resourceCount: number) {
  if (await codegenUnlocked(caller)) return { locked: false, files, resourceCount };
  return { ...toCodegenSample(files), resourceCount };
}

// -- unlock ---------------------------------------------------------------------

/** Admin-only (the route checks). The moment a prospect becomes a customer, so
 *  it is a call that leaves a log line rather than a manual UPDATE; a payment
 *  webhook can make the same call. */
export async function setCodegenUnlock(adminEmail: string, input: { orgId: string; unlocked: boolean }) {
  const org = await prisma.org.update({
    where: { id: input.orgId },
    data: { codegenUnlocked: input.unlocked },
    select: { id: true, name: true, codegenUnlocked: true },
  });
  console.log(`codegen ${org.codegenUnlocked ? "unlocked" : "locked"} for org ${org.id} (${org.name}) by ${adminEmail}`);
  return org;
}

// -- generate -----------------------------------------------------------------------

export interface CodegenInput {
  assessmentId: string;
  backend: "tfc" | "s3" | "local";
  tfcOrg?: string;
  s3Bucket?: string;
  s3Endpoint?: string;
  projectName?: string;
  migrationTarget: "cloudflare" | "hetzner" | null;
}

export async function generateFromAssessment(caller: Caller, input: CodegenInput) {
  const { assessmentId, ...opts } = input;
  const assessment = await prisma.assessment.findUnique({ where: { id: assessmentId }, include: { inventory: true } });
  if (!assessment || assessment.orgId !== caller.orgId) throw new NotFound("assessment not found");
  if (assessment.status !== "completed") throw new InvalidInput("assessment not completed");
  meter(caller.orgId);
  const inventory: ResourceInventoryItem[] = assessment.inventory.map(toInventoryItem);
  const files = generateHcl({ provider: assessment.provider as Provider, inventory, ...opts } as CodegenOptions);
  return gated(caller, files, inventory.length);
}

export interface PreviewInput {
  provider: string;
  inventory: ResourceInventoryItem[];
  backend: "tfc" | "s3" | "local";
  migrationTarget: "cloudflare" | "hetzner" | null;
}

/** Codegen from an inventory the caller supplies. Gated identically to
 *  generateFromAssessment: leaving it open would make that gate decorative. */
export async function generatePreview(caller: Caller, input: PreviewInput) {
  meter(caller.orgId);
  const files = generateHcl({
    provider: input.provider as Provider,
    inventory: input.inventory,
    backend: input.backend,
    migrationTarget: input.migrationTarget,
  });
  return gated(caller, files, input.inventory.length);
}

// -- approve ------------------------------------------------------------------------

export interface ApproveInput {
  assessmentId: string;
  migrationTarget: "cloudflare" | "hetzner";
  /** owner/name. Created if it does not exist. */
  repo: string;
  destPath: string;
  destBranch: string;
  projectName?: string;
  backend: "tfc" | "s3" | "local";
  tfcOrg?: string;
  s3Bucket?: string;
  s3Endpoint?: string;
}

/**
 * The approval step of the funnel: the customer has picked a target, so the
 * assessment becomes a repository of Terraform and a job to write it.
 *
 * Re-approving the same assessment and target reuses the codegen project and
 * adds a job, so the repository converges rather than forking into a second
 * project. A same-named project of any other kind is a conflict, and so is
 * re-approving while that project's last job is still running.
 */
export async function approveMigration(orgId: string, input: ApproveInput) {
  const assessment = await prisma.assessment.findFirst({
    where: { id: input.assessmentId, orgId },
    select: { id: true, provider: true, status: true },
  });
  if (!assessment) throw new NotFound("assessment not found");
  if (assessment.status !== "completed") throw new InvalidInput("Assessment not completed");

  const name = input.projectName ?? `${assessment.provider}-to-${input.migrationTarget}-${assessment.id.slice(-6)}`;
  const existing = await prisma.tfProject.findFirst({ where: { orgId, name } });
  if (existing && (existing.source !== "codegen" || existing.assessmentId !== assessment.id)) {
    throw new Conflict(
      existing.source !== "codegen"
        ? `project "${name}" already exists as a ${existing.source} project`
        : `project "${name}" already exists for a different assessment`
    );
  }
  const jobArguments = {
    backend: input.backend,
    ...(input.tfcOrg ? { tfcOrg: input.tfcOrg } : {}),
    ...(input.s3Bucket ? { s3Bucket: input.s3Bucket } : {}),
    ...(input.s3Endpoint ? { s3Endpoint: input.s3Endpoint } : {}),
  };
  // The project change and the job are one transaction: a re-approval refused
  // because a job is already running leaves the project as it was.
  let result;
  try {
    result = await prisma.$transaction(async (tx) => {
      const project = existing
        ? await tx.tfProject.update({
            where: { id: existing.id },
            data: {
              destRepo: input.repo,
              destPath: input.destPath,
              destBranch: input.destBranch,
              migrationTarget: input.migrationTarget,
            },
          })
        : await tx.tfProject.create({
            data: {
              orgId,
              name,
              source: "codegen",
              assessmentId: assessment.id,
              migrationTarget: input.migrationTarget,
              destRepo: input.repo,
              destPath: input.destPath,
              destBranch: input.destBranch,
              // Codegen writes its own versions.tf and provider.tf, so this is
              // recorded for reference rather than used to render a provider file.
              providerConfig: { name: input.migrationTarget, target: input.migrationTarget, source: assessment.provider },
            },
          });
      const job = await insertJob({ projectId: project.id, kind: "codegen", argumentsJson: jobArguments }, tx);
      return { project, job };
    });
  } catch (err) {
    // Two approvals at once both found no project above and both tried to
    // create it; the second hit the (orgId, name) unique key.
    if (isUniqueViolation(err)) throw new Conflict(`project "${name}" was just created by another request; reload and try again`);
    throw err;
  }
  startJob(result.job.id);
  return result;
}
