import { runJob } from "../tf/pipeline.js";

/** Starts a queued job in the background. The one place a job begins, so how
 *  jobs are run can change without touching the routes that queue them. */
export function startJob(jobId: string): void {
  void runJob(jobId).catch((err) => {
    console.error(`tf job ${jobId} failed:`, err);
  });
}
