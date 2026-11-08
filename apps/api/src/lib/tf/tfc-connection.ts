import { prisma } from "../db.js";
import { decryptToken } from "../crypto.js";
import { assertPublicHost, tfcCredentialSchema, type TfcCredential } from "./extensions.js";
import { tfcBaseUrl } from "./tfc-client.js";
import { TfCloudWorkspaceAdapter } from "./workspace.js";

// A project's Terraform Cloud workspace lives in the customer's own HCP
// Terraform / TFE organization, reached through one of the org's "tfc"
// connections (added under Connections, or via /workspaces/connections).
// infralift's own TFC organization is never used for a customer project; the
// operator's projects get a connection like anyone else's.

export const TFC_PROVIDER = "tfc";

export class TfcConnectionError extends Error {}

/** The org-scoped connection's credential, host-checked. Throws
 *  TfcConnectionError when it is missing or points somewhere private. */
export async function loadTfcConnection(orgId: string, connectionId: string): Promise<TfcCredential> {
  const conn = await prisma.providerConnection.findFirst({
    where: { id: connectionId, orgId, provider: TFC_PROVIDER },
  });
  if (!conn) throw new TfcConnectionError("Terraform Cloud connection not found: pick one under Connections");
  const cred = tfcCredentialSchema.parse(JSON.parse(decryptToken(conn.encryptedToken)));
  try {
    await assertPublicHost(cred.hostname);
  } catch (err) {
    throw new TfcConnectionError(err instanceof Error ? err.message : String(err));
  }
  return cred;
}

/** A workspace adapter for that connection's organization. */
export async function tfcAdapterFor(
  orgId: string,
  connectionId: string
): Promise<{ adapter: TfCloudWorkspaceAdapter; cred: TfcCredential }> {
  const cred = await loadTfcConnection(orgId, connectionId);
  return { adapter: new TfCloudWorkspaceAdapter(cred.token, cred.organization, tfcBaseUrl(cred.hostname)), cred };
}
