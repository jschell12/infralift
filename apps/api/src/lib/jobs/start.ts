import { claimAndRun } from "./queue.js";

/** Starts a queued job in the background: claims it for this process and runs
 *  it. If it cannot run now (the process stops first), the worker's sweep or
 *  boot recovery picks it up (lib/jobs/queue.ts). The one place a job begins,
 *  so routes do not depend on how jobs are run. */
export function startJob(jobId: string): void {
  void claimAndRun(jobId).catch((err) => {
    console.error(`tf job ${jobId} failed:`, err);
  });
}
