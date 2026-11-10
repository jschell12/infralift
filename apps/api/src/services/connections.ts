import { PROVIDERS, PROVIDER_LABELS, type Provider, type ProviderConnectionSummary } from "@infralift/shared";
import { prisma } from "../lib/db.js";
import { decryptToken, encryptToken } from "../lib/crypto.js";
import { getConnector } from "../connectors/index.js";
import { ProviderHttpError, type VerifyResult } from "../connectors/types.js";
import { AppError, Conflict, InvalidBody, InvalidInput, NotFound } from "../lib/errors.js";
import { GitCommitError } from "../lib/git/errors.js";
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
  lastError: string | null;
  expiresAt: Date | null;
}

export function toSummary(c: ConnectionRow): ProviderConnectionSummary {
  return {
    id: c.id,
    provider: c.provider as Provider,
    label: c.label,
    createdAt: c.createdAt.toISOString(),
    lastVerifiedAt: c.lastVerifiedAt?.toISOString() ?? null,
    status: c.status as ProviderConnectionSummary["status"],
    lastError: c.lastError,
    expiresAt: c.expiresAt?.toISOString() ?? null,
  };
}

function providerLabel(provider: string): string {
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

/** Asks the provider whether a credential works. Never throws: a failure
 *  that is not the provider answering (a network error, a malformed key)
 *  becomes a reason that names no part of the credential. */
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
  const outcome = await checkCredential(input.provider, input.token);
  const connection = await prisma.providerConnection.create({
    data: {
      orgId,
      provider: input.provider,
      label: input.label,
      encryptedToken: encryptToken(input.token),
      status: outcome.valid ? "valid" : "invalid",
      lastVerifiedAt: outcome.valid ? new Date() : null,
      lastError: outcome.reason,
      expiresAt: outcome.expiresAt,
    },
  });
  return toSummary(connection);
}

/** Re-runs the provider's verify call and records what it said. */
export async function verifyConnection(orgId: string, id: string): Promise<ProviderConnectionSummary> {
  const connection = await findOwned(orgId, id);
  const outcome = await checkCredential(connection.provider, decryptToken(connection.encryptedToken));
  const updated = await prisma.providerConnection.update({
    where: { id: connection.id },
    data: outcome.valid
      ? { status: "valid", lastVerifiedAt: new Date(), lastError: null, expiresAt: outcome.expiresAt }
      : { status: "invalid", lastError: outcome.reason },
  });
  return toSummary(updated);
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
      lastError: null,
      expiresAt: outcome.expiresAt,
    },
  });
  return toSummary(updated);
}

/** Removes a connection and its stored credential. Refused while an
 *  assessment or a project still points at it (assessments by foreign key,
 *  projects by id), naming what to change first. */
export async function deleteConnection(orgId: string, id: string): Promise<void> {
  const connection = await findOwned(orgId, id);
  const [assessments, projects] = await Promise.all([
    prisma.assessment.count({ where: { connectionId: connection.id } }),
    prisma.tfProject.findMany({
      where: { orgId, OR: [{ gitConnectionId: connection.id }, { tfcConnectionId: connection.id }] },
      select: { name: true },
      take: 5,
    }),
  ]);
  if (assessments || projects.length) {
    const uses = [
      assessments ? `${assessments} assessment${assessments === 1 ? "" : "s"}` : null,
      projects.length ? `project${projects.length === 1 ? "" : "s"} ${projects.map((p) => p.name).join(", ")}` : null,
    ].filter(Boolean);
    throw new Conflict(
      `"${connection.label}" is still used by ${uses.join(" and ")}. Replace its credential instead, or point those at another connection first.`,
      { assessments, projects: projects.map((p) => p.name) }
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
