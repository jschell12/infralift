import { Router } from "express";
import { GIT_HOSTS, type ResourceInventoryItem } from "@infralift/shared";
import { z } from "zod";
import type { TfArguments } from "../lib/tf/render.js";
import { getTfcClient } from "../lib/tf/tfc-client.js";
import { requireAdmin } from "../lib/cf-auth.js";
import { handle, parseBody } from "../lib/errors.js";
import { listProjects } from "../services/projects.js";
import { createStackProject, listStackSummaries, previewStack, updateStackSettings } from "../services/stacks.js";
import { createTemplateProject, listRenderings, listTemplates, previewTemplate, publishTemplate } from "../services/templates.js";
import { getJob, listJobs, queueProjectJob } from "../services/jobs.js";
import {
  approveMigration,
  generateFromAssessment,
  generatePreview,
  setCodegenUnlock,
} from "../services/codegen.js";

// HTTP for Terraform projects, templates, jobs, codegen and stacks. The rules
// live in services/*; each route validates its input, calls one service
// function and sends the result.

// Kept for tests that reach these through the router module.
export { resetCodegenRateLimit } from "../services/codegen.js";
export { visibleTemplates } from "../services/templates.js";

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
    const { workspaces, truncated } = await client.listWorkspacesCapped();
    res.json({
      connected: true,
      org: process.env.TFC_ORG ?? null,
      workspaceCount: workspaces.length,
      // workspaceCount is a floor when the listing hit TFC_WORKSPACE_PAGES.
      truncated,
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

// -- templates (services/templates.ts) ---------------------------------------

const argsRecord = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]));

tfRouter.get(
  "/templates",
  handle(async (req, res) => {
    res.json(await listTemplates(req.user!.orgId));
  })
);

const templateSchema = z.object({
  slug: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(1),
  description: z.string().default(""),
  releaseTag: z.string().min(1),
  templateBody: z.string().min(1),
  inputSchema: z.record(z.string(), z.unknown()),
});

// Admin-only: the catalog is shared by every org and its bodies are Terraform
// the pipeline renders and commits. Reading it stays open.
tfRouter.post(
  "/templates",
  requireAdmin,
  handle(async (req, res) => {
    res.status(201).json(await publishTemplate(parseBody(templateSchema, req.body)));
  })
);

tfRouter.post(
  "/templates/:slug/versions/:tag/preview",
  handle(async (req, res) => {
    const { arguments: args } = parseBody(z.object({ arguments: argsRecord }), req.body);
    res.json(await previewTemplate(req.user!.orgId, req.params.slug, req.params.tag, args as TfArguments));
  })
);

// -- projects --------------------------------------------------------------------

tfRouter.get(
  "/projects",
  handle(async (req, res) => {
    res.json(await listProjects(req.user!.orgId));
  })
);

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

tfRouter.post(
  "/projects",
  handle(async (req, res) => {
    res.status(201).json(await createTemplateProject(req.user!.orgId, parseBody(projectSchema, req.body)));
  })
);

tfRouter.get(
  "/projects/:id/renderings",
  handle(async (req, res) => {
    res.json(await listRenderings(req.user!.orgId, req.params.id));
  })
);

// -- jobs (services/jobs.ts) ---------------------------------------------------------

tfRouter.post(
  "/jobs",
  handle(async (req, res) => {
    const d = parseBody(z.object({ projectId: z.string().min(1), arguments: argsRecord }), req.body);
    res.status(202).json(await queueProjectJob(req.user!.orgId, d.projectId, d.arguments as TfArguments));
  })
);

tfRouter.get(
  "/jobs",
  handle(async (req, res) => {
    res.json(await listJobs(req.user!.orgId, String(req.query.projectId ?? "")));
  })
);

tfRouter.get(
  "/jobs/:id",
  handle(async (req, res) => {
    res.json(await getJob(req.user!.orgId, req.params.id));
  })
);

// -- codegen and approval (services/codegen.ts) --------------------------------------

const caller = (req: { user?: { orgId: string; email: string } }) => ({
  orgId: req.user!.orgId,
  email: req.user!.email,
});

const codegenSchema = z.object({
  assessmentId: z.string().min(1),
  backend: z.enum(["tfc", "s3", "local"]).default("local"),
  tfcOrg: z.string().optional(),
  s3Bucket: z.string().optional(),
  s3Endpoint: z.string().optional(),
  projectName: z.string().optional(),
  migrationTarget: z.enum(["cloudflare", "hetzner"]).nullable().default(null),
});

const codegenPreviewSchema = z.object({
  provider: z.string().min(1),
  // Bounded: this array is caller-supplied and every entry is rendered, so an
  // unbounded one is a CPU amplifier behind a free signup.
  inventory: z
    .array(
      z.object({
        provider: z.string(),
        type: z.string(),
        externalId: z.string(),
        name: z.string(),
        region: z.string().optional(),
        monthlyCostCents: z.number().optional(),
        metadata: z.record(z.unknown()).optional(),
      })
    )
    .max(1000),
  backend: z.enum(["tfc", "s3", "local"]).default("local"),
  migrationTarget: z.enum(["cloudflare", "hetzner"]).nullable().default(null),
});

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

tfRouter.post(
  "/unlock",
  requireAdmin,
  handle(async (req, res) => {
    const d = parseBody(z.object({ orgId: z.string().min(1), unlocked: z.boolean() }), req.body);
    res.json(await setCodegenUnlock(req.user!.email, d));
  })
);

tfRouter.post(
  "/codegen",
  handle(async (req, res) => {
    res.json(await generateFromAssessment(caller(req), parseBody(codegenSchema, req.body)));
  })
);

tfRouter.post(
  "/codegen/preview",
  handle(async (req, res) => {
    const d = parseBody(codegenPreviewSchema, req.body);
    res.json(await generatePreview(caller(req), { ...d, inventory: d.inventory as ResourceInventoryItem[] }));
  })
);

tfRouter.post(
  "/approve",
  handle(async (req, res) => {
    res.status(202).json(await approveMigration(req.user!.orgId, parseBody(approveSchema, req.body)));
  })
);

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
  res.json(listStackSummaries());
});

const stackArgs = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]));
const settingsSchema = z.object({ arguments: stackArgs, tfcConnectionId: z.string().min(1).nullish() });

const stackProjectSchema = z.object({
  // Same shape the stack's `name` setting needs, since the dashboard derives
  // that from the project name: a name that passes here must also render.
  name: z
    .string()
    .regex(/^[a-z][a-z0-9-]{2,31}$/, "3-32 characters: lowercase letters, digits and dashes, starting with a letter"),
  // GitLab paths can nest groups: acme/platform/web.
  destRepo: z.string().regex(/^[\w.-]+(\/[\w.-]+)+$/),
  destBranch: z.string().min(1).default("main"),
  gitHost: z.enum(GIT_HOSTS).default("github"),
  connectionId: z.string().min(1).optional(),
  createRepo: z.boolean().default(false),
  tfcConnectionId: z.string().min(1).nullish(),
  arguments: stackArgs,
});

tfRouter.post(
  "/stacks/:slug/preview",
  handle(async (req, res) => {
    res.json(await previewStack(req.user!.orgId, req.params.slug, parseBody(settingsSchema, req.body)));
  })
);

tfRouter.post(
  "/stacks/:slug/projects",
  handle(async (req, res) => {
    res.status(202).json(await createStackProject(req.user!.orgId, req.params.slug, parseBody(stackProjectSchema, req.body)));
  })
);

tfRouter.put(
  "/stacks/projects/:id/settings",
  handle(async (req, res) => {
    res.status(202).json(await updateStackSettings(req.user!.orgId, req.params.id, parseBody(settingsSchema, req.body)));
  })
);
