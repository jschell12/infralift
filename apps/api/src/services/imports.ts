import { Prisma } from "@prisma/client";
import { PROVIDERS, type Provider, type ResourceInventoryItem } from "@infralift/shared";
import { prisma } from "../lib/db.js";
import { toInventoryItem } from "../lib/inventory.js";
import { decryptToken } from "../lib/crypto.js";
import { Conflict, InvalidInput, NotFound, Upstream } from "../lib/errors.js";
import { gitHostClient, type GitHostClient } from "../lib/git/hosts.js";
import { GitCommitError } from "../lib/git/errors.js";
import { enqueueJob } from "../lib/jobs/enqueue.js";
import { readRepoForScan } from "../lib/import/read.js";
import { scanRepo } from "../lib/import/scan.js";
import { CHECK_JOB_NAME, GENERATED_COMMIT_SUBJECT } from "../lib/import/contract.js";
import { checkEnv, checkSetupLines, checkWorkflowPath } from "../lib/import/check.js";
import { AdoptInputError, planAdoption, renderAdoption, type AdoptBackend } from "../lib/import/adopt.js";
import { classifyCheck, type ImportCheckResult } from "../lib/import/result.js";
import { PREFER_USABLE_CONNECTION } from "../lib/connection-order.js";

// ---------------------------------------------------------------------------
// Importing existing Terraform, and adopting resources built by hand.
//
// Every rule lives here; routes/imports.ts only validates input and responds.
// GitHub only for now; GitLab follows once this path is proven.
//
//   scanRepository        read a repository, list its root modules
//   importModule          one root module becomes a project, plus a pull
//                         request adding the read-only plan check
//   adoptFromAssessment   a cloud account's resources, as they run: import
//                         blocks plus a check that generates their code
//   readImportCheck       what that check said, read back from GitHub
// ---------------------------------------------------------------------------

/** The org's GitHub connection and a client for it. */
async function githubFor(orgId: string, connectionId?: string | null) {
  const conn = await prisma.providerConnection.findFirst({
    where: { orgId, provider: "github", ...(connectionId ? { id: connectionId } : {}) },
    orderBy: PREFER_USABLE_CONNECTION,
  });
  if (!conn) throw new InvalidInput("connect GitHub under Connections first");
  return { conn, client: gitHostClient("github", decryptToken(conn.encryptedToken)) };
}

async function scan(client: GitHostClient, repo: string, ref?: string) {
  const read = await readRepoForScan(client, repo, ref);
  return { ...read, ...scanRepo(read.files) };
}

/** A unique project name, or Conflict. */
async function createProject(data: Prisma.TfProjectUncheckedCreateInput) {
  try {
    return await prisma.tfProject.create({ data });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw new Conflict(`a project named ${data.name} already exists`);
    }
    throw err;
  }
}

function queueImportJob(projectId: string, argumentsJson: Prisma.InputJsonValue) {
  return enqueueJob({ projectId, kind: "import", argumentsJson });
}

// -- scan -----------------------------------------------------------------------

export interface RepoRef {
  repo: string;
  ref?: string;
  connectionId?: string;
}

export async function scanRepository(orgId: string, input: RepoRef) {
  const gh = await githubFor(orgId, input.connectionId);
  const result = await scan(gh.client, input.repo, input.ref);
  return {
    repo: input.repo,
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
  };
}

// -- import one root module ---------------------------------------------------------

export interface ImportInput extends RepoRef {
  name: string;
  /** The root module's directory; "" = the repository root. */
  path: string;
  /** Which -backend-config file to init with, when the scan found several. */
  backendConfigFile?: string;
}

export async function importModule(orgId: string, input: ImportInput) {
  const gh = await githubFor(orgId, input.connectionId);
  // Scanned again here rather than trusting what the dashboard sends: the
  // stored scan decides which secrets the check asks for.
  const result = await scan(gh.client, input.repo, input.ref);
  const root = result.roots.find((r) => r.path === input.path.replace(/^\/+|\/+$/g, ""));
  if (!root) throw new NotFound(`no Terraform root module at ${input.path || "the repository root"}`);
  if (root.readiness !== "ready") {
    throw new Conflict(root.notes[0] ?? "this module cannot be imported yet", { readiness: root.readiness });
  }
  let backendConfigFile: string | null = null;
  if (root.backend.partial) {
    const files = root.backend.configFiles;
    if (input.backendConfigFile) {
      if (!files.includes(input.backendConfigFile)) {
        throw new InvalidInput(`${input.backendConfigFile} is not one of ${files.join(", ")}`);
      }
      backendConfigFile = input.backendConfigFile;
    } else if (files.length === 1) {
      backendConfigFile = files[0];
    } else {
      throw new InvalidInput(`pick the backend config file: ${files.join(", ")}`, { configFiles: files });
    }
  }
  const project = await createProject({
    orgId,
    name: input.name,
    source: "imported",
    gitHost: "github",
    gitConnectionId: gh.conn.id,
    destRepo: input.repo,
    destBranch: result.ref,
    destPath: root.path,
    providerConfig: {},
    importJson: root as unknown as Prisma.InputJsonValue,
  });
  const job = await queueImportJob(project.id, { backendConfigFile });
  return { project, job };
}

// -- adopt a cloud account's resources ----------------------------------------------

export interface AdoptInput extends RepoRef {
  assessmentId: string;
  name: string;
  /** Where the adopted code goes in the repository. */
  path: string;
  backend: AdoptBackend;
}

export async function adoptFromAssessment(orgId: string, input: AdoptInput) {
  const assessment = await prisma.assessment.findFirst({
    where: { id: input.assessmentId, orgId, status: "completed" },
    include: { inventory: true },
  });
  if (!assessment) throw new NotFound("completed assessment not found");
  if (!(PROVIDERS as readonly string[]).includes(assessment.provider)) {
    throw new InvalidInput(`unknown provider ${assessment.provider}`);
  }
  const provider = assessment.provider as Provider;
  const inventory: ResourceInventoryItem[] = assessment.inventory.map(toInventoryItem);
  const path = input.path.replace(/^\/+|\/+$/g, "");
  const plan = planAdoption(provider, inventory);
  let rendered;
  try {
    rendered = renderAdoption({ provider, plan, backend: input.backend, path, label: path || "the repository root" });
  } catch (err) {
    if (err instanceof AdoptInputError) throw new InvalidInput(err.message, { skipped: plan.skipped });
    throw err;
  }

  const gh = await githubFor(orgId, input.connectionId);
  const ref = input.ref || (await gh.client.defaultBranch(input.repo));
  // Adoption writes new files; it must not land on top of Terraform that is
  // already there (that is the repo import's job).
  for (const f of rendered.files) {
    const p = path ? `${path}/${f.path}` : f.path;
    if (await gh.client.fileExists({ repo: input.repo, path: p, branch: ref })) {
      throw new Conflict(`${p} already exists in ${input.repo}; pick another path`);
    }
  }
  const project = await createProject({
    orgId,
    name: input.name,
    source: "imported",
    assessmentId: assessment.id,
    gitHost: "github",
    gitConnectionId: gh.conn.id,
    destRepo: input.repo,
    destBranch: ref,
    destPath: path,
    providerConfig: {},
    importJson: rendered.root as unknown as Prisma.InputJsonValue,
  });
  const job = await queueImportJob(project.id, { backendConfigFile: null, adoptFiles: rendered.files });
  return { project, job, adopted: plan.imports.length, skipped: plan.skipped };
}

// -- read the check back ----------------------------------------------------------

export async function readImportCheck(orgId: string, projectId: string): Promise<ImportCheckResult> {
  const project = await prisma.tfProject.findFirst({ where: { id: projectId, orgId, source: "imported" } });
  if (!project) throw new NotFound("imported project not found");
  const gh = await githubFor(orgId, project.gitConnectionId);

  const job = await prisma.tfJob.findFirst({
    where: { projectId: project.id, kind: "import", prUrl: { not: null } },
    orderBy: { createdAt: "desc" },
  });
  const number = Number(/\/pull\/(\d+)$/.exec(job?.prUrl ?? "")?.[1] ?? NaN);
  let result: ImportCheckResult;
  try {
    const pr = Number.isInteger(number) ? await gh.client.getChangeRequest({ repo: project.destRepo, number }) : null;
    let run = pr ? await gh.client.getCheckRun({ repo: project.destRepo, sha: pr.headSha, name: CHECK_JOB_NAME }) : null;
    // The check's own generated-code commit never gets a run of its own
    // (GitHub does not trigger workflows for the job token's pushes); the run
    // that made it planned with that code, so its result stands.
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
    throw new Upstream(err.message, { last: project.importCheckJson ?? null });
  }
  await prisma.tfProject.update({
    where: { id: project.id },
    data: { importCheckJson: result as unknown as Prisma.InputJsonValue },
  });
  return result;
}
