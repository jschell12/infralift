import type { TfcOAuthTokenSummary, TfcRunSummary } from "@infralift/shared";
import { prisma } from "../lib/db.js";
import { AppError, Conflict, InvalidInput, NotFound, Unprocessable, Upstream } from "../lib/errors.js";
import { TfcClient, TfcClientError, tfcBaseUrl, type TfcRun } from "../lib/tf/tfc-client.js";
import { TfcConnectionError, loadTfcConnectionRow } from "../lib/tf/tfc-connection.js";
import { markInvalid } from "./connections.js";

// ---------------------------------------------------------------------------
// Terraform Cloud runs for an org's workspaces, and the VCS link that makes a
// merge plan. Every lookup is by id AND orgId, so another org's workspace or
// connection is a 404. A 401 from TFC marks the connection invalid, so the
// Connections page says why it stopped working.
// ---------------------------------------------------------------------------

type Loaded = Awaited<ReturnType<typeof loadTfcConnectionRow>>;

async function connection(orgId: string, connectionId: string) {
  let loaded: Loaded;
  try {
    loaded = await loadTfcConnectionRow(orgId, connectionId);
  } catch (err) {
    if (!(err instanceof TfcConnectionError)) throw err;
    if (err.message.includes("not found")) throw new NotFound("connection not found");
    throw new InvalidInput(err.message);
  }
  const { conn, cred } = loaded;
  return { conn, cred, client: new TfcClient(cred.token, cred.organization, tfcBaseUrl(cred.hostname)) };
}

async function workspace(orgId: string, id: string) {
  const ws = await prisma.workspace.findFirst({ where: { id, orgId } });
  if (!ws) throw new NotFound("workspace not found");
  if (!ws.connectionId || !ws.tfcWorkspaceId) {
    throw new Conflict("workspace is not linked to a Terraform Cloud workspace");
  }
  return { ws, tfcWorkspaceId: ws.tfcWorkspaceId, ...(await connection(orgId, ws.connectionId)) };
}

/** Runs `fn` against TFC; anything it throws that is not ours becomes a 502,
 *  and a 401 also marks the connection invalid. */
async function tfc<T>(conn: { id: string }, during: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AppError) throw err;
    if (err instanceof TfcClientError) {
      if (err.statusCode === 401) {
        try {
          await markInvalid(conn.id, `Terraform Cloud refused the credential (401) during ${during}`);
        } catch (markErr) {
          console.error(`could not mark connection ${conn.id} invalid:`, markErr);
        }
        throw new Upstream("Terraform Cloud refused this connection's token. Replace it under Connections.", {
          connectionId: conn.id,
        });
      }
      // Not the body: it can echo request detail.
      throw new Upstream(`Terraform Cloud returned ${err.statusCode} for ${err.method} ${err.path}`);
    }
    console.error("terraform cloud call failed:", err);
    throw new Upstream("could not complete the request to Terraform Cloud");
  }
}

function summary(r: TfcRun): TfcRunSummary {
  const { workspaceId: _ws, ...rest } = r;
  return rest;
}

// -- VCS connection ------------------------------------------------------------

function noVcsProvider(cred: { hostname: string; organization: string }): Unprocessable {
  return new Unprocessable(
    `The Terraform Cloud organization ${cred.organization} has no VCS provider connected. ` +
      `Add one at https://${cred.hostname}/app/${cred.organization}/settings/version-control, then try again.`
  );
}

/** The org's VCS OAuth tokens and which one this connection links through. */
export async function listOAuthTokens(
  orgId: string,
  connectionId: string
): Promise<{ tokens: TfcOAuthTokenSummary[]; selected: string | null }> {
  const t = await connection(orgId, connectionId);
  const tokens = await tfc(t.conn, "listing VCS connections", () => t.client.listOAuthTokens());
  if (!tokens.length) throw noVcsProvider(t.cred);
  return { tokens, selected: t.conn.vcsOauthTokenId };
}

/** Records which VCS token new workspaces are linked through. Only one the
 *  organization actually has. */
export async function selectOAuthToken(orgId: string, connectionId: string, oauthTokenId: string): Promise<{ selected: string }> {
  const { tokens } = await listOAuthTokens(orgId, connectionId);
  if (!tokens.some((x) => x.id === oauthTokenId)) {
    throw new InvalidInput("that VCS connection is not in this Terraform Cloud organization");
  }
  await prisma.providerConnection.update({ where: { id: connectionId }, data: { vcsOauthTokenId: oauthTokenId } });
  return { selected: oauthTokenId };
}

export interface LinkInput {
  repo: string;
  branch?: string;
  workingDirectory?: string;
  oauthTokenId?: string;
}

/**
 * Links an infralift-created workspace to its repository, so pushes to the
 * branch plan. Adopted workspaces are the customer's own and keep their
 * workflow; a workspace already linked is left alone.
 */
export async function linkRepository(orgId: string, id: string, input: LinkInput) {
  const t = await workspace(orgId, id);
  if (t.ws.kind === "adopted") {
    throw new Conflict("adopted workspaces keep their own settings: link it in Terraform Cloud");
  }
  if (t.ws.vcsRepo) throw new Conflict(`workspace is already linked to ${t.ws.vcsRepo}`);
  const tokenId = input.oauthTokenId
    ? (await selectOAuthToken(orgId, t.conn.id, input.oauthTokenId)).selected
    : t.conn.vcsOauthTokenId;
  if (!tokenId) {
    await listOAuthTokens(orgId, t.conn.id); // 422 when the org has none
    throw new InvalidInput("pick a VCS connection to link through");
  }
  const remote = await tfc(t.conn, "linking a repository", () =>
    t.client.linkWorkspaceRepo(
      t.tfcWorkspaceId,
      { identifier: input.repo, oauthTokenId: tokenId, branch: input.branch ?? "" },
      input.workingDirectory
    )
  );
  const updated = await prisma.workspace.update({
    where: { id: t.ws.id },
    data: { vcsRepo: remote.vcsRepo ?? input.repo, workingDirectory: remote.workingDirectory },
  });
  return { id: updated.id, vcsRepo: updated.vcsRepo, workingDirectory: updated.workingDirectory };
}

// -- runs ----------------------------------------------------------------------

/** The latest runs, newest first. Records the newest on the workspace. */
export async function listRuns(orgId: string, id: string): Promise<TfcRunSummary[]> {
  const t = await workspace(orgId, id);
  const runs = await tfc(t.conn, "listing runs", () => t.client.listRuns(t.tfcWorkspaceId));
  const latest = runs[0];
  if (latest && (latest.status !== t.ws.lastRunStatus || t.ws.lastRunAt?.toISOString() !== new Date(latest.createdAt).toISOString())) {
    await prisma.workspace.update({
      where: { id: t.ws.id },
      data: { lastRunStatus: latest.status, lastRunAt: new Date(latest.createdAt) },
    });
  }
  return runs.map(summary);
}

export async function queueRun(orgId: string, id: string, input: { message?: string; planOnly?: boolean }): Promise<TfcRunSummary> {
  const t = await workspace(orgId, id);
  const run = await tfc(t.conn, "queueing a run", async () => {
    try {
      return await t.client.createRun(t.tfcWorkspaceId, input.message || "Queued from infralift", { planOnly: input.planOnly });
    } catch (err) {
      // An API-driven workspace with nothing uploaded has no configuration.
      if (err instanceof TfcClientError && err.statusCode === 422) {
        throw new Conflict("Terraform Cloud has no configuration for this workspace yet: link a repository so it can fetch one");
      }
      throw err;
    }
  });
  await prisma.workspace.update({
    where: { id: t.ws.id },
    data: { lastRunStatus: run.status, lastRunAt: new Date(run.createdAt) },
  });
  return summary(run);
}

/** A run of this workspace, or 404: a run id from another workspace in the
 *  same TFC organization is not reachable through this one. */
async function ownRun(t: Awaited<ReturnType<typeof workspace>>, runId: string, during: string) {
  const run = await tfc(t.conn, during, async () => {
    try {
      return await t.client.getRun(runId);
    } catch (err) {
      if (err instanceof TfcClientError && err.statusCode === 404) throw new NotFound("run not found");
      throw err;
    }
  });
  if (run.workspaceId !== t.tfcWorkspaceId) throw new NotFound("run not found");
  return run;
}

/**
 * Applies a run that is waiting for confirmation. `confirm` must be the
 * workspace's name, typed by the person applying it, and TFC must say the
 * run is confirmable at the moment we ask.
 */
export async function applyRun(orgId: string, id: string, runId: string, input: { confirm: string; comment?: string }) {
  const t = await workspace(orgId, id);
  if (input.confirm !== t.ws.name) {
    throw new InvalidInput(`type the workspace name "${t.ws.name}" to apply this run`);
  }
  const run = await ownRun(t, runId, "applying a run");
  if (!run.isConfirmable) throw new Conflict(`this run is ${run.status} and cannot be applied`);
  await tfc(t.conn, "applying a run", () => t.client.applyRun(run.id, input.comment || "Applied from infralift"));
  return { id: run.id, status: "confirmed" };
}

export async function discardRun(orgId: string, id: string, runId: string, input: { comment?: string }) {
  const t = await workspace(orgId, id);
  const run = await ownRun(t, runId, "discarding a run");
  if (!run.isDiscardable) throw new Conflict(`this run is ${run.status} and cannot be discarded`);
  await tfc(t.conn, "discarding a run", () => t.client.discardRun(run.id, input.comment || "Discarded from infralift"));
  return { id: run.id, status: "discarded" };
}
