import { prisma } from "./db.js";
import { log } from "./log.js";

// ---------------------------------------------------------------------------
// Liveness and readiness are different questions.
//
//   GET /health  the process is up and answering. Says nothing about the
//                database, so a database outage does not get a healthy API
//                restarted in a loop.
//   GET /ready   the process can serve a request that needs the database:
//                SELECT 1 answers within READY_DB_TIMEOUT_MS. 503 otherwise.
//
// The Nomad job that runs the API is declared in the private deploy
// repository, not here (ADR 0007); pointing its check at /ready is done there.
// ---------------------------------------------------------------------------

export const READY_DB_TIMEOUT_MS = 2_000;

export interface Readiness {
  ok: boolean;
  database: "ok" | "unavailable";
}

/** The query is injectable so tests can stand in for the database. */
export async function checkReadiness(
  query: () => Promise<unknown> = () => prisma.$queryRaw`SELECT 1`,
  timeoutMs = READY_DB_TIMEOUT_MS
): Promise<Readiness> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`database did not answer within ${timeoutMs}ms`)), timeoutMs);
    timer.unref();
  });
  try {
    await Promise.race([query(), deadline]);
    return { ok: true, database: "ok" };
  } catch (err) {
    log.warn({ err }, "readiness: database unavailable");
    return { ok: false, database: "unavailable" };
  } finally {
    clearTimeout(timer);
  }
}
