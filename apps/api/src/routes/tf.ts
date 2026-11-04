import { Router } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import type { Provider, ResourceInventoryItem } from "@infralift/shared";
import { prisma } from "../lib/db.js";
import { runJob } from "../lib/tf/pipeline.js";
import {
  renderTemplate,
  validateArguments,
  TfInputValidationError,
  type TfArguments,
} from "../lib/tf/render.js";
import { getTfcClient } from "../lib/tf/tfc-client.js";
import { generateHcl, type CodegenOptions } from "../lib/tf/codegen.js";
import { requireAdmin, isAdmin } from "../lib/cf-auth.js";
import { toCodegenSample } from "../lib/tf/sample.js";
import { getStack, listStacks, renderStack, resolveStackInputs } from "../lib/stacks/index.js";

export const tfRouter = Router();

// -- TFC connection status ---------------------------------------------------

// Admin-only: this reports on infralift's own HCP Terraform org, not on
// anything belonging to the caller, so the org name and workspace count are
// internal detail rather than a customer's own data.
tfRouter.get("/tfc-status", requireAdmin, async (_req, res) => {
  const client = getTfcClient();
  if (!client) {
    return res.json({ connected: false, org: null, workspaceCount: null });
  }
  try {
    const workspaces = await client.listWorkspaces();
    res.json({
      connected: true,
      org: process.env.TFC_ORG ?? null,
      workspaceCount: workspaces.length,
    });
  } catch {
    // Token set but invalid or network failure
    res.json({
      connected: false,
      org: process.env.TFC_ORG ?? null,
      workspaceCount: null,
    });
  }
});

// -- templates ---------------------------------------------------------------

// The shared catalog (orgId null) plus the caller's own private templates.
// An adopted workspace's template points at that customer's repository, so
// every lookup by slug goes through this filter, not just the listing.
export function visibleTemplates(orgId: string) {
  return { OR: [{ orgId: null }, { orgId }] };
}

tfRouter.get("/templates", async (req, res) => {
  const templates = await prisma.tfTemplate.findMany({
    where: visibleTemplates(req.user!.orgId),
    include: {
      versions: {
        select: { id: true, releaseTag: true, inputSchema: true, createdAt: true },
        orderBy: { createdAt: "desc" },
      },
    },
    orderBy: { slug: "asc" },
  });
  res.json(templates);
});

const templateSchema = z.object({
  slug: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(1),
  description: z.string().default(""),
  releaseTag: z.string().min(1),
  templateBody: z.string().min(1),
  inputSchema: z.record(z.string(), z.unknown()),
});

// Admin-only. TfTemplate has no orgId: it is one catalog shared by every org,
// keyed on slug, and templateBody is Terraform that the pipeline renders,
// commits to a repo and hands to a workspace. An unauthenticated-shaped write
// here was fine while the only account was the owner's; with signup open it
// would let anyone who can sign in with GitHub upsert a template other orgs
// build from. The GET below stays open because reading the catalog is what
// the dashboard's terraform page does.
tfRouter.post("/templates", requireAdmin, async (req, res) => {
  const parsed = templateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const { slug, name, description, releaseTag, templateBody, inputSchema } =
    parsed.data;
  const existing = await prisma.tfTemplate.findUnique({ where: { slug } });
  if (existing?.orgId) {
    return res.status(409).json({ error: "slug belongs to an org-private template" });
  }
  const template = await prisma.tfTemplate.upsert({
    where: { slug },
    create: { slug, name, description },
    update: { name, description },
  });
  const version = await prisma.tfTemplateVersion.create({
    data: {
      templateId: template.id,
      releaseTag,
      templateBody,
      inputSchema: inputSchema as object,
    },
  });
  res.status(201).json({ template, version });
});

// Dry-run render: validate arguments + return the rendered body without
// touching git or workspaces.
const previewSchema = z.object({
  arguments: z.record(
    z.string(),
    z.union([z.string(), z.number(), z.boolean()])
  ),
});

tfRouter.post("/templates/:slug/versions/:tag/preview", async (req, res) => {
  const parsed = previewSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const template = await prisma.tfTemplate.findFirst({
    where: { slug: req.params.slug, ...visibleTemplates(req.user!.orgId) },
  });
  if (!template) return res.status(404).json({ error: "template not found" });
  const version = await prisma.tfTemplateVersion.findUnique({
    where: {
      templateId_releaseTag: {
        templateId: template.id,
        releaseTag: req.params.tag,
      },
    },
  });
  if (!version) return res.status(404).json({ error: "version not found" });
  try {
    const args = parsed.data.arguments as TfArguments;
    validateArguments(version.inputSchema as object, args);
    res.json({ rendered: renderTemplate(version.templateBody, args) });
  } catch (err) {
    if (err instanceof TfInputValidationError) {
      return res.status(422).json({ error: err.details });
    }
    throw err;
  }
});

// -- projects ----------------------------------------------------------------

tfRouter.get("/projects", async (req, res) => {
  const { orgId } = req.user!;
  const projects = await prisma.tfProject.findMany({
    where: { orgId },
    include: {
      templateVersion: {
        select: { releaseTag: true, template: { select: { slug: true } } },
      },
      renderings: {
        select: { id: true, fileName: true, commitSha: true, createdAt: true },
        orderBy: { createdAt: "desc" },
      },
    },
    orderBy: { name: "asc" },
  });
  res.json(projects);
});

const projectSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(32)
    .regex(/^[a-z0-9-]+$/),
  templateSlug: z.string().min(1),
  releaseTag: z.string().min(1),
  destRepo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  destPath: z.string().default(""),
  destBranch: z.string().default("main"),
  providerConfig: z.object({
    name: z.string().min(1),
    source: z.string().min(1),
    version: z.string().min(1),
    region: z.string().optional(),
  }),
});

tfRouter.post("/projects", async (req, res) => {
  const parsed = projectSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const { orgId } = req.user!;
  const d = parsed.data;
  const template = await prisma.tfTemplate.findFirst({
    where: { slug: d.templateSlug, ...visibleTemplates(orgId) },
  });
  if (!template) return res.status(404).json({ error: "template not found" });
  const version = await prisma.tfTemplateVersion.findUnique({
    where: {
      templateId_releaseTag: {
        templateId: template.id,
        releaseTag: d.releaseTag,
      },
    },
  });
  if (!version) return res.status(404).json({ error: "version not found" });
  const project = await prisma.tfProject.create({
    data: {
      orgId,
      name: d.name,
      templateVersionId: version.id,
      destRepo: d.destRepo,
      destPath: d.destPath,
      destBranch: d.destBranch,
      providerConfig: d.providerConfig,
    },
  });
  res.status(201).json(project);
});

tfRouter.get("/projects/:id/renderings", async (req, res) => {
  // Scope by org: a project id is guessable, and its renderings carry the
  // customer's infrastructure.
  const project = await prisma.tfProject.findFirst({
    where: { id: req.params.id, orgId: req.user!.orgId },
    select: { id: true },
  });
  if (!project) return res.status(404).json({ error: "project not found" });
  const renderings = await prisma.tfRendering.findMany({
    where: { projectId: project.id },
    orderBy: { createdAt: "desc" },
  });
  res.json(renderings);
});

// -- jobs --------------------------------------------------------------------

const jobSchema = z.object({
  projectId: z.string().min(1),
  arguments: z.record(
    z.string(),
    z.union([z.string(), z.number(), z.boolean()])
  ),
});

tfRouter.post("/jobs", async (req, res) => {
  const parsed = jobSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const project = await prisma.tfProject.findFirst({
    where: { id: parsed.data.projectId, orgId: req.user!.orgId },
  });
  if (!project) return res.status(404).json({ error: "project not found" });
  // A stack project re-renders from its stored settings; ad-hoc arguments
  // would let a job disagree with what the project says it is.
  const isStack = project.source === "stack";
  const job = await prisma.tfJob.create({
    data: {
      projectId: project.id,
      kind: isStack ? "stack" : "template",
      argumentsJson: isStack
        ? (project.providerConfig as Prisma.InputJsonObject)
        : parsed.data.arguments,
    },
  });
  // Fire-and-forget: the staged pipeline updates stage/status as it goes.
  void runJob(job.id).catch((err) => {
    console.error(`tf job ${job.id} failed:`, err);
  });
  res.status(202).json(job);
});

tfRouter.get("/jobs", async (req, res) => {
  const projectId = String(req.query.projectId ?? "");
  if (!projectId) return res.status(400).json({ error: "projectId required" });
  const jobs = await prisma.tfJob.findMany({
    where: { projectId, project: { orgId: req.user!.orgId } },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  res.json(jobs);
});

tfRouter.get("/jobs/:id", async (req, res) => {
  const job = await prisma.tfJob.findFirst({
    where: { id: req.params.id, project: { orgId: req.user!.orgId } },
    include: { rendering: true },
  });
  if (!job) return res.status(404).json({ error: "job not found" });
  res.json(job);
});

// -- codegen: assessment to HCL -----------------------------------------------

const codegenSchema = z.object({
  assessmentId: z.string().min(1),
  backend: z.enum(["tfc", "s3", "local"]).default("local"),
  tfcOrg: z.string().optional(),
  s3Bucket: z.string().optional(),
  s3Endpoint: z.string().optional(),
  projectName: z.string().optional(),
  migrationTarget: z.enum(["cloudflare", "hetzner"]).nullable().default(null),
});

// ---------------------------------------------------------------------------
// Codegen gate
// ---------------------------------------------------------------------------
//
// The assessment, the cost comparison and the ranked targets are free and
// should stay free. Applyable Terraform is the deliverable, and until the
// unlock below it was returned to any signed-in user. Owner-only Access made
// that harmless; self-serve signup did not.

/** Full output for admins and for orgs an admin has cleared. */
async function codegenUnlocked(req: {
  user?: { orgId: string; email: string };
}): Promise<boolean> {
  if (isAdmin(req.user?.email)) return true;
  const org = await prisma.org.findUnique({
    where: { id: req.user!.orgId },
    select: { codegenUnlocked: true },
  });
  return org?.codegenUnlocked ?? false;
}

// Locked callers are metered too. Codegen is the most expensive thing an
// anonymous signup can make us do, and /codegen/preview will render HCL from
// an inventory typed by hand, so without this it is a free codegen service
// for anyone who can complete a Google login. In-process like the intake
// limiter: a second replica means a second bucket, which is an acceptable
// ceiling for a CPU-bound render.
const CODEGEN_WINDOW_MS = 60 * 60 * 1000;
const CODEGEN_MAX_PER_HOUR = 20;
const codegenHits = new Map<string, number[]>();

function codegenRateLimited(orgId: string, now = Date.now()): boolean {
  const recent = (codegenHits.get(orgId) ?? []).filter(
    (t) => now - t < CODEGEN_WINDOW_MS
  );
  if (recent.length >= CODEGEN_MAX_PER_HOUR) {
    codegenHits.set(orgId, recent);
    return true;
  }
  recent.push(now);
  codegenHits.set(orgId, recent);
  if (codegenHits.size > 5000) {
    for (const [k, times] of codegenHits) {
      const live = times.filter((t) => now - t < CODEGEN_WINDOW_MS);
      if (live.length === 0) codegenHits.delete(k);
      else codegenHits.set(k, live);
    }
  }
  return false;
}

/** Exported for tests. */
export function resetCodegenRateLimit(): void {
  codegenHits.clear();
}

// Flip the unlock. Admin-only, and deliberately a route rather than a manual
// UPDATE: unlocking is the moment a prospect becomes a customer, so it should
// be something the admin app can do and something that leaves a log line,
// not something typed into psql. A payment webhook can call the same path.
const unlockSchema = z.object({
  orgId: z.string().min(1),
  unlocked: z.boolean(),
});

tfRouter.post("/unlock", requireAdmin, async (req, res) => {
  const parsed = unlockSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const org = await prisma.org.update({
    where: { id: parsed.data.orgId },
    data: { codegenUnlocked: parsed.data.unlocked },
    select: { id: true, name: true, codegenUnlocked: true },
  });
  console.log(
    `codegen ${org.codegenUnlocked ? "unlocked" : "locked"} for org ${org.id} (${org.name}) by ${req.user!.email}`
  );
  res.json(org);
});

tfRouter.post("/codegen", async (req, res) => {
  const parsed = codegenSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const { orgId } = req.user!;
  const { assessmentId, ...opts } = parsed.data;

  const assessment = await prisma.assessment.findUnique({
    where: { id: assessmentId },
    include: { inventory: true },
  });
  if (!assessment || assessment.orgId !== orgId) {
    return res.status(404).json({ error: "assessment not found" });
  }
  if (assessment.status !== "completed") {
    return res.status(400).json({ error: "assessment not completed" });
  }
  if (codegenRateLimited(orgId)) {
    return res
      .status(429)
      .json({ error: "Too many codegen requests. Try again later." });
  }

  const inventory: ResourceInventoryItem[] = assessment.inventory.map((i) => ({
    provider: i.provider as Provider,
    type: i.type,
    externalId: i.externalId,
    name: i.name,
    region: i.region ?? undefined,
    monthlyCostCents: i.monthlyCostCents ?? undefined,
    metadata: (i.metadata as Record<string, unknown>) ?? undefined,
  }));

  const files = generateHcl({
    provider: assessment.provider as Provider,
    inventory,
    ...opts,
  } as CodegenOptions);

  if (await codegenUnlocked(req)) {
    return res.json({ locked: false, files, resourceCount: inventory.length });
  }
  res.json({ ...toCodegenSample(files), resourceCount: inventory.length });
});

// Preview: generate HCL without an assessment (from provided inventory)
tfRouter.post("/codegen/preview", async (req, res) => {
  const schema = z.object({
    provider: z.string().min(1),
    // Bounded: this array is caller-supplied and every entry is rendered,
    // so an unbounded one is a CPU amplifier behind a free signup.
    inventory: z.array(z.object({
      provider: z.string(),
      type: z.string(),
      externalId: z.string(),
      name: z.string(),
      region: z.string().optional(),
      monthlyCostCents: z.number().optional(),
      metadata: z.record(z.unknown()).optional(),
    })).max(1000),
    backend: z.enum(["tfc", "s3", "local"]).default("local"),
    migrationTarget: z.enum(["cloudflare", "hetzner"]).nullable().default(null),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  if (codegenRateLimited(req.user!.orgId)) {
    return res
      .status(429)
      .json({ error: "Too many codegen requests. Try again later." });
  }

  const files = generateHcl({
    provider: parsed.data.provider as Provider,
    inventory: parsed.data.inventory as ResourceInventoryItem[],
    backend: parsed.data.backend,
    migrationTarget: parsed.data.migrationTarget,
  });

  // Gated identically to /codegen. This route takes an inventory rather than
  // an assessment id, so leaving it open would have made the gate above
  // decorative: paste your own inventory, get the same files.
  if (await codegenUnlocked(req)) {
    return res.json({
      locked: false,
      files,
      resourceCount: parsed.data.inventory.length,
    });
  }
  res.json({
    ...toCodegenSample(files),
    resourceCount: parsed.data.inventory.length,
  });
});

// -- approval: assessment to a real repo and workspace ------------------------

const approveSchema = z.object({
  assessmentId: z.string().min(1),
  migrationTarget: z.enum(["cloudflare", "hetzner"]),
  /** owner/name. Created if it does not exist. */
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, "repo must be owner/name"),
  destPath: z.string().default("infrastructure"),
  destBranch: z.string().default("main"),
  projectName: z
    .string()
    .regex(/^[a-z0-9-]+$/, "lowercase letters, digits and dashes only")
    .max(32)
    .optional(),
  backend: z.enum(["tfc", "s3", "local"]).default("tfc"),
  tfcOrg: z.string().optional(),
  s3Bucket: z.string().optional(),
  s3Endpoint: z.string().optional(),
});

/** The approval step of the funnel. The customer has seen their options and
 * picked a target; this turns the assessment into a repository of Terraform
 * and a workspace to run it in.
 *
 * Re-approving the same assessment and target reuses the project and adds a
 * job, so the repo converges rather than forking into a second project. */
tfRouter.post("/approve", async (req, res) => {
  const parsed = approveSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const orgId = req.user!.orgId;
  const input = parsed.data;

  const assessment = await prisma.assessment.findFirst({
    where: { id: input.assessmentId, orgId },
    select: { id: true, provider: true, status: true },
  });
  if (!assessment) return res.status(404).json({ error: "assessment not found" });
  if (assessment.status !== "completed") {
    return res.status(400).json({ error: "Assessment not completed" });
  }

  const name =
    input.projectName ??
    `${assessment.provider}-to-${input.migrationTarget}-${assessment.id.slice(-6)}`;

  const existing = await prisma.tfProject.findFirst({
    where: { orgId, name },
  });
  if (existing && existing.assessmentId !== assessment.id) {
    return res.status(409).json({
      error: `project "${name}" already exists for a different assessment`,
    });
  }

  const projectData = {
    orgId,
    name,
    source: "codegen",
    assessmentId: assessment.id,
    migrationTarget: input.migrationTarget,
    destRepo: input.repo,
    destPath: input.destPath,
    destBranch: input.destBranch,
    // Codegen writes its own versions.tf and provider.tf, so this is recorded
    // for reference rather than used to render a provider file.
    providerConfig: {
      name: input.migrationTarget,
      target: input.migrationTarget,
      source: assessment.provider,
    },
  };

  const project = existing
    ? await prisma.tfProject.update({
        where: { id: existing.id },
        data: {
          destRepo: projectData.destRepo,
          destPath: projectData.destPath,
          destBranch: projectData.destBranch,
          migrationTarget: projectData.migrationTarget,
        },
      })
    : await prisma.tfProject.create({ data: projectData });

  const job = await prisma.tfJob.create({
    data: {
      projectId: project.id,
      kind: "codegen",
      argumentsJson: {
        backend: input.backend,
        ...(input.tfcOrg ? { tfcOrg: input.tfcOrg } : {}),
        ...(input.s3Bucket ? { s3Bucket: input.s3Bucket } : {}),
        ...(input.s3Endpoint ? { s3Endpoint: input.s3Endpoint } : {}),
      },
    },
  });

  // Fire-and-forget, same as template jobs: the dashboard polls stage/status.
  void runJob(job.id).catch((err) => {
    console.error(`tf codegen job ${job.id} failed:`, err);
  });

  res.status(202).json({ project, job });
});

// -- stacks ------------------------------------------------------------------
//
// The org's GitHub connection needs, on the destination repo: Contents,
// Pull requests and Workflows read/write. Workflows because a stack writes
// .github/workflows, and GitHub refuses that push without it.
//
// A stack renders a whole deploy setup into the customer's app repository and
// lands it as a pull request (lib/stacks, runStackJob). Its settings live on
// the project, in providerConfig, so every later job re-renders from the same
// place the UI edits.

tfRouter.get("/stacks", (_req, res) => {
  res.json(
    listStacks().map((s) => ({
      slug: s.slug,
      name: s.name,
      description: s.description,
      template: s.template,
      target: s.target,
      inputSchema: s.inputSchema,
      example: s.example,
    }))
  );
});

const stackArgs = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]));

tfRouter.post("/stacks/:slug/preview", (req, res) => {
  const stack = getStack(req.params.slug);
  if (!stack) return res.status(404).json({ error: "stack not found" });
  const parsed = z.object({ arguments: stackArgs }).safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  try {
    const files = renderStack(stack, parsed.data.arguments);
    res.json({ files });
  } catch (err) {
    if (err instanceof TfInputValidationError) {
      return res.status(400).json({ error: err.message, details: err.details });
    }
    throw err;
  }
});

const stackProjectSchema = z.object({
  // Same shape the stack's `name` setting needs, since the dashboard derives
  // that from the project name: a name that passes here must also render.
  name: z
    .string()
    .regex(/^[a-z][a-z0-9-]{2,31}$/, "3-32 characters: lowercase letters, digits and dashes, starting with a letter"),
  destRepo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  destBranch: z.string().min(1).default("main"),
  arguments: stackArgs,
});

tfRouter.post("/stacks/:slug/projects", async (req, res) => {
  const stack = getStack(req.params.slug);
  if (!stack) return res.status(404).json({ error: "stack not found" });
  const parsed = stackProjectSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const d = parsed.data;
  // Render once now so bad settings fail here with a 400, not later inside a
  // background job. What gets stored is the settings with the stack's
  // defaults filled in: a default that changes later must not silently
  // change an existing project's servers on its next render.
  let settings: TfArguments;
  try {
    settings = resolveStackInputs(stack, d.arguments);
    renderStack(stack, settings);
  } catch (err) {
    if (err instanceof TfInputValidationError) {
      return res.status(400).json({ error: err.message, details: err.details });
    }
    throw err;
  }
  let project;
  try {
    project = await prisma.tfProject.create({
      data: {
        orgId: req.user!.orgId,
        name: d.name,
        source: "stack",
        stackSlug: stack.slug,
        destRepo: d.destRepo,
        destBranch: d.destBranch,
        providerConfig: settings,
      },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return res.status(409).json({ error: `a project named ${d.name} already exists` });
    }
    throw err;
  }
  const job = await prisma.tfJob.create({
    data: { projectId: project.id, kind: "stack", argumentsJson: settings },
  });
  void runJob(job.id).catch((err) => {
    console.error(`tf job ${job.id} failed:`, err);
  });
  res.status(202).json({ project, job });
});

// Changing a stack project's settings re-renders it into a pull request, the
// same as creating it. The body carries the complete settings, not a patch:
// what the dashboard shows is what gets rendered.
tfRouter.put("/stacks/projects/:id/settings", async (req, res) => {
  const parsed = z.object({ arguments: stackArgs }).safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const project = await prisma.tfProject.findFirst({
    where: { id: req.params.id, orgId: req.user!.orgId, source: "stack" },
  });
  if (!project) return res.status(404).json({ error: "project not found" });
  const stack = project.stackSlug ? getStack(project.stackSlug) : null;
  if (!stack) return res.status(404).json({ error: "stack not found" });
  // Every resource is named from `name`; changing it would make the next
  // apply replace the server, its volume and its tunnel.
  const current = project.providerConfig as TfArguments;
  if (parsed.data.arguments.name !== current.name) {
    return res.status(400).json({
      error: `name is fixed after creation (it is ${String(current.name)}); every resource is named from it`,
    });
  }
  let settings: TfArguments;
  try {
    settings = resolveStackInputs(stack, parsed.data.arguments);
    renderStack(stack, settings);
  } catch (err) {
    if (err instanceof TfInputValidationError) {
      return res.status(400).json({ error: err.message, details: err.details });
    }
    throw err;
  }
  const updated = await prisma.tfProject.update({
    where: { id: project.id },
    data: { providerConfig: settings },
  });
  const job = await prisma.tfJob.create({
    data: { projectId: project.id, kind: "stack", argumentsJson: settings },
  });
  void runJob(job.id).catch((err) => {
    console.error(`tf job ${job.id} failed:`, err);
  });
  res.status(202).json({ project: updated, job });
});

