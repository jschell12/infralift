import type { ProjectKind, ProjectVersions, VersionBaseline, VersionItem, VersionsPage } from "@infralift/shared";
import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/db.js";
import { decryptToken } from "../lib/crypto.js";
import { settleBounded } from "../lib/bounded.js";
import { PREFER_USABLE_CONNECTION } from "../lib/connection-order.js";
import { NotFound } from "../lib/errors.js";
import { GitCommitError, GitFileTooLarge } from "../lib/git/errors.js";
import { gitHostClient, type GitHostClient } from "../lib/git/hosts.js";
import { log } from "../lib/log.js";
import { RATE_LIMITS, RateLimiter } from "../lib/rate-limit.js";
import { getStack, type StackManifest } from "../lib/stacks/index.js";
import { PROVIDER_VERSIONS, REQUIRED_VERSION } from "../lib/tf/baseline.js";
import {
  classifyProviders,
  classifyRelease,
  classifyRequiredVersion,
  factsFromFiles,
  floorForKind,
  worstStatus,
  type RepoVersionFacts,
  type StoredVersionFacts,
} from "../lib/tf/versions.js";
import { markInvalidOnAuthFailure } from "./connections.js";

// ---------------------------------------------------------------------------
// The fleet view (ADR 0012, phase 1): how far each project is behind.
//
//   read      the root module of the project's repository, on its branch:
//             one tree listing, then its *.tf (at most READ_LIMITS.maxTfFiles)
//             and its .terraform.lock.hcl, READ_LIMITS.concurrency at a time,
//             each through the git client's own deadline (lib/http.ts)
//   store     the facts read, or the problem in words, on the project
//             (versionFacts, versionCheckedAt). Never a host's response body.
//   classify  at list time, against baseline.ts and the stack's newest
//             release, so a moved pin needs no re-read (lib/tf/versions.ts)
//
//   sweep     like the drift sweep (services/drift.ts): projects not read in
//             VERSION_INTERVAL_MS, never-read first, VERSION_BATCH per tick,
//             VERSION_CONCURRENCY projects at once
//   on demand POST /tf/projects/:id/versions/check, rate limited per org
//             (RATE_LIMITS.versionCheck)
//   claim     a conditional UPDATE on versionCheckedAt, as the drift sweep
//             claims, so a sweep and a click never read one project twice
//
// A GitHub rate limit is a back-off: the claim already moved
// versionCheckedAt, so the last facts stay and the next try is an interval
// away. A 401 or 403 marks the connection invalid, as a job would.
// ---------------------------------------------------------------------------

export const VERSION_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const VERSION_BATCH = 10;
export const VERSION_CONCURRENCY = 3;
export const VERSION_SWEEP_EVERY_MS = 30 * 60 * 1000;
export const VERSION_SWEEP_JITTER_MS = 10 * 60 * 1000;
export const VERSION_PAGE_SIZE = 100;
export const READ_LIMITS = { maxTfFiles: 25, maxBytes: 256 * 1024, concurrency: 4 };

const LOCK_FILE = ".terraform.lock.hcl";

const onDemand = new RateLimiter(RATE_LIMITS.versionCheck);

type ClientFor = (host: string, token: string) => GitHostClient;
const defaultClientFor: ClientFor = (host, token) => gitHostClient(host === "gitlab" ? "gitlab" : "github", token);

/** The baseline as data, for the dashboard (GET /tf/baseline). */
export function versionBaseline(): VersionBaseline {
  return { requiredVersion: { ...REQUIRED_VERSION }, providers: { ...PROVIDER_VERSIONS } };
}

// -- where to read ----------------------------------------------------------

/** The directory a stack renders its root module into: the shortest
 *  directory holding a rendered main.tf that is not a module or the
 *  bootstrap. Null when the manifest has none. */
export function stackRootDir(manifest: Pick<StackManifest, "rendered"> | null | undefined): string | null {
  const dirs = (manifest?.rendered ?? [])
    .map((r) => r.path)
    .filter((p) => !p.includes("{") && (p === "main.tf" || p.endsWith("/main.tf")))
    .map((p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : ""))
    .filter((d) => !/(^|\/)(modules|bootstrap)(\/|$)/.test(d))
    .sort((a, b) => a.length - b.length || a.localeCompare(b));
  return dirs[0] ?? null;
}

interface ReadableProject {
  id: string;
  orgId: string;
  source: string;
  stackSlug: string | null;
  destRepo: string;
  destBranch: string;
  destPath: string;
  gitHost: string;
  gitConnectionId: string | null;
  versionCheckedAt: Date | null;
  stackVersion: { manifest: Prisma.JsonValue } | null;
}

const READABLE_SELECT = {
  id: true,
  orgId: true,
  source: true,
  stackSlug: true,
  destRepo: true,
  destBranch: true,
  destPath: true,
  gitHost: true,
  gitConnectionId: true,
  versionCheckedAt: true,
  stackVersion: { select: { manifest: true } },
} as const;

/** The root module's directory in the repository. */
function rootDirOf(p: ReadableProject): string | null {
  if (p.source !== "stack") return p.destPath;
  if (p.stackSlug) return stackRootDir(getStack(p.stackSlug));
  return stackRootDir(p.stackVersion?.manifest as Pick<StackManifest, "rendered"> | null);
}

/** Every project that has a repository to read. */
const READABLE_WHERE = { destRepo: { not: "" }, createRepo: false } as const;

// -- read -------------------------------------------------------------------

/** Reads one root module's pins. Throws GitCommitError for the caller to
 *  sort into back-off, refusal or problem. */
export async function readRepoVersions(client: GitHostClient, repo: string, ref: string, root: string): Promise<RepoVersionFacts> {
  const listing = await client.listFiles({ repo, ref });
  const notes: string[] = [];
  const inRoot = listing.paths.filter((p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "") === root);
  const lockPath = root ? `${root}/${LOCK_FILE}` : LOCK_FILE;
  let tfPaths = inRoot.filter((p) => p.endsWith(".tf")).sort();
  if (listing.truncated) notes.push("The repository is too large to list in one call; some files may not have been read.");
  if (tfPaths.length > READ_LIMITS.maxTfFiles) {
    notes.push(`${tfPaths.length - READ_LIMITS.maxTfFiles} .tf files past the first ${READ_LIMITS.maxTfFiles} were not read.`);
    tfPaths = tfPaths.slice(0, READ_LIMITS.maxTfFiles);
  }
  const wanted = listing.paths.includes(lockPath) ? [...tfPaths, lockPath] : tfPaths;
  const results = await settleBounded(wanted, READ_LIMITS.concurrency, (path) =>
    client.readFile({ repo, path, ref, maxBytes: READ_LIMITS.maxBytes })
  );
  const tfFiles: { path: string; content: string }[] = [];
  let lockFile: string | null = null;
  results.forEach((r, i) => {
    const path = wanted[i]!;
    if (!r.ok) {
      if (r.error instanceof GitFileTooLarge) {
        notes.push(`${path} is over ${READ_LIMITS.maxBytes / 1024} KB and was not read.`);
        return;
      }
      throw r.error;
    }
    if (r.value === null) return;
    if (path === lockPath) lockFile = r.value;
    else tfFiles.push({ path, content: r.value });
  });
  if (tfPaths.length === 0) notes.push(`No .tf files in ${root || "the repository root"}.`);
  return factsFromFiles({ ref, path: root, tfFiles, lockFile, notes });
}

/** Claims, reads and stores one project's pins. False when another read
 *  claimed it first. */
export async function checkProjectVersions(project: ReadableProject, now = new Date(), clientFor: ClientFor = defaultClientFor): Promise<boolean> {
  const { count } = await prisma.tfProject.updateMany({
    where: { id: project.id, orgId: project.orgId, versionCheckedAt: project.versionCheckedAt },
    data: { versionCheckedAt: now },
  });
  if (count !== 1) return false;

  const ref = project.destBranch || null;
  const root = rootDirOf(project);
  const record = async (facts: StoredVersionFacts) => {
    await prisma.tfProject.updateMany({
      where: { id: project.id, orgId: project.orgId },
      data: { versionFacts: facts as unknown as Prisma.InputJsonValue },
    });
  };
  const problem = (message: string) => record({ ok: false, ref, path: root ?? "", problem: message });
  const hostName = project.gitHost === "gitlab" ? "GitLab" : "GitHub";

  if (root === null) {
    await problem("infralift could not tell which directory holds this stack's root module.");
    return true;
  }
  const conn = await prisma.providerConnection.findFirst({
    where: { orgId: project.orgId, provider: project.gitHost, ...(project.gitConnectionId ? { id: project.gitConnectionId } : {}) },
    orderBy: PREFER_USABLE_CONNECTION,
  });
  if (!conn) {
    await problem(`No ${hostName} connection to read the repository with.`);
    return true;
  }
  if (conn.status === "invalid") {
    await problem(`The ${hostName} connection is invalid; reconnect it under Connections to read versions.`);
    return true;
  }

  try {
    const client = clientFor(conn.provider, decryptToken(conn.encryptedToken));
    const branch = ref ?? (await client.defaultBranch(project.destRepo));
    await record(await readRepoVersions(client, project.destRepo, branch, root));
  } catch (err) {
    if (!(err instanceof GitCommitError)) throw err;
    if (err.rateLimited) return true;
    if (await markInvalidOnAuthFailure(conn, err, "git", "the version check")) {
      await problem(`${hostName} refused the connection; reconnect it under Connections to read versions.`);
      return true;
    }
    // GitHub down, a 404 on the branch: keep the message to the status.
    await problem(
      err.hostStatus === 404
        ? `${project.destRepo}@${ref ?? "default branch"} was not found. Check the repository and branch in the project's settings.`
        : `${hostName} could not be read just now${err.hostStatus ? ` (${err.hostStatus})` : ""}. infralift tries again on its next check.`
    );
  }
  return true;
}

// -- sweep ------------------------------------------------------------------

/** Projects due a read: a repository to read, never read or read more than an
 *  interval ago, oldest first. */
export async function dueForVersionCheck(now = new Date(), limit = VERSION_BATCH): Promise<ReadableProject[]> {
  return prisma.tfProject.findMany({
    where: {
      ...READABLE_WHERE,
      OR: [{ versionCheckedAt: null }, { versionCheckedAt: { lt: new Date(now.getTime() - VERSION_INTERVAL_MS) } }],
    },
    orderBy: { versionCheckedAt: { sort: "asc", nulls: "first" } },
    take: limit,
    select: READABLE_SELECT,
  });
}

/** One sweep: every due project, VERSION_CONCURRENCY at once. Returns how
 *  many were read. */
export async function sweepVersions(now = new Date(), clientFor?: ClientFor): Promise<number> {
  const due = await dueForVersionCheck(now);
  const results = await settleBounded(due, VERSION_CONCURRENCY, (p) => checkProjectVersions(p, now, clientFor));
  let n = 0;
  results.forEach((r, i) => {
    if (r.ok) n += r.value ? 1 : 0;
    else log.error({ err: r.error instanceof Error ? r.error.message : String(r.error), projectId: due[i]!.id }, "version check failed");
  });
  return n;
}

/** Starts the sweep for this process, a few minutes after boot and then every
 *  VERSION_SWEEP_EVERY_MS plus jitter. Unref'd. */
export function startVersionSweep(random: () => number = Math.random): void {
  const schedule = (base: number) => {
    setTimeout(() => {
      void sweepVersions()
        .catch((err) => log.error({ err }, "version sweep failed"))
        .finally(() => schedule(VERSION_SWEEP_EVERY_MS));
    }, base + Math.floor(random() * VERSION_SWEEP_JITTER_MS)).unref();
  };
  schedule(2 * 60_000);
}

// -- list -------------------------------------------------------------------

const LIST_SELECT = {
  id: true,
  name: true,
  source: true,
  orgId: true,
  destRepo: true,
  stackSlug: true,
  stackRelease: true,
  stackVersionId: true,
  versionFacts: true,
  versionCheckedAt: true,
  stackVersion: { select: { id: true, manifest: true, stackSourceId: true, source: { select: { orgId: true } } } },
} as const;

type ListRow = Prisma.TfProjectGetPayload<{ select: typeof LIST_SELECT }>;
type NewestVersion = { id: string; stackSourceId: string; manifest: Prisma.JsonValue };

const manifestVersion = (m: Prisma.JsonValue | undefined) =>
  m && typeof m === "object" && !Array.isArray(m) && typeof m.version === "string" ? m.version : null;

function stackItem(row: ListRow, newestBySource: Map<string, NewestVersion>): VersionItem | null {
  if (row.source !== "stack") return null;
  if (row.stackSlug) {
    const newest = getStack(row.stackSlug)?.version ?? null;
    return classifyRelease(
      row.stackRelease,
      newest,
      row.stackRelease ? "This stack is no longer in the catalog." : "Created before stack releases were recorded."
    );
  }
  const pinned = row.stackVersion;
  if (!pinned) return { name: "stack release", have: null, want: null, status: "unknown", note: "The stack version is missing." };
  // A stack another org published: only its published version is visible
  // here (lib/stacks/visibility.ts), so there is nothing fair to compare with.
  if (pinned.source.orgId !== row.orgId) {
    return { name: "stack release", have: manifestVersion(pinned.manifest), want: null, status: "unknown", note: "Not compared: the stack belongs to another organization." };
  }
  const newest = newestBySource.get(pinned.stackSourceId);
  if (!newest || newest.id === pinned.id) {
    return { name: "stack release", have: manifestVersion(pinned.manifest), want: manifestVersion(pinned.manifest), status: "current", note: null };
  }
  return classifyRelease(
    manifestVersion(pinned.manifest),
    manifestVersion(newest.manifest),
    "A newer version of this stack is recorded, but its stack.json has no release number to compare."
  );
}

function isFacts(v: Prisma.JsonValue | null): v is Prisma.JsonObject & StoredVersionFacts {
  return !!v && typeof v === "object" && !Array.isArray(v) && typeof (v as { ok?: unknown }).ok === "boolean";
}

function toProjectVersions(row: ListRow, newestBySource: Map<string, NewestVersion>): ProjectVersions {
  const stack = stackItem(row, newestBySource);
  const stored = isFacts(row.versionFacts) ? (row.versionFacts as unknown as StoredVersionFacts) : null;
  const facts = stored?.ok ? stored : null;
  const terraform = facts ? classifyRequiredVersion(facts, floorForKind(row.source)) : null;
  const providers = facts ? classifyProviders(facts) : [];
  const problem = stored && !stored.ok ? stored.problem : null;
  const notRead: VersionItem[] = !facts ? [{ name: "repository", have: null, want: null, status: "unknown", note: null }] : [];
  const status = worstStatus([...(stack ? [stack] : []), ...(terraform ? [terraform] : []), ...providers, ...notRead].map((i) => i.status));
  return {
    projectId: row.id,
    name: row.name,
    kind: row.source as ProjectKind,
    destRepo: row.destRepo,
    status,
    stack,
    terraform,
    providers,
    checkedAt: row.versionCheckedAt?.toISOString() ?? null,
    ref: stored?.ref ?? null,
    path: stored?.path ?? null,
    problem,
    notes: facts?.notes ?? [],
  };
}

/** The newest valid version of each of these team stack sources, from the
 *  org's own sources only. One query. */
async function newestVersions(orgId: string, rows: ListRow[]): Promise<Map<string, NewestVersion>> {
  const sourceIds = [...new Set(rows.flatMap((r) => (r.stackVersion && r.stackVersion.source.orgId === orgId ? [r.stackVersion.stackSourceId] : [])))];
  if (!sourceIds.length) return new Map();
  const versions = await prisma.stackVersion.findMany({
    where: { stackSourceId: { in: sourceIds }, valid: true, source: { orgId } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    distinct: ["stackSourceId"],
    select: { id: true, stackSourceId: true, manifest: true },
  });
  return new Map(versions.map((v) => [v.stackSourceId, v]));
}

/** The org's projects with their version lag, by name, one page at a time. */
export async function listProjectVersions(orgId: string, page: { limit: number; cursor?: string }): Promise<VersionsPage> {
  const rows = await prisma.tfProject.findMany({
    where: { orgId },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    take: page.limit + 1,
    ...(page.cursor ? { cursor: { id: page.cursor }, skip: 1 } : {}),
    select: LIST_SELECT,
  });
  const pageRows = rows.slice(0, page.limit);
  const newest = await newestVersions(orgId, pageRows);
  return {
    projects: pageRows.map((r) => toProjectVersions(r, newest)),
    nextCursor: rows.length > page.limit ? pageRows[pageRows.length - 1]!.id : null,
  };
}

/** One project's version lag. 404 for another org's project. */
export async function getProjectVersions(orgId: string, projectId: string): Promise<ProjectVersions> {
  const row = await prisma.tfProject.findFirst({ where: { id: projectId, orgId }, select: LIST_SELECT });
  if (!row) throw new NotFound("Project not found.");
  return toProjectVersions(row, await newestVersions(orgId, [row]));
}

/** Reads one project's repository now, whatever its interval, and returns
 *  the result. 429 past RATE_LIMITS.versionCheck for the org. */
export async function checkProjectVersionsNow(orgId: string, projectId: string, now = new Date(), clientFor?: ClientFor): Promise<ProjectVersions> {
  const project = await prisma.tfProject.findFirst({ where: { id: projectId, orgId, ...READABLE_WHERE }, select: READABLE_SELECT });
  if (!project) throw new NotFound("Project not found, or it has no repository to read yet.");
  await onDemand.check({ orgId }, now.getTime());
  await checkProjectVersions(project, now, clientFor);
  return getProjectVersions(orgId, projectId);
}
