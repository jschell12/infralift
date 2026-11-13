import { PROVIDERS, PROVIDER_LABELS, type Provider, type ProviderConnectionSummary } from "@infralift/shared";
import { prisma } from "../lib/db.js";
import { decryptToken, encryptToken } from "../lib/crypto.js";
import { getConnector } from "../connectors/index.js";
import { ProviderHttpError, type VerifyResult } from "../connectors/types.js";
import { AppError, Conflict, InvalidBody, InvalidInput, NotFound, Unprocessable } from "../lib/errors.js";
import { AwsNotEnabledError } from "../connectors/aws.js";
import { connectionSecret } from "./aws-access.js";
import { GitCommitError } from "../lib/git/errors.js";
import { HttpTimeoutError } from "../lib/http.js";
import { TfcClient, TfcClientError, tfcBaseUrl } from "../lib/tf/tfc-client.js";
import { TFC_PROVIDER } from "../lib/tf/tfc-connection.js";
import { UnsafeHostError, assertPublicHost, tfcCredentialSchema } from "../lib/tf/extensions.js";

// ---------------------------------------------------------------------------
// A connection's life after it is added: verify it again, replace its
// credential, remove it, and mark it invalid when a provider refuses it
// mid-job. Every lookup is by id AND orgId, so another org's id is a 404.
//
// Nothing here returns a credential, and no reason stored in lastError comes
// from a response body that could echo one: reasons are a status code plus,
// for Cloudflare and GitHub, the provider's own short error message.
// ---------------------------------------------------------------------------

interface ConnectionRow {
  id: string;
  provider: string;
  label: string;
  status: string;
  createdAt: Date;
  lastVerifiedAt: Date | null;
  lastCheckedAt: Date | null;
  verifyingSince: Date | null;
  lastError: string | null;
  expiresAt: Date | null;
}

/** How long a check's claim on a connection holds. Longer than any check
 *  takes, queue wait included (CHECK_CONCURRENCY slots, VERIFY_TIMEOUT_MS
 *  each), so it only lapses when the process holding it is gone. */
export const CHECK_CLAIM_MS = 10 * 60 * 1000;

const STATUSES: readonly ProviderConnectionSummary["status"][] = ["unverified", "valid", "invalid"];

/** The status as the API reports it: one of the three words. A row saying
 *  anything else (production had "connected", written outside the API) was
 *  never checked, so it is unverified. Migration 0030 rewrote those rows and
 *  constrains the column; this keeps a stray word from reaching a client. */
export function normalizeStatus(status: string): ProviderConnectionSummary["status"] {
  return (STATUSES as readonly string[]).includes(status) ? (status as ProviderConnectionSummary["status"]) : "unverified";
}

/** True while a live claim says a check is running. */
export function isChecking(c: Pick<ConnectionRow, "verifyingSince">, now = Date.now()): boolean {
  return c.verifyingSince !== null && now - c.verifyingSince.getTime() < CHECK_CLAIM_MS;
}

export function toSummary(c: ConnectionRow, now = Date.now()): ProviderConnectionSummary {
  return {
    id: c.id,
    provider: c.provider as Provider,
    label: c.label,
    createdAt: c.createdAt.toISOString(),
    lastVerifiedAt: c.lastVerifiedAt?.toISOString() ?? null,
    lastCheckedAt: c.lastCheckedAt?.toISOString() ?? null,
    checking: isChecking(c, now),
    status: normalizeStatus(c.status),
    lastError: c.lastError,
    expiresAt: c.expiresAt?.toISOString() ?? null,
  };
}

export function providerLabel(provider: string): string {
  if (provider === TFC_PROVIDER) return "Terraform Cloud";
  return PROVIDER_LABELS[provider as Provider] ?? provider;
}

async function checkTfc(secret: string): Promise<VerifyResult> {
  const cred = tfcCredentialSchema.parse(JSON.parse(secret));
  try {
    await assertPublicHost(cred.hostname);
  } catch (err) {
    if (err instanceof UnsafeHostError) return { valid: false, reason: err.message, expiresAt: null };
    throw err;
  }
  const client = new TfcClient(cred.token, cred.organization, tfcBaseUrl(cred.hostname));
  return (await client.canReadOrganization())
    ? { valid: true, reason: null, expiresAt: null }
    : { valid: false, reason: `this token cannot read the organization ${cred.organization}`, expiresAt: null };
}

/** httpFetch's deadline (HttpTimeoutError), a body read past it, or an AWS
 *  SDK request timeout. */
function isTimeout(err: unknown): boolean {
  const name = (err as { name?: unknown } | null)?.name;
  return err instanceof HttpTimeoutError || name === "TimeoutError" || name === "RequestTimeout";
}

/** Asks the provider whether a credential works. Never throws, except when
 *  AWS is off on this server (422): a failure that is not the provider
 *  answering (a network error, a malformed key) becomes a reason that names
 *  no part of the credential. */
export async function checkCredential(provider: string, secret: string): Promise<VerifyResult> {
  const label = providerLabel(provider);
  try {
    if (provider === TFC_PROVIDER) return await checkTfc(secret);
    if (!(PROVIDERS as readonly string[]).includes(provider)) {
      return { valid: false, reason: `${provider} connections cannot be verified`, expiresAt: null };
    }
    const connector = getConnector(provider as Provider);
    if (connector.check) return await connector.check(secret);
    const valid = await connector.verify(secret);
    return { valid, reason: valid ? null : `${label} did not accept this credential`, expiresAt: null };
  } catch (err) {
    if (err instanceof AwsNotEnabledError) throw new Unprocessable(err.message);
    // A timeout says nothing about the credential: report it, mark nothing.
    if (isTimeout(err)) {
      return { valid: false, reason: `${label} did not answer in time; try again`, expiresAt: null, timedOut: true };
    }
    // JSON.parse and zod messages can quote the input, which is the secret.
    const status = err instanceof ProviderHttpError ? err.status : err instanceof TfcClientError ? err.statusCode : null;
    return {
      valid: false,
      reason: status ? `${label} answered ${status}` : `could not reach ${label} to verify this credential`,
      expiresAt: null,
    };
  }
}

async function findOwned(orgId: string, id: string) {
  const connection = await prisma.providerConnection.findFirst({ where: { id, orgId } });
  if (!connection) throw new NotFound("Not found");
  return connection;
}

export async function createConnection(
  orgId: string,
  input: { provider: Provider; label: string; token: string }
): Promise<ProviderConnectionSummary> {
  const secret = await connectionSecret(orgId, input.provider, input.token);
  const outcome = await checkCredential(input.provider, secret);
  const connection = await prisma.providerConnection.create({
    data: {
      orgId,
      provider: input.provider,
      label: input.label,
      encryptedToken: encryptToken(secret),
      status: outcome.valid ? "valid" : outcome.timedOut ? "unverified" : "invalid",
      lastVerifiedAt: outcome.valid ? new Date() : null,
      lastCheckedAt: new Date(),
      lastError: outcome.reason,
      expiresAt: outcome.expiresAt,
    },
  });
  return toSummary(connection);
}

// -- checking a connection again ----------------------------------------------
//
// One check = claim, ask the provider, record, release. A person's "Verify
// now" (verifyConnection) and the automatic checks (services/connection-
// checks.ts) both go through runCheck, so they cannot verify one connection
// twice at once:
//
//   claim     a conditional UPDATE setting verifyingSince where it is null or
//             older than CHECK_CLAIM_MS, as the job queue claims a job; the row
//             count is the verdict, so two processes cannot both hold it
//   share     in this process, a second caller for the same connection gets
//             the first caller's promise rather than a second claim attempt
//   record    the outcome and lastCheckedAt, clearing the claim in the same
//             write. A provider that does not answer within the deadline
//             counts as a timeout: the reason is recorded, the status kept.

/** Deadline for one provider's verify call. httpFetch has its own per-call
 *  deadlines (lib/http.ts); this bounds the whole check, which for AWS is
 *  two STS calls and for Google a token exchange. */
export const VERIFY_TIMEOUT_MS: Record<string, number> = { default: 20_000, aws: 30_000 };

export function verifyTimeoutFor(provider: string): number {
  return VERIFY_TIMEOUT_MS[provider] ?? VERIFY_TIMEOUT_MS.default;
}

/** The fields a check's outcome writes. Pure, so the mapping is tested
 *  without a database. Always releases the claim. */
export function outcomeData(outcome: VerifyResult, now: Date) {
  const checked = { lastCheckedAt: now, verifyingSince: null };
  if (outcome.valid) {
    return { ...checked, status: "valid", lastVerifiedAt: now, lastError: null, expiresAt: outcome.expiresAt };
  }
  // A timeout says nothing about the credential: keep the status.
  if (outcome.timedOut) return { ...checked, lastError: outcome.reason };
  return { ...checked, status: "invalid", lastError: outcome.reason };
}

/** Takes the check claim on a connection. False when a live claim exists. */
export async function claimCheck(id: string, now = new Date()): Promise<boolean> {
  const { count } = await prisma.providerConnection.updateMany({
    where: { id, OR: [{ verifyingSince: null }, { verifyingSince: { lt: new Date(now.getTime() - CHECK_CLAIM_MS) } }] },
    data: { verifyingSince: now },
  });
  return count === 1;
}

/** checkCredential, bounded by the provider's deadline. */
async function checkWithDeadline(provider: string, secret: string, timeoutMs: number): Promise<VerifyResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<VerifyResult>((resolve) => {
    timer = setTimeout(
      () => resolve({ valid: false, reason: `${providerLabel(provider)} did not answer in time; try again`, expiresAt: null, timedOut: true }),
      timeoutMs
    );
  });
  try {
    return await Promise.race([checkCredential(provider, secret), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

type FullConnection = NonNullable<Awaited<ReturnType<typeof prisma.providerConnection.findFirst>>>;

/** Runs a check on a connection this caller claimed at `claimedAt` (the
 *  time claimCheck wrote), then releases the claim. Returns the row as
 *  written, or null when the row is gone or the claim is no longer this
 *  caller's.
 *
 *  A check can wait for a slot after its claim (checkStaleForOrg claims
 *  before queueing). If the claim could lapse before the provider answers,
 *  it does not call the provider at all; and every write is conditional on
 *  verifyingSince still being `claimedAt`, so a check whose claim was taken
 *  over never overwrites the newer one. When the check cannot run (AWS off on
 *  this server, 422), it records only that it was checked, so the daily check
 *  does not retry it every sweep, and rethrows. */
export async function runClaimedCheck(
  connection: FullConnection,
  claimedAt: Date,
  opts: { timeoutMs?: number } = {}
): Promise<FullConnection | null> {
  const timeoutMs = opts.timeoutMs ?? verifyTimeoutFor(connection.provider);
  if (Date.now() - claimedAt.getTime() > CHECK_CLAIM_MS - timeoutMs) return null;
  const mine = { id: connection.id, verifyingSince: claimedAt };
  const now = new Date();
  let outcome: VerifyResult;
  try {
    const secret = await connectionSecret(connection.orgId, connection.provider, decryptToken(connection.encryptedToken));
    outcome = await checkWithDeadline(connection.provider, secret, timeoutMs);
  } catch (err) {
    await prisma.providerConnection.updateMany({ where: mine, data: { lastCheckedAt: now, verifyingSince: null } });
    throw err;
  }
  const { count } = await prisma.providerConnection.updateMany({ where: mine, data: outcomeData(outcome, now) });
  if (count !== 1) return null;
  return prisma.providerConnection.findFirst({ where: { id: connection.id } });
}

/** Checks in progress in this process, by connection id. */
const checksInFlight = new Map<string, Promise<FullConnection | null>>();

/** Claims and checks a connection. Resolves to the row as written, or null
 *  when another process holds the claim or the row is gone. A second call
 *  while the first runs shares it. */
export function runCheck(connection: FullConnection, opts: { now?: Date; timeoutMs?: number } = {}): Promise<FullConnection | null> {
  const running = checksInFlight.get(connection.id);
  if (running) return running;
  const work = (async () => {
    const claimedAt = opts.now ?? new Date();
    if (!(await claimCheck(connection.id, claimedAt))) return null;
    return runClaimedCheck(connection, claimedAt, { timeoutMs: opts.timeoutMs });
  })().finally(() => checksInFlight.delete(connection.id));
  checksInFlight.set(connection.id, work);
  return work;
}

/** "Verify now": re-runs the provider's verify call and records what it
 *  said. When a check is already running elsewhere, returns the connection
 *  as it stands, with checking: true, rather than starting a second. */
export async function verifyConnection(orgId: string, id: string): Promise<ProviderConnectionSummary> {
  const connection = await findOwned(orgId, id);
  const checked = await runCheck(connection);
  return toSummary(checked ?? (await findOwned(orgId, id)));
}

export interface RotateInput {
  token: string;
  /** Terraform Cloud only; default: what the connection has now. */
  organization?: string;
  hostname?: string;
}

/** Replaces a connection's credential, but only with one that verifies. A
 *  credential that does not is refused with the provider's reason, and the
 *  stored one, its status and its error are left exactly as they were. */
export async function rotateConnection(orgId: string, id: string, input: RotateInput): Promise<ProviderConnectionSummary> {
  const connection = await findOwned(orgId, id);
  let secret = input.token;
  if (connection.provider === TFC_PROVIDER) {
    const current = tfcCredentialSchema.parse(JSON.parse(decryptToken(connection.encryptedToken)));
    const cred = tfcCredentialSchema.safeParse({
      hostname: input.hostname || current.hostname,
      organization: input.organization || current.organization,
      token: input.token,
    });
    if (!cred.success) throw new InvalidBody(cred.error.flatten());
    secret = JSON.stringify(cred.data);
  }
  secret = await connectionSecret(orgId, connection.provider, secret);

  const outcome = await checkCredential(connection.provider, secret);
  if (!outcome.valid) {
    throw new InvalidInput(`The new credential did not verify, so the current one was kept: ${outcome.reason}`, {
      reason: outcome.reason,
    });
  }
  const updated = await prisma.providerConnection.update({
    where: { id: connection.id },
    data: {
      encryptedToken: encryptToken(secret),
      status: "valid",
      lastVerifiedAt: new Date(),
      lastCheckedAt: new Date(),
      lastError: null,
      expiresAt: outcome.expiresAt,
    },
  });
  return toSummary(updated);
}

/** Removes a connection and its stored credential. Refused while an
 *  assessment or a project still points at it (assessments by foreign key,
 *  projects by id, or as the account they manage), naming what to change
 *  first. A project that manages the account also holds its ledger rows,
 *  which the foreign key would refuse to orphan. */
export async function deleteConnection(orgId: string, id: string): Promise<void> {
  const connection = await findOwned(orgId, id);
  const [assessments, projects, stacks] = await Promise.all([
    prisma.assessment.count({ where: { connectionId: connection.id } }),
    prisma.tfProject.findMany({
      where: {
        orgId,
        OR: [{ gitConnectionId: connection.id }, { tfcConnectionId: connection.id }, { providerConnectionId: connection.id }],
      },
      select: { name: true },
      take: 5,
    }),
    prisma.stackSource.count({ where: { orgId, connectionId: connection.id } }),
  ]);
  if (assessments || projects.length || stacks) {
    const uses = [
      assessments ? `${assessments} assessment${assessments === 1 ? "" : "s"}` : null,
      stacks ? `${stacks} stack${stacks === 1 ? "" : "s"}` : null,
      projects.length ? `project${projects.length === 1 ? "" : "s"} ${projects.map((p) => p.name).join(", ")}` : null,
    ].filter(Boolean);
    throw new Conflict(
      `"${connection.label}" is still used by ${uses.join(" and ")}. Replace its credential instead, or point those at another connection first.`,
      { assessments, stacks, projects: projects.map((p) => p.name) }
    );
  }
  await prisma.providerConnection.delete({ where: { id: connection.id } });
}

/** Marks a connection invalid with a short reason. A no-op for an id that
 *  no longer exists. */
export async function markInvalid(connectionId: string, reason: string): Promise<void> {
  await prisma.providerConnection.updateMany({
    where: { id: connectionId },
    data: { status: "invalid", lastError: reason.slice(0, 200) },
  });
}

/** Which errors count as the provider refusing the credential: a 401 or 403
 *  from the provider the connection is for. A 5xx, a 404, a network error or
 *  an error from some other system (TFC inside a git job) does not. */
export type AuthSource = "connector" | "git";

export function authFailureStatus(err: unknown, source: AuthSource): number | null {
  let status: unknown = null;
  if (source === "git" && err instanceof GitCommitError) status = err.hostStatus;
  // ProviderHttpError, or a collectors Error carrying the same field.
  // AppError.status is our own response code, not the provider's.
  if (source === "connector" && err instanceof Error && !(err instanceof AppError)) {
    status = (err as { status?: unknown }).status;
  }
  return status === 401 || status === 403 ? status : null;
}

/** Calls markInvalid when `err` is an auth failure. Never throws, so the
 *  caller's own failure handling still runs. True when it marked. */
export async function markInvalidOnAuthFailure(
  connection: { id: string; provider: string } | null,
  err: unknown,
  source: AuthSource,
  during: string
): Promise<boolean> {
  const status = connection ? authFailureStatus(err, source) : null;
  if (!connection || !status) return false;
  try {
    await markInvalid(connection.id, `${providerLabel(connection.provider)} refused the credential (${status}) during ${during}`);
    return true;
  } catch (markErr) {
    console.error(`could not mark connection ${connection.id} invalid:`, markErr);
    return false;
  }
}
