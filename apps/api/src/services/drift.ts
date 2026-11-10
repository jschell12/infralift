import { prisma } from "../lib/db.js";
import { decryptToken } from "../lib/crypto.js";
import { PREFER_USABLE_CONNECTION } from "../lib/connection-order.js";
import { gitHostClient, type GitHostClient } from "../lib/git/hosts.js";
import { GitCommitError } from "../lib/git/errors.js";
import { DRIFT_JOB_NAME } from "../lib/import/contract.js";
import { classifyDrift } from "../lib/import/result.js";
import { markInvalidOnAuthFailure } from "./connections.js";

// ---------------------------------------------------------------------------
// Drift: did someone change the infrastructure outside Terraform?
//
// The customer's own CI answers that. The import check workflow and the
// stack's infra.yml both run a read-only plan of the default branch every day
// as the `infra drift` check (lib/import/contract.ts). This sweep reads the
// newest of those runs for each project with a GitHub repository, at most
// once per DRIFT_INTERVAL_MS, and records what it said on the project and on
// the project's workspaces. infralift never plans anything itself. A 401 or
// 403 from GitHub marks the connection invalid, as a job would.
//
//   claim     a conditional UPDATE on driftCheckedAt, as the job queue claims
//             a job (lib/jobs/queue.ts), so a project is read once per interval
//             even if two processes sweep
//   read      the newest drift run on the last few commits of the branch: a
//             commit pushed since the morning's run has none of its own
//   record    on the project, by id and org; on its workspaces, by project and
//             org. Unknown leaves a workspace's driftDetected as it was.
// ---------------------------------------------------------------------------

export const DRIFT_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** Commits back from the head to look for a drift run. */
export const DRIFT_COMMITS = 5;
/** Projects read per sweep tick. */
export const DRIFT_BATCH = 10;

type ClientFor = (host: string, token: string) => GitHostClient;

interface DriftProject {
  id: string;
  orgId: string;
  destRepo: string;
  destBranch: string;
  gitConnectionId: string | null;
  driftCheckedAt: Date | null;
}

/** Projects due a read: stack and imported projects in a GitHub repository,
 *  never read or last read more than an interval ago, oldest first. */
export async function dueForDrift(now = new Date(), limit = DRIFT_BATCH): Promise<DriftProject[]> {
  return prisma.tfProject.findMany({
    where: {
      source: { in: ["stack", "imported"] },
      gitHost: "github",
      destRepo: { not: "" },
      createRepo: false,
      OR: [{ driftCheckedAt: null }, { driftCheckedAt: { lt: new Date(now.getTime() - DRIFT_INTERVAL_MS) } }],
    },
    orderBy: { driftCheckedAt: { sort: "asc", nulls: "first" } },
    take: limit,
    select: { id: true, orgId: true, destRepo: true, destBranch: true, gitConnectionId: true, driftCheckedAt: true },
  });
}

/** Reads and records one project's drift. False when another sweep claimed it first. */
export async function checkProjectDrift(
  project: DriftProject,
  now = new Date(),
  clientFor: ClientFor = (host, token) => gitHostClient(host === "gitlab" ? "gitlab" : "github", token)
): Promise<boolean> {
  const { count } = await prisma.tfProject.updateMany({
    where: { id: project.id, orgId: project.orgId, driftCheckedAt: project.driftCheckedAt },
    data: { driftCheckedAt: now },
  });
  if (count !== 1) return false;

  const record = async (state: string, message: string, checkUrl: string | null = null, ranAt: string | null = null) => {
    await prisma.tfProject.updateMany({
      where: { id: project.id, orgId: project.orgId },
      data: { driftState: state, driftMessage: message.slice(0, 500), driftCheckUrl: checkUrl, driftRanAt: ranAt ? new Date(ranAt) : null },
    });
    if (state === "drift" || state === "none") {
      await prisma.workspace.updateMany({
        where: { projectId: project.id, orgId: project.orgId },
        data: { driftDetected: state === "drift" },
      });
    }
  };

  const conn = await prisma.providerConnection.findFirst({
    where: { orgId: project.orgId, provider: "github", ...(project.gitConnectionId ? { id: project.gitConnectionId } : {}) },
    orderBy: PREFER_USABLE_CONNECTION,
  });
  if (!conn) {
    await record("unknown", "No GitHub connection to read the drift check with.");
    return true;
  }
  if (conn.status === "invalid") {
    await record("unknown", "The GitHub connection is invalid; reconnect it under Connections to read the drift check.");
    return true;
  }

  try {
    const client = clientFor(conn.provider, decryptToken(conn.encryptedToken));
    let run = null;
    for (const sha of await client.listCommits({ repo: project.destRepo, branch: project.destBranch, limit: DRIFT_COMMITS })) {
      run = await client.getCheckRun({ repo: project.destRepo, sha, name: DRIFT_JOB_NAME });
      if (run) break;
    }
    const result = classifyDrift(run, project.destBranch);
    await record(result.state, result.message, result.checkUrl, result.ranAt);
  } catch (err) {
    if (!(err instanceof GitCommitError)) throw err;
    if (await markInvalidOnAuthFailure(conn, err, "git", "the drift check")) {
      await record("unknown", "GitHub refused the connection; reconnect it under Connections to read the drift check.");
    }
    // Anything else (GitHub down, a 404): keep the last state, try next interval.
  }
  return true;
}

/** One sweep: every due project, one at a time. Returns how many were read. */
export async function sweepDrift(now = new Date(), clientFor?: ClientFor): Promise<number> {
  let n = 0;
  for (const project of await dueForDrift(now)) {
    try {
      if (await checkProjectDrift(project, now, clientFor)) n++;
    } catch (err) {
      console.error(`drift check for project ${project.id} failed:`, err);
    }
  }
  return n;
}

/** Starts the drift sweep for this process, beside the job worker. */
export function startDriftSweep(intervalMs = 15 * 60 * 1000): void {
  const tick = () => void sweepDrift().catch((err) => console.error("drift sweep failed:", err));
  tick();
  setInterval(tick, intervalMs).unref();
}
