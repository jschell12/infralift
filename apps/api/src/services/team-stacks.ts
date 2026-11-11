import { Prisma } from "@prisma/client";
import { isGitHost, PROVIDER_LABELS } from "@infralift/shared";
import { prisma } from "../lib/db.js";
import { decryptToken } from "../lib/crypto.js";
import { Conflict, InvalidInput, NotFound, Upstream } from "../lib/errors.js";
import { GitCommitError } from "../lib/git/errors.js";
import { gitHostClient, type GitHostClient } from "../lib/git/hosts.js";
import { listStacks, stackGitHosts, type StackManifest } from "../lib/stacks/index.js";
import { isStackDir, loadTeamStack, StackFetchError, type TeamStackLoad } from "../lib/stacks/team.js";
import {
  originFor,
  transitionFor,
  visibleWhere,
  type VisibilityAction,
} from "../lib/stacks/visibility.js";

// ---------------------------------------------------------------------------
// Team stacks (ADR 0009): stacks an org keeps in its own repository, beside the
// catalog's. An org registers one from repo + ref, infralift pins the commit
// and checks it (lib/stacks/team.ts), and each later ref is a new version.
// Private to the org; publishing to every org needs an infralift admin's
// approval, and only the reviewed version is shown to others.
//
//   registerStack / addStackVersion   read and check a commit, store it
//   listVisibleStacks / getStack      catalog + own + approved community
//   requestPublish / withdrawStack    the owner's side of publishing
//   listPendingStacks / approveStack / revokeStack   the admin's side
// ---------------------------------------------------------------------------

export type ClientFor = (host: "github" | "gitlab", token: string) => GitHostClient;
const defaultClient: ClientFor = (host, token) => gitHostClient(host, token);

export interface RegisterInput {
  connectionId: string;
  repo: string;
  ref: string;
  path: string;
}

const versionSelect = {
  id: true,
  ref: true,
  resolvedSha: true,
  manifest: true,
  files: true,
  valid: true,
  validation: true,
  createdAt: true,
} satisfies Prisma.StackVersionSelect;

type VersionRow = Prisma.StackVersionGetPayload<{ select: typeof versionSelect }>;

function summary(m: StackManifest | null) {
  if (!m) return null;
  return {
    slug: m.slug,
    name: m.name,
    description: m.description,
    target: m.target,
    runtime: m.runtime,
    deliveries: m.deliveries,
    gitHosts: stackGitHosts(m),
    modules: m.modules ?? [],
  };
}

function versionView(v: VersionRow) {
  return {
    id: v.id,
    ref: v.ref,
    resolvedSha: v.resolvedSha,
    valid: v.valid,
    validation: v.validation,
    files: v.files,
    stack: summary(v.manifest as unknown as StackManifest | null),
    createdAt: v.createdAt,
  };
}

/** The org's connection and a client for it. The connection's provider is
 *  the stack's git host. */
async function connectionClient(orgId: string, connectionId: string, clientFor: ClientFor) {
  const conn = await prisma.providerConnection.findFirst({ where: { id: connectionId, orgId } });
  if (!conn) throw new InvalidInput("connection not found");
  if (!isGitHost(conn.provider)) {
    throw new InvalidInput(`${PROVIDER_LABELS[conn.provider as keyof typeof PROVIDER_LABELS] ?? conn.provider} is not a git host`);
  }
  return { gitHost: conn.provider, client: clientFor(conn.provider, decryptToken(conn.encryptedToken)) };
}

async function load(client: GitHostClient, repo: string, dir: string, ref: string): Promise<TeamStackLoad> {
  try {
    return await loadTeamStack(client, { repo, dir, ref });
  } catch (err) {
    if (err instanceof StackFetchError) throw new InvalidInput(err.message);
    if (err instanceof GitCommitError) throw new Upstream(err.message);
    throw err;
  }
}

function versionData(ref: string, loaded: TeamStackLoad) {
  return {
    ref,
    resolvedSha: loaded.sha,
    manifest: loaded.manifest ? (loaded.manifest as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
    files: loaded.files as unknown as Prisma.InputJsonValue,
    contents: loaded.valid ? loaded.contents : Prisma.DbNull,
    valid: loaded.valid,
    validation: loaded.valid ? { renderedFiles: loaded.renderedFiles } : { errors: loaded.errors },
  };
}

function checkLocation(repo: string, path: string) {
  if (!/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)+$/.test(repo) || repo.split("/").includes("..")) {
    throw new InvalidInput("repo is owner/name (or group/subgroup/name on GitLab)");
  }
  if (!isStackDir(path)) throw new InvalidInput("path is a directory in the repository, relative, with no ..");
}

// -- register and version ------------------------------------------------------

export async function registerStack(orgId: string, input: RegisterInput, clientFor = defaultClient) {
  const path = input.path.replace(/^\/+|\/+$/g, "");
  checkLocation(input.repo, path);
  const { gitHost, client } = await connectionClient(orgId, input.connectionId, clientFor);
  const loaded = await load(client, input.repo, path, input.ref);
  try {
    const source = await prisma.stackSource.create({
      data: {
        orgId,
        gitHost,
        connectionId: input.connectionId,
        repo: input.repo,
        path,
        versions: { create: versionData(input.ref, loaded) },
      },
      include: { versions: { select: versionSelect } },
    });
    return { ...sourceView(source, "org"), versions: source.versions.map(versionView) };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw new Conflict(`${input.repo}${path ? `/${path}` : ""} is already one of your stacks; add a version to it`);
    }
    throw err;
  }
}

/** A new version from `ref`. Existing versions keep the commit they pinned. */
export async function addStackVersion(orgId: string, sourceId: string, input: { ref: string }, clientFor = defaultClient) {
  const source = await prisma.stackSource.findFirst({ where: { id: sourceId, orgId } });
  if (!source) throw new NotFound("stack not found");
  const { gitHost, client } = await connectionClient(orgId, source.connectionId, clientFor);
  if (gitHost !== source.gitHost) throw new InvalidInput("the stack's connection no longer points at its git host");
  const loaded = await load(client, source.repo, source.path, input.ref);
  try {
    const version = await prisma.stackVersion.create({
      data: { stackSourceId: source.id, ...versionData(input.ref, loaded) },
      select: versionSelect,
    });
    return versionView(version);
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw new Conflict(`${input.ref} is ${loaded.sha.slice(0, 7)}, which is already a version of this stack`);
    }
    throw err;
  }
}

// -- read ------------------------------------------------------------------------

interface SourceRow {
  id: string;
  orgId: string;
  gitHost: string;
  repo: string;
  path: string;
  visibility: string;
  publishedVersionId: string | null;
  publishedAt: Date | null;
  reviewedAt: Date | null;
  createdAt: Date;
}

/** What an org sees of a source. Visibility and review are the owner's
 *  business; another org sees where the stack comes from and nothing else. */
function sourceView(s: SourceRow, origin: "org" | "community") {
  const base = { id: s.id, origin, gitHost: s.gitHost, repo: s.repo, path: s.path };
  if (origin === "community") return base;
  return {
    ...base,
    visibility: s.visibility,
    publishedVersionId: s.publishedVersionId,
    publishedAt: s.publishedAt,
    reviewedAt: s.reviewedAt,
    createdAt: s.createdAt,
  };
}

export type StackListing =
  | { origin: "infralift"; id: string; stack: ReturnType<typeof summary> }
  | (ReturnType<typeof sourceView> & { stack: ReturnType<typeof summary>; version: ReturnType<typeof versionView> | null });

/** The catalog, the org's own stacks (newest version), and community stacks
 *  (the reviewed version). One shape, `origin` says which. */
export async function listVisibleStacks(orgId: string): Promise<StackListing[]> {
  const catalog: StackListing[] = listStacks().map((m) => ({
    origin: "infralift" as const,
    id: `catalog:${m.slug}`,
    stack: summary(m),
  }));
  const sources = await prisma.stackSource.findMany({
    where: visibleWhere(orgId),
    include: { versions: { select: versionSelect, orderBy: { createdAt: "desc" } } },
    orderBy: { createdAt: "asc" },
  });
  const team: StackListing[] = [];
  for (const s of sources) {
    const origin = originFor(orgId, s);
    if (!origin) continue;
    const v = origin === "org" ? s.versions[0] : s.versions.find((x) => x.id === s.publishedVersionId);
    const version = v ? versionView(v) : null;
    team.push({ ...sourceView(s, origin), stack: version?.stack ?? null, version });
  }
  return [...catalog, ...team];
}

/** One stack: every version for its owner, the reviewed one for anyone else. */
export async function getTeamStack(orgId: string, id: string) {
  const s = await prisma.stackSource.findFirst({
    where: { id, ...visibleWhere(orgId) },
    include: { versions: { select: versionSelect, orderBy: { createdAt: "desc" } } },
  });
  const origin = s ? originFor(orgId, s) : null;
  if (!s || !origin) throw new NotFound("stack not found");
  const versions = origin === "org" ? s.versions : s.versions.filter((v) => v.id === s.publishedVersionId);
  return { ...sourceView(s, origin), versions: versions.map(versionView) };
}

// -- publishing ---------------------------------------------------------------------

const DONE: Record<VisibilityAction, string> = {
  request: "published",
  withdraw: "withdrawn",
  approve: "approved",
  revoke: "revoked",
};

/** Moves a source's visibility only if it is still in a state `action` may
 *  start from, in one statement, so two requests cannot both win. */
async function transition(
  where: { id: string; orgId?: string },
  action: VisibilityAction,
  data: Prisma.StackSourceUpdateManyMutationInput
) {
  const t = transitionFor(action);
  const res = await prisma.stackSource.updateMany({
    where: { ...where, visibility: { in: t.from } },
    data: { ...data, visibility: t.to },
  });
  if (res.count === 0) {
    const current = await prisma.stackSource.findFirst({ where, select: { visibility: true } });
    if (!current) throw new NotFound("stack not found");
    throw new Conflict(`the stack is ${current.visibility.replace("_", " ")}, so it cannot be ${DONE[action]}`);
  }
  return { id: where.id, visibility: t.to };
}

/** Asks for `versionId` (default: the newest valid one) to be shown to every
 *  org. Nothing is shown until an admin approves. */
export async function requestPublish(orgId: string, id: string, input: { versionId?: string }) {
  const source = await prisma.stackSource.findFirst({ where: { id, orgId }, select: { id: true } });
  if (!source) throw new NotFound("stack not found");
  const version = await prisma.stackVersion.findFirst({
    where: { stackSourceId: id, valid: true, ...(input.versionId ? { id: input.versionId } : {}) },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  if (!version) throw new InvalidInput(input.versionId ? "that version is not a valid version of this stack" : "the stack has no valid version to publish");
  return transition({ id, orgId }, "request", {
    publishedVersionId: version.id,
    publishedAt: new Date(),
    reviewedBy: null,
    reviewedAt: null,
  });
}

export async function withdrawStack(orgId: string, id: string) {
  return transition({ id, orgId }, "withdraw", { publishedVersionId: null, publishedAt: null });
}

// -- admin ----------------------------------------------------------------------------

/** Every org's stacks waiting for review, with the version under review. */
export async function listPendingStacks() {
  const sources = await prisma.stackSource.findMany({
    where: { visibility: "pending_public" },
    include: { versions: { select: versionSelect } },
    orderBy: { publishedAt: "asc" },
  });
  return sources.map((s) => {
    const v = s.versions.find((x) => x.id === s.publishedVersionId);
    return { ...sourceView(s, "org"), orgId: s.orgId, version: v ? versionView(v) : null };
  });
}

export async function approveStack(id: string, reviewer: string) {
  return transition({ id }, "approve", { reviewedBy: reviewer, reviewedAt: new Date() });
}

export async function revokeStack(id: string, reviewer: string) {
  return transition({ id }, "revoke", { reviewedBy: reviewer, reviewedAt: new Date() });
}
