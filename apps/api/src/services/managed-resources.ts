import { isGitHost, PROVIDERS, type Provider } from "@infralift/shared";
import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/db.js";
import { Conflict, InvalidInput, NotFound } from "../lib/errors.js";
import { isUniqueViolation } from "../lib/prisma-errors.js";

// ---------------------------------------------------------------------------
// The managed-resource ledger (ADR 0011): which project manages which cloud
// resource, keyed by the connector's identity for it, so the unmanaged view
// can subtract it from a live inventory.
//
//   projectConnection   a connection a project may manage: the caller's org,
//                       a cloud provider (not a git host or Terraform Cloud)
//   managedKeys         every resource a connection's projects manage or
//                       have reserved, as keys
//   refuseManagedElsewhere / reserve
//                       an adoption claims its resources when its pull request
//                       opens (pending); the unique index refuses a second
//                       owner even when two requests race
//   confirmAdoption / releaseAdoption
//                       the check passed (managed), or the pull request was
//                       closed unmerged (the project's rows are deleted)
//
// Only adoption writes rows. A repository import knows resource types and
// counts from HCL (lib/import/scan.ts) but not provider ids, and its check
// reports a count, not ids. A stack creates new resources whose ids exist only
// after the customer's apply, in their state, which infralift never reads
// (ADR 0001). Neither can say which inventory items it manages, so neither
// writes a row rather than guessing one.
// ---------------------------------------------------------------------------

/** One resource's place in the ledger: the inventory type and the provider's
 *  id for it (InventoryItem.type and externalId). */
export interface LedgerKey {
  type: string;
  providerId: string;
}

/** A ledger key as one string, for sets. The separator cannot occur in either
 *  part: both come from provider APIs as printable text. */
export const ledgerKey = (k: LedgerKey) => `${k.type}\u0000${k.providerId}`;

/** A cloud provider a project can manage: one with a connector that is not a
 *  git host. Terraform Cloud is where state lives, not an account. */
export function isCloudProvider(provider: string): provider is Provider {
  return (PROVIDERS as readonly string[]).includes(provider) && !isGitHost(provider);
}

/** The caller's own connection, or NotFound: another org's id gets the same
 *  answer as one that does not exist. Every write of a project's
 *  providerConnectionId goes through this, so a project can only ever name a
 *  connection of its own org. */
export async function ownedConnection(orgId: string, connectionId: string) {
  const connection = await prisma.providerConnection.findFirst({ where: { id: connectionId, orgId } });
  if (!connection) throw new NotFound("Connection not found");
  return connection;
}

/** The caller's connection, for use as a project's account: their own, and a
 *  cloud account rather than a git host or Terraform Cloud. */
export async function projectConnection(orgId: string, connectionId: string) {
  const connection = await ownedConnection(orgId, connectionId);
  if (!isCloudProvider(connection.provider)) {
    throw new InvalidInput(`a ${connection.provider} connection is not a cloud account a project can manage`);
  }
  return connection;
}

/** Keys of everything this connection's projects manage or have reserved.
 *  Two columns only: a large account's ledger is read on every page. */
export async function managedKeys(orgId: string, providerConnectionId: string): Promise<Set<string>> {
  const rows = await prisma.managedResource.findMany({
    where: { orgId, providerConnectionId },
    select: { resourceType: true, providerId: true },
  });
  return new Set(rows.map((r) => ledgerKey({ type: r.resourceType, providerId: r.providerId })));
}

/** Refuses resources another project already manages or has reserved, naming
 *  them and the project. A read before the insert, for the message; the
 *  unique index in reserve() is what actually stops two owners. */
export async function refuseManagedElsewhere(orgId: string, providerConnectionId: string, provider: string, keys: LedgerKey[]) {
  if (!keys.length) return;
  const taken = await prisma.managedResource.findMany({
    where: {
      orgId,
      providerConnectionId,
      provider,
      OR: keys.map((k) => ({ resourceType: k.type, providerId: k.providerId })),
    },
    select: { resourceType: true, providerId: true, project: { select: { name: true } } },
    take: 20,
  });
  if (taken.length) throw alreadyManaged(taken.map((t) => ({ type: t.resourceType, providerId: t.providerId, project: t.project.name })));
}

function alreadyManaged(taken: { type: string; providerId: string; project?: string }[]): Conflict {
  const projects = [...new Set(taken.map((t) => t.project).filter(Boolean))];
  return new Conflict(
    projects.length
      ? `${taken.length === 1 ? "a resource you picked is" : "resources you picked are"} already managed by project ${projects.join(", ")}`
      : "a resource you picked is already managed by another project",
    { managed: taken }
  );
}

export interface Reservation {
  orgId: string;
  projectId: string;
  providerConnectionId: string;
  provider: string;
  resources: (LedgerKey & { terraformAddress: string })[];
}

/** Records an adoption's resources as pending, inside the caller's
 *  transaction, so a refusal rolls back the project and job with it. A unique
 *  violation means another project got one of them first: 409. */
export async function reserve(tx: Prisma.TransactionClient, r: Reservation): Promise<void> {
  if (!r.resources.length) return;
  try {
    await tx.managedResource.createMany({
      data: r.resources.map((res) => ({
        orgId: r.orgId,
        projectId: r.projectId,
        providerConnectionId: r.providerConnectionId,
        provider: r.provider,
        resourceType: res.type,
        providerId: res.providerId,
        terraformAddress: res.terraformAddress,
        source: "adopted",
        status: "pending",
      })),
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw alreadyManaged([]);
    throw err;
  }
}

/** The adoption's import check passed: its plan imports these resources and
 *  changes nothing. Pending rows become managed. Idempotent: the check is read
 *  on every poll, and rows already managed are left as they are. */
export async function confirmAdoption(orgId: string, projectId: string, now = new Date()): Promise<number> {
  const { count } = await prisma.managedResource.updateMany({
    where: { orgId, projectId, status: "pending" },
    data: { status: "managed", adoptedAt: now },
  });
  return count;
}

/** The adoption's pull request was closed without merging: the apply that
 *  imports on merge (ADR 0008) will never run, so the project's rows are
 *  deleted, managed ones included, and the resources show as unmanaged
 *  again. An adoption project has one adoption pull request. Reopening it
 *  does not restore the rows; adopt the resources again. */
export async function releaseAdoption(orgId: string, projectId: string): Promise<number> {
  const { count } = await prisma.managedResource.deleteMany({ where: { orgId, projectId } });
  return count;
}
