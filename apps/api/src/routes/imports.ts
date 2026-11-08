import { Router, type Response } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../lib/db.js";
import { decryptToken } from "../lib/crypto.js";
import { gitHostClient } from "../lib/git/hosts.js";
import { GitCommitError } from "../lib/git/errors.js";
import { runJob } from "../lib/tf/pipeline.js";
import { readRepoForScan } from "../lib/import/read.js";
import { scanRepo } from "../lib/import/scan.js";
import { CHECK_JOB_NAME, GENERATED_COMMIT_SUBJECT } from "../lib/import/contract.js";
import {
  checkEnv,
  checkSetupLines,
  checkWorkflowPath,
  isSafePath,
} from "../lib/import/check.js";
import { AdoptInputError, planAdoption, renderAdoption } from "../lib/import/adopt.js";
import { PROVIDERS, type Provider, type ResourceInventoryItem } from "@infralift/shared";
import { classifyCheck } from "../lib/import/result.js";

// Importing an existing Terraform repository. GitHub only for now; GitLab
// follows once this path is proven.
//
//   POST /tf/imports/scan  read the repository, list its root modules
//   POST /tf/imports       import one root module: a project, plus a pull
//                          request adding the read-only plan check
//   POST /tf/imports/from-assessment
//                          adopt resources built by hand in a connected cloud
//                          account, as they are: import blocks plus a check
//                          that generates their code and must change nothing
//   GET  /tf/imports/:projectId/check
//                          what that check said, read back from GitHub

export const importsRouter = Router();

const repoField = z.string().regex(/^[\w.-]+\/[\w.-]+$/, "a GitHub repository is owner/name");

const scanSchema = z.object({
  repo: repoField,
  ref: z.string().min(1).optional(),
  connectionId: z.string().min(1).optional(),
});

/** The org's GitHub client, or null after answering 400. */
async function githubFor(res: Response, orgId: string, connectionId?: string) {
  const conn = await prisma.providerConnection.findFirst({
    where: { orgId, provider: "github", ...(connectionId ? { id: connectionId } : {}) },
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
  });
  if (!conn) {
    res.status(400).json({ error: "connect GitHub under Connections first" });
    return null;
  }
  return { conn, client: gitHostClient("github", decryptToken(conn.encryptedToken)) };
}

function githubFailure(res: Response, err: unknown) {
  if (err instanceof GitCommitError) return res.status(502).json({ error: err.message });
  throw err;
}

async function scan(client: ReturnType<typeof gitHostClient>, repo: string, ref?: string) {
  const read = await readRepoForScan(client, repo, ref);
  return { ...read, ...scanRepo(read.files) };
}

importsRouter.post("/scan", async (req, res) => {
  const parsed = scanSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const gh = await githubFor(res, req.user!.orgId, parsed.data.connectionId);
  if (!gh) return;
  let result;
  try {
    result = await scan(gh.client, parsed.data.repo, parsed.data.ref);
  } catch (err) {
    return githubFailure(res, err);
  }
  res.json({
    repo: parsed.data.repo,
    ref: result.ref,
    filesRead: result.files.length,
    skipped: result.skipped,
    errors: result.errors,
    roots: result.roots.map((r) => ({
      ...r,
      checkFile: checkWorkflowPath(r.path),
      // Only a module that can be imported gets a check, so only it lists setup.
      secrets: r.readiness === "ready" ? checkEnv(r).map((e) => e.secret) : [],
      setup: r.readiness === "ready" ? checkSetupLines(r) : [],
    })),
  });
});

const importSchema = scanSchema.extend({
  name: z
    .string()
    .regex(/^[a-z][a-z0-9-]{2,31}$/, "3-32 characters: lowercase letters, digits and dashes, starting with a letter"),
  /** The root module's directory; "" = the repository root. */
  path: z.string().max(512).default(""),
  /** Which -backend-config file to init with, when the scan found several. */
  backendConfigFile: z.string().min(1).optional(),
});

importsRouter.post("/", async (req, res) => {
  const parsed = importSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const d = parsed.data;
  const { orgId } = req.user!;
  const gh = await githubFor(res, orgId, d.connectionId);
  if (!gh) return;

  // Scanned again here rather than trusting what the dashboard sends: the
  // stored scan decides which secrets the check asks for.
  let result;
  try {
    result = await scan(gh.client, d.repo, d.ref);
  } catch (err) {
    return githubFailure(res, err);
  }
  const root = result.roots.find((r) => r.path === d.path.replace(/^\/+|\/+$/g, ""));
  if (!root) {
    return res.status(404).json({ error: `no Terraform root module at ${d.path || "the repository root"}` });
  }
  if (root.readiness !== "ready") {
    return res.status(409).json({ error: root.notes[0] ?? "this module cannot be imported yet", readiness: root.readiness });
  }
  let backendConfigFile: string | null = null;
  if (root.backend.partial) {
    const files = root.backend.configFiles;
    if (d.backendConfigFile) {
      if (!files.includes(d.backendConfigFile)) {
        return res.status(400).json({ error: `${d.backendConfigFile} is not one of ${files.join(", ")}` });
      }
      backendConfigFile = d.backendConfigFile;
    } else if (files.length === 1) {
      backendConfigFile = files[0];
    } else {
      return res.status(400).json({ error: `pick the backend config file: ${files.join(", ")}`, configFiles: files });
    }
  }

  let project;
  try {
    project = await prisma.tfProject.create({
      data: {
        orgId,
        name: d.name,
        source: "imported",
        gitHost: "github",
        gitConnectionId: gh.conn.id,
        destRepo: d.repo,
        destBranch: result.ref,
        destPath: root.path,
        providerConfig: {},
        importJson: root as unknown as Prisma.InputJsonValue,
      },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return res.status(409).json({ error: `a project named ${d.name} already exists` });
    }
    throw err;
  }
  const job = await prisma.tfJob.create({
    data: { projectId: project.id, kind: "import", argumentsJson: { backendConfigFile } },
  });
  void runJob(job.id).catch((err) => {
    console.error(`tf job ${job.id} failed:`, err);
  });
  res.status(202).json({ project, job });
});

importsRouter.get("/:projectId/check", async (req, res) => {
  const { orgId } = req.user!;
  const project = await prisma.tfProject.findFirst({
    where: { id: req.params.projectId, orgId, source: "imported" },
  });
  if (!project) return res.status(404).json({ error: "imported project not found" });
  const gh = await githubFor(res, orgId, project.gitConnectionId ?? undefined);
  if (!gh) return;

  const job = await prisma.tfJob.findFirst({
    where: { projectId: project.id, kind: "import", prUrl: { not: null } },
    orderBy: { createdAt: "desc" },
  });
  const number = Number(/\/pull\/(\d+)$/.exec(job?.prUrl ?? "")?.[1] ?? NaN);
  let result;
  try {
    const pr = Number.isInteger(number) ? await gh.client.getChangeRequest({ repo: project.destRepo, number }) : null;
    let run = pr ? await gh.client.getCheckRun({ repo: project.destRepo, sha: pr.headSha, name: CHECK_JOB_NAME }) : null;
    // The check's own generated-code commit never gets a run of its own
    // (GitHub does not trigger workflows for the job token's pushes); the
    // run that made it planned with that code, so its result stands.
    if (pr && !run) {
      const head = await gh.client.getCommit({ repo: project.destRepo, sha: pr.headSha });
      const generated = project.destPath ? `${project.destPath}/generated.tf` : "generated.tf";
      // Only a commit that is exactly the check's own: its subject and nothing
      // but generated.tf. Anything else gets no borrowed result.
      if (
        head?.subject === GENERATED_COMMIT_SUBJECT &&
        head.parentSha &&
        head.files.length === 1 &&
        head.files[0] === generated
      ) {
        run = await gh.client.getCheckRun({ repo: project.destRepo, sha: head.parentSha, name: CHECK_JOB_NAME });
      }
    }
    result = classifyCheck(pr, run);
  } catch (err) {
    if (!(err instanceof GitCommitError)) throw err;
    // GitHub is unreachable or refused: answer with the last known result.
    return res.status(502).json({ error: err.message, last: project.importCheckJson ?? null });
  }
  await prisma.tfProject.update({
    where: { id: project.id },
    data: { importCheckJson: result as unknown as Prisma.InputJsonValue },
  });
  res.json(result);
});

const adoptSchema = z.object({
  assessmentId: z.string().min(1),
  repo: repoField,
  ref: z.string().min(1).optional(),
  connectionId: z.string().min(1).optional(),
  name: importSchema.shape.name,
  /** Where the adopted code goes in the repository. */
  path: z.string().max(200).refine(isSafePath, "letters, digits, dot, dash, underscore and slash"),
  backend: z.object({
    kind: z.enum(["s3", "r2"]),
    bucket: z.string(),
    key: z.string(),
    region: z.string().optional(),
    accountId: z.string().optional(),
  }),
});

importsRouter.post("/from-assessment", async (req, res) => {
  const parsed = adoptSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const d = parsed.data;
  const { orgId } = req.user!;
  const assessment = await prisma.assessment.findFirst({
    where: { id: d.assessmentId, orgId, status: "completed" },
    include: { inventory: true },
  });
  if (!assessment) return res.status(404).json({ error: "completed assessment not found" });
  if (!(PROVIDERS as readonly string[]).includes(assessment.provider)) {
    return res.status(400).json({ error: `unknown provider ${assessment.provider}` });
  }
  const provider = assessment.provider as Provider;
  const inventory: ResourceInventoryItem[] = assessment.inventory.map((i) => ({
    provider,
    type: i.type,
    externalId: i.externalId,
    name: i.name,
    region: i.region ?? undefined,
    monthlyCostCents: i.monthlyCostCents ?? undefined,
    metadata: (i.metadata ?? undefined) as Record<string, unknown> | undefined,
  }));
  const path = d.path.replace(/^\/+|\/+$/g, "");
  const plan = planAdoption(provider, inventory);
  let rendered;
  try {
    rendered = renderAdoption({ provider, plan, backend: d.backend, path, label: path || "the repository root" });
  } catch (err) {
    if (err instanceof AdoptInputError) return res.status(400).json({ error: err.message, skipped: plan.skipped });
    throw err;
  }

  const gh = await githubFor(res, orgId, d.connectionId);
  if (!gh) return;
  let ref: string;
  try {
    ref = d.ref || (await gh.client.defaultBranch(d.repo));
    // Adoption writes new files; it must not land on top of Terraform that
    // is already there (that is the repo import's job).
    for (const f of rendered.files) {
      const p = path ? `${path}/${f.path}` : f.path;
      if (await gh.client.fileExists({ repo: d.repo, path: p, branch: ref })) {
        return res.status(409).json({ error: `${p} already exists in ${d.repo}; pick another path` });
      }
    }
  } catch (err) {
    return githubFailure(res, err);
  }

  let project;
  try {
    project = await prisma.tfProject.create({
      data: {
        orgId,
        name: d.name,
        source: "imported",
        assessmentId: assessment.id,
        gitHost: "github",
        gitConnectionId: gh.conn.id,
        destRepo: d.repo,
        destBranch: ref,
        destPath: path,
        providerConfig: {},
        importJson: rendered.root as unknown as Prisma.InputJsonValue,
      },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return res.status(409).json({ error: `a project named ${d.name} already exists` });
    }
    throw err;
  }
  const job = await prisma.tfJob.create({
    data: {
      projectId: project.id,
      kind: "import",
      argumentsJson: { backendConfigFile: null, adoptFiles: rendered.files },
    },
  });
  void runJob(job.id).catch((err) => {
    console.error(`tf job ${job.id} failed:`, err);
  });
  res.status(202).json({ project, job, adopted: plan.imports.length, skipped: plan.skipped });
});
