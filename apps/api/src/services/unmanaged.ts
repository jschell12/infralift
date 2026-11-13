import { randomUUID } from "node:crypto";
import type { ProviderConnection } from "@prisma/client";
import type {
  AdoptBackendDefaults,
  AdoptSelectedResult,
  CloudflareAccountRef,
  Provider,
  ResourceInventoryItem,
  UnmanagedPage,
  UnmanagedResource,
} from "@infralift/shared";
import { prisma } from "../lib/db.js";
import { decryptToken } from "../lib/crypto.js";
import { getConnector } from "../connectors/index.js";
import { AppError, Conflict, InvalidInput, NotFound, TooManyRequests, Upstream } from "../lib/errors.js";
import { CredentialFormatError } from "../connectors/types.js";
import { createRateLimiter } from "../lib/rate-limit.js";
import { adoptionTarget, isUsageLine, type AdoptBackend } from "../lib/import/adopt.js";
import { connectionSecret } from "./aws-access.js";
import { authFailureStatus, markInvalid, markInvalidOnAuthFailure, providerLabel } from "./connections.js";
import { openAdoption } from "./imports.js";
import { ledgerKey, managedKeys, projectConnection, type LedgerKey } from "./managed-resources.js";

// ---------------------------------------------------------------------------
// "Adopt from an account" (ADR 0010, starting point 1): what is in a
// connection's account that no project manages, and adopting a selection of it.
//
//   listUnmanaged   the account's live inventory, read through the same
//                   connector an assessment uses, minus the ledger
//                   (services/managed-resources.ts), one page at a time
//   adoptSelected   the picked resources, looked up in that inventory (never
//                   taken from the request), into the adoption pipeline
//                   services/imports.ts openAdoption already runs for an
//                   assessment: import blocks, a pull request, a saved-plan
//                   apply on merge (ADR 0008). No second apply path.
//
// The inventory is cached per connection for INVENTORY_TTL_MS, so paging and
// reloading do not call the provider again; ?refresh=1 skips the cache. Reads
// that do reach the provider are limited per org (CLOUD_READS_PER_WINDOW),
// in-process like every limiter here (lib/rate-limit.ts): a second API
// replica would mean a second bucket and a second cache.
// ---------------------------------------------------------------------------

/** How long one inventory of an account is reused. */
export const INVENTORY_TTL_MS = 5 * 60 * 1000;
/** Accounts whose inventory is held at once; the oldest goes first. */
export const INVENTORY_CACHE_ENTRIES = 100;
/** Page size: the default and the most a caller may ask for. */
export const UNMANAGED_PAGE_SIZE = 100;
export const UNMANAGED_PAGE_MAX = 200;
/** Resources one adoption request may pick. */
export const ADOPT_MAX_RESOURCES = 200;

// A provider inventory is the slowest call a page load can make, and it is
// rate limited by the provider. It never includes cost data (assess with
// costs: false), so AWS Cost Explorer, which bills per request, is not called.
// Cache hits are free.
const CLOUD_READS_PER_WINDOW = 10;
const CLOUD_READ_WINDOW_MS = 10 * 60 * 1000;
const cloudReads = createRateLimiter({ windowMs: CLOUD_READ_WINDOW_MS, max: CLOUD_READS_PER_WINDOW });

// -- inventory cache ------------------------------------------------------------

interface CachedInventory {
  orgId: string;
  fetchedAt: number;
  items: ResourceInventoryItem[];
}

const cache = new Map<string, CachedInventory>();
// One provider read per account at a time: a second tab, or a page request
// while the first is still waiting, shares the first read.
const inFlight = new Map<string, Promise<CachedInventory>>();

/** The cache key moves with the credential: replacing it (rotateConnection
 *  bumps updatedAt) means the next read uses the new one. */
const cacheKey = (c: Pick<ProviderConnection, "id" | "updatedAt">) => `${c.id}:${c.updatedAt.getTime()}`;

/** For tests. */
export function resetUnmanagedState(): void {
  cache.clear();
  inFlight.clear();
  cloudReads.reset();
}

function remember(key: string, entry: CachedInventory, now: number): void {
  for (const [k, v] of cache) if (now - v.fetchedAt >= INVENTORY_TTL_MS) cache.delete(k);
  cache.delete(key);
  cache.set(key, entry);
  // Map keeps insertion order, so the first key is the oldest read.
  while (cache.size > INVENTORY_CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
}

/** The `code` on a 409 that says the account cannot be read with the stored
 *  credential, and replacing it is the fix. The dashboard links to the
 *  connection's Replace drawer when it sees it (lib/adopt-account.ts). */
export const CONNECTION_CREDENTIAL = "connection_credential";

/** A failed inventory read, as the response the caller gets. The message is
 *  ours, built from the provider's name and the kind of credential expected;
 *  the provider's own text goes to the log only, since it can quote a request
 *  (and so a key). Pure, so the mapping is tested without a connector.
 *
 *    the credential is not the kind the provider takes     409, marked invalid
 *    the provider refused it (401/403)                     409, marked invalid
 *    anything else (an outage, a timeout, a bug)           502 with a request id
 */
export function inventoryFailure(connection: Pick<ProviderConnection, "id" | "provider">, err: unknown, requestId: string): AppError {
  const fix = { code: CONNECTION_CREDENTIAL, connectionId: connection.id };
  if (err instanceof CredentialFormatError) {
    return new Conflict(
      `infralift couldn't read this account: the saved credential isn't ${err.expected}. Replace it on Connections.`,
      fix
    );
  }
  const status = authFailureStatus(err, "connector");
  if (status) {
    return new Conflict(
      `infralift couldn't read this account: ${providerLabel(connection.provider)} refused the saved credential. Replace it on Connections.`,
      fix
    );
  }
  return new Upstream("Could not read the account's resources", { requestId });
}

/** Calls the connector, read-only, with the same deadlines and failure
 *  handling as an assessment run (routes/assessments.ts): a credential the
 *  provider refused (401/403), or one that is not the kind it takes, marks
 *  the connection invalid, and the provider's own message goes to the log,
 *  never the response. */
async function readInventory(connection: ProviderConnection): Promise<ResourceInventoryItem[]> {
  // AWS: the org's external id; 422 when AWS is off on this server.
  const secret = await connectionSecret(connection.orgId, connection.provider, decryptToken(connection.encryptedToken));
  try {
    // Inventory only: no cost calls, which on AWS are billed per request.
    const { inventory } = await getConnector(connection.provider as Provider).assess(secret, { costs: false });
    return inventory;
  } catch (err) {
    if (err instanceof CredentialFormatError) {
      await markInvalid(connection.id, `the saved credential isn't ${err.expected}; replace it`).catch((markErr) =>
        console.error(`could not mark connection ${connection.id} invalid:`, markErr)
      );
    } else {
      await markInvalidOnAuthFailure(connection, err, "connector", "an inventory of the account");
    }
    const requestId = randomUUID();
    const message = err instanceof Error ? err.message : String(err);
    console.error(`inventory of connection ${connection.id} failed (${connection.provider}) [request ${requestId}]: ${message}`);
    throw inventoryFailure(connection, err, requestId);
  }
}

/** The account's inventory: from the cache when fresh and not refreshed,
 *  otherwise from the provider, counted against the org's limit. */
export async function accountInventory(
  connection: ProviderConnection,
  opts: { refresh?: boolean; now?: number } = {}
): Promise<CachedInventory> {
  const now = opts.now ?? Date.now();
  const key = cacheKey(connection);
  const hit = cache.get(key);
  if (hit && hit.orgId === connection.orgId && !opts.refresh && now - hit.fetchedAt < INVENTORY_TTL_MS) return hit;

  const pending = inFlight.get(key);
  if (pending) return pending;
  if (cloudReads.limited(connection.orgId, now)) {
    throw new TooManyRequests("Too many reads of your cloud accounts. Wait a few minutes and try again.");
  }
  const read = readInventory(connection)
    .then((items) => {
      const entry = { orgId: connection.orgId, fetchedAt: now, items };
      remember(key, entry, now);
      return entry;
    })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, read);
  return read;
}

// -- the unmanaged view -----------------------------------------------------------

/** Inventory minus ledger, as the view lists it, in a stable order: by type,
 *  then provider id. Usage lines are billing figures, not resources, and are
 *  left out. A resource the connector listed twice is listed once. Pure, so
 *  the subtraction is tested without a database. */
export function subtractManaged(provider: Provider, inventory: ResourceInventoryItem[], managed: Set<string>): UnmanagedResource[] {
  const seen = new Set<string>();
  const out: UnmanagedResource[] = [];
  for (const item of inventory) {
    if (isUsageLine(item)) continue;
    const key = ledgerKey({ type: item.type, providerId: item.externalId });
    if (managed.has(key) || seen.has(key)) continue;
    seen.add(key);
    const target = adoptionTarget(provider, item);
    out.push({
      type: item.type,
      providerId: item.externalId,
      name: item.name,
      region: item.region ?? null,
      ...("reason" in target
        ? { adoptable: false, reason: target.reason, terraformType: null }
        : { adoptable: true, reason: null, terraformType: target.to.split(".")[0]! }),
    });
  }
  return out.sort((a, b) => compareKeys(a, b));
}

const CLOUDFLARE_ACCOUNT_ID = /^[a-f0-9]{32}$/;

/** The Cloudflare accounts an inventory found resources in, in the order
 *  first seen, each with the first name recorded for it. The connector puts
 *  accountId (and accountName) in each account-scoped item's metadata. An
 *  account with nothing in it is not listed: the inventory never saw it. */
export function cloudflareAccountsOf(inventory: ResourceInventoryItem[]): CloudflareAccountRef[] {
  const byId = new Map<string, CloudflareAccountRef>();
  for (const item of inventory) {
    if (item.provider !== "cloudflare") continue;
    const id = item.metadata?.accountId;
    if (typeof id !== "string" || !CLOUDFLARE_ACCOUNT_ID.test(id)) continue;
    const name = typeof item.metadata?.accountName === "string" && item.metadata.accountName.trim() ? item.metadata.accountName.trim() : null;
    const seen = byId.get(id);
    if (!seen) byId.set(id, { id, name });
    else if (!seen.name && name) seen.name = name;
  }
  return [...byId.values()];
}

/** The region most of an AWS inventory's regional resources are in; ties go
 *  to the alphabetically first. Global resources (IAM, CloudFront, Route 53)
 *  carry no region in their ARN and are left out. */
export function commonAwsRegion(inventory: ResourceInventoryItem[]): string | null {
  const counts = new Map<string, number>();
  for (const item of inventory) {
    if (item.provider !== "aws" || isUsageLine(item)) continue;
    const arn = typeof item.metadata?.arn === "string" ? item.metadata.arn : item.externalId;
    const region = arn.startsWith("arn:") ? arn.split(":")[3] : item.region;
    if (!region) continue;
    counts.set(region, (counts.get(region) ?? 0) + 1);
  }
  let best: string | null = null;
  for (const [region, n] of [...counts].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (best === null || n > counts.get(best)!) best = region;
  }
  return best;
}

/** What the adopt form can fill in from the inventory instead of asking. */
export function backendDefaultsOf(provider: Provider, inventory: ResourceInventoryItem[]): AdoptBackendDefaults {
  return {
    cloudflareAccounts: provider === "cloudflare" ? cloudflareAccountsOf(inventory) : [],
    awsRegion: provider === "aws" ? commonAwsRegion(inventory) : null,
  };
}

/** An R2 backend sent without an account id gets the connection's Cloudflare
 *  account when the inventory found exactly one. With several, which one holds
 *  the bucket is the caller's to say. Anything else is returned unchanged and
 *  validateBackend (lib/import/adopt.ts) judges it. */
export function withKnownAccount(provider: Provider, backend: AdoptBackend, inventory: ResourceInventoryItem[]): AdoptBackend {
  if (backend.kind !== "r2" || backend.accountId?.trim() || provider !== "cloudflare") return backend;
  const accounts = cloudflareAccountsOf(inventory);
  if (accounts.length === 1) return { ...backend, accountId: accounts[0]!.id };
  if (accounts.length > 1) {
    throw new InvalidInput(`accountId: this connection sees ${accounts.length} Cloudflare accounts; say which one holds the state bucket`);
  }
  return backend;
}

function compareKeys(a: LedgerKey, b: LedgerKey): number {
  if (a.type !== b.type) return a.type < b.type ? -1 : 1;
  if (a.providerId !== b.providerId) return a.providerId < b.providerId ? -1 : 1;
  return 0;
}

/** A cursor is the last row's key, base64url, so a page boundary survives the
 *  inventory changing between requests (an offset would skip or repeat). */
export const encodeCursor = (k: LedgerKey) => Buffer.from(JSON.stringify([k.type, k.providerId])).toString("base64url");

function decodeCursor(cursor: string): LedgerKey {
  try {
    const [type, providerId] = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown[];
    if (typeof type === "string" && typeof providerId === "string") return { type, providerId };
  } catch {
    // fall through
  }
  throw new InvalidInput("cursor is not one this list returned");
}

/** One page of the rows after `cursor`. */
export function pageAfter(rows: UnmanagedResource[], limit: number, cursor?: string) {
  const after = cursor ? decodeCursor(cursor) : null;
  const start = after ? rows.findIndex((r) => compareKeys(r, after) > 0) : 0;
  const from = start === -1 ? rows.length : start;
  const page = rows.slice(from, from + limit);
  const last = page[page.length - 1];
  return { page, nextCursor: from + limit < rows.length && last ? encodeCursor(last) : null };
}

export async function listUnmanaged(
  orgId: string,
  connectionId: string,
  opts: { limit: number; cursor?: string; refresh?: boolean; now?: number }
): Promise<UnmanagedPage & { nextCursor: string | null }> {
  const connection = await projectConnection(orgId, connectionId);
  const inventory = await accountInventory(connection, { refresh: opts.refresh, now: opts.now });
  const managed = await managedKeys(orgId, connection.id);
  const rows = subtractManaged(connection.provider as Provider, inventory.items, managed);
  const { page, nextCursor } = pageAfter(rows, opts.limit, opts.cursor);
  return {
    connectionId: connection.id,
    provider: connection.provider as Provider,
    fetchedAt: new Date(inventory.fetchedAt).toISOString(),
    total: rows.length,
    adoptable: rows.filter((r) => r.adoptable).length,
    resources: page,
    backendDefaults: backendDefaultsOf(connection.provider as Provider, inventory.items),
    nextCursor,
  };
}

// -- adopt a selection ----------------------------------------------------------------

export type AdoptTarget =
  | {
      kind: "new";
      name: string;
      repo: string;
      ref?: string;
      /** The org's GitHub connection to open the pull request with. */
      gitConnectionId?: string;
      path: string;
      backend: AdoptBackend;
    }
  | { kind: "existing"; projectId: string };

export interface AdoptSelectedInput {
  resources: LedgerKey[];
  target: AdoptTarget;
  refresh?: boolean;
}

/** Picks the requested resources out of the live inventory. Anything not in
 *  it, already managed, or not adoptable is refused by name, so a stale page
 *  or a hand-made request cannot adopt something the view would not offer. */
function pickResources(provider: Provider, inventory: ResourceInventoryItem[], managed: Set<string>, wanted: LedgerKey[]) {
  const byKey = new Map(inventory.filter((i) => !isUsageLine(i)).map((i) => [ledgerKey({ type: i.type, providerId: i.externalId }), i]));
  const picked: ResourceInventoryItem[] = [];
  const missing: LedgerKey[] = [];
  const taken: LedgerKey[] = [];
  const refused: (LedgerKey & { reason: string })[] = [];
  for (const k of new Map(wanted.map((w) => [ledgerKey(w), w])).values()) {
    const item = byKey.get(ledgerKey(k));
    if (!item) missing.push(k);
    else if (managed.has(ledgerKey(k))) taken.push(k);
    else {
      const target = adoptionTarget(provider, item);
      if ("reason" in target) refused.push({ ...k, reason: target.reason });
      else picked.push(item);
    }
  }
  if (missing.length) throw new InvalidInput("some picked resources are not in the account any more; reload the list", { missing });
  if (taken.length) throw new Conflict("some picked resources are already managed by a project", { managed: taken });
  if (refused.length) throw new InvalidInput("some picked resources cannot be adopted yet", { refused });
  return picked;
}

/** The same request sent again (a double click, a retry after a timeout):
 *  the project it made, if that project is exactly this adoption. Anything
 *  else with the name falls through to the name conflict. */
async function replayOf(orgId: string, connectionId: string, target: Extract<AdoptTarget, { kind: "new" }>, wanted: LedgerKey[]) {
  const project = await prisma.tfProject.findFirst({
    where: { orgId, name: target.name, source: "imported", providerConnectionId: connectionId, destRepo: target.repo },
    include: { managedResources: { select: { resourceType: true, providerId: true } } },
  });
  if (!project || project.destPath !== target.path.replace(/^\/+|\/+$/g, "")) return null;
  const have = new Set(project.managedResources.map((r) => ledgerKey({ type: r.resourceType, providerId: r.providerId })));
  const want = new Set(wanted.map(ledgerKey));
  if (have.size !== want.size || [...want].some((k) => !have.has(k))) return null;
  const job = await prisma.tfJob.findFirst({ where: { projectId: project.id, kind: "import" }, orderBy: { createdAt: "desc" } });
  return { project, job, adopted: want.size };
}

export async function adoptSelected(orgId: string, connectionId: string, input: AdoptSelectedInput): Promise<AdoptSelectedResult & { replayed: boolean }> {
  const connection = await projectConnection(orgId, connectionId);
  if (!input.resources.length) throw new InvalidInput("pick at least one resource");
  if (input.resources.length > ADOPT_MAX_RESOURCES) throw new InvalidInput(`pick at most ${ADOPT_MAX_RESOURCES} resources at a time`);

  const { target } = input;
  if (target.kind === "existing") {
    await refuseExistingTarget(orgId, connection.id, target.projectId);
    // refuseExistingTarget always throws; see its comment.
  }
  const newTarget = target as Extract<AdoptTarget, { kind: "new" }>;

  const replay = await replayOf(orgId, connection.id, newTarget, input.resources);
  if (replay) return toResult(replay.project, replay.job, replay.adopted, true);

  const provider = connection.provider as Provider;
  const inventory = await accountInventory(connection, { refresh: input.refresh });
  const managed = await managedKeys(orgId, connection.id);
  const picked = pickResources(provider, inventory.items, managed, input.resources);
  const backend = withKnownAccount(provider, newTarget.backend, inventory.items);

  const open = () => openAdoption(orgId, {
    repo: newTarget.repo,
    ref: newTarget.ref,
    connectionId: newTarget.gitConnectionId,
    name: newTarget.name,
    path: newTarget.path,
    backend,
    provider,
    inventory: picked,
    // Provider settings come from the whole account: the google provider's
    // project is the gcp:project / firebase:project item, which has no
    // import of its own and so is never picked.
    settingsInventory: inventory.items,
    assessmentId: null,
    providerConnectionId: connection.id,
  });
  let opened;
  try {
    opened = await open();
  } catch (err) {
    // Two identical requests at once both miss replayOf above, and the one
    // that loses on the project name lands here. If the winner made exactly
    // this adoption, answer as a replay rather than 409.
    if (err instanceof Conflict) {
      const raced = await replayOf(orgId, connection.id, newTarget, input.resources);
      if (raced) return toResult(raced.project, raced.job, raced.adopted, true);
    }
    throw err;
  }
  return toResult(opened.project, opened.job, opened.adopted, false);
}

function toResult(
  project: { id: string; name: string },
  job: { id: string; status: string } | null,
  adopted: number,
  replayed: boolean
): AdoptSelectedResult & { replayed: boolean } {
  return { projectId: project.id, projectName: project.name, jobId: job?.id ?? null, jobStatus: job?.status ?? null, adopted, replayed };
}

/**
 * Adding resources to a project that already exists. The project has to be
 * the caller's (404 otherwise) and manage this same account (409), and then it
 * is refused anyway, 409, because the pipeline cannot do it yet: the import
 * check generates resource code once, into generated.tf, and never generates
 * over it (lib/import/check.ts), so an import block added afterwards would
 * have no code and its plan would fail. Generating each batch into a file of
 * its own is the change that lifts this. The checks run first so a client
 * gets the specific refusal for a wrong project before the general one.
 */
async function refuseExistingTarget(orgId: string, connectionId: string, projectId: string): Promise<never> {
  const project = await prisma.tfProject.findFirst({
    where: { id: projectId, orgId },
    select: { id: true, name: true, providerConnectionId: true },
  });
  if (!project) throw new NotFound("Project not found");
  if (project.providerConnectionId !== connectionId) {
    throw new Conflict(`project ${project.name} does not manage this account; a project manages one account (ADR 0010)`);
  }
  throw new Conflict(
    `adding resources to project ${project.name} is not supported yet: its import check generates code once and would not generate it for new imports. Adopt them into a new project.`
  );
}
