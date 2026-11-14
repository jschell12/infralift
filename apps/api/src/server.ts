import { app } from "./app.js";
import { startAnalyticsRollup } from "./analytics/rollup.js";
import { drainJobs, startJobWorker } from "./lib/jobs/queue.js";
import { startConnectionCheckSweep } from "./services/connection-checks.js";
import { startDriftSweep } from "./services/drift.js";
import { resolveRuntimeEndpointsAtBoot } from "./lib/endpoints.js";
import { log } from "./lib/log.js";

// Before listening: an endpoint override outside development and test, or one
// that is not a URL, stops the process here rather than failing the first provider call.
resolveRuntimeEndpointsAtBoot();

const port = Number(process.env.PORT ?? 4000);

// How long a shutdown waits for in-flight HTTP requests and jobs. It has to be
// shorter than the time the orchestrator allows between SIGTERM and SIGKILL
// (Nomad's kill_timeout), or the process is killed mid-wait anyway.
const SHUTDOWN_DRAIN_MS = Number(process.env.SHUTDOWN_DRAIN_MS ?? 25_000);

const server = app.listen(port, () => {
  log.info({ port }, "infralift api listening");
  startAnalyticsRollup();
  void startJobWorker().catch((err) => log.error({ err }, "job worker failed to start"));
  startDriftSweep();
  startConnectionCheckSweep();
});

let shuttingDown = false;

/** Graceful shutdown: stop accepting connections, stop claiming jobs, give
 *  in-flight requests and jobs up to SHUTDOWN_DRAIN_MS, then exit. A job cut
 *  off here is marked interrupted by the next process at boot; an assessment
 *  cut off is failed by the stuck-assessment sweep (ARCHITECTURE.md, Failure
 *  modes). The drift, connection-check and analytics timers are unref'd and need no stopping. */
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal, drainMs: SHUTDOWN_DRAIN_MS }, "shutting down, waiting for in-flight work");

  const serverClosed = new Promise<void>((resolve) => server.close(() => resolve()));
  server.closeIdleConnections();
  const [jobs] = await Promise.all([
    drainJobs(SHUTDOWN_DRAIN_MS),
    Promise.race([serverClosed, new Promise((resolve) => setTimeout(resolve, SHUTDOWN_DRAIN_MS).unref())]),
  ]);
  if (!jobs.drained) {
    log.warn({ stillRunning: jobs.stillRunning }, "shutdown: jobs still running; the next process marks them interrupted");
  }
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
