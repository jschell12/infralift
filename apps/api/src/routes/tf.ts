import { Router } from "express";
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

export const tfRouter = Router();

// -- TFC connection status ---------------------------------------------------

tfRouter.get("/tfc-status", async (_req, res) => {
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

tfRouter.get("/templates", async (_req, res) => {
  const templates = await prisma.tfTemplate.findMany({
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

tfRouter.post("/templates", async (req, res) => {
  const parsed = templateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const { slug, name, description, releaseTag, templateBody, inputSchema } =
    parsed.data;
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
  const template = await prisma.tfTemplate.findUnique({
    where: { slug: req.params.slug },
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
  const template = await prisma.tfTemplate.findUnique({
    where: { slug: d.templateSlug },
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
  const renderings = await prisma.tfRendering.findMany({
    where: { projectId: req.params.id },
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
  const project = await prisma.tfProject.findUnique({
    where: { id: parsed.data.projectId },
  });
  if (!project) return res.status(404).json({ error: "project not found" });
  const job = await prisma.tfJob.create({
    data: {
      projectId: project.id,
      argumentsJson: parsed.data.arguments,
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
    where: { projectId },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  res.json(jobs);
});

tfRouter.get("/jobs/:id", async (req, res) => {
  const job = await prisma.tfJob.findUnique({
    where: { id: req.params.id },
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

  res.json({ files, resourceCount: inventory.length });
});

// Preview: generate HCL without an assessment (from provided inventory)
tfRouter.post("/codegen/preview", async (req, res) => {
  const schema = z.object({
    provider: z.string().min(1),
    inventory: z.array(z.object({
      provider: z.string(),
      type: z.string(),
      externalId: z.string(),
      name: z.string(),
      region: z.string().optional(),
      monthlyCostCents: z.number().optional(),
      metadata: z.record(z.unknown()).optional(),
    })),
    backend: z.enum(["tfc", "s3", "local"]).default("local"),
    migrationTarget: z.enum(["cloudflare", "hetzner"]).nullable().default(null),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const files = generateHcl({
    provider: parsed.data.provider as Provider,
    inventory: parsed.data.inventory as ResourceInventoryItem[],
    backend: parsed.data.backend,
    migrationTarget: parsed.data.migrationTarget,
  });

  res.json({ files, resourceCount: parsed.data.inventory.length });
});
