import { hostname } from "node:os";
import { prisma } from "../db.js";
import { runJob } from "../tf/pipeline.js";
import { isTerminal, transition, type JobState, type Stage, type Status } from "./state.js";

// ---------------------------------------------------------------------------
// Job queue. A TfJob row is the queue entry: it is created "queued/pending",
// claimed by exactly one API process, then run by the pipeline.
//
//   claim     one conditional UPDATE (claimedAt is null, status pending), so
//             two processes cannot both run a job
//   run now   startJob() claims and runs a new job right away
//   sweep     the worker picks up pending jobs nobody claimed, such as one
//             queued just before a restart
//   recover   at boot, a claimed job that never finished belonged to a process
//             that is gone; it is marked errored ("interrupted") so it does
//             not sit at "running" forever. It is not retried automatically:
//             a job writes to a customer's repository, and a person decides
//             whether to run it again.
// ---------------------------------------------------------------------------

/** This process, as recorded in claimedBy. */
export const WORKER_ID = `${hostname()}:${process.pid}:${Date.now()}`;

export const INTERRUPTED =
  "interrupted: infralift restarted while this job was running. Nothing after the last step shown was done; start it again.";

/** Claims the job for this process. False when another process has it, or it
 *  is no longer pending. */
export async function claim(jobId: string, workerId = WORKER_ID): Promise<boolean> {
  const { count } = await prisma.tfJob.updateMany({
    where: { id: jobId, claimedAt: null, status: "pending" },
    data: { claimedAt: new Date(), claimedBy: workerId },
  });
  return count === 1;
}

/** Claims and runs a job; does nothing if it cannot be claimed. */
export async function claimAndRun(jobId: string): Promise<void> {
  if (!(await claim(jobId))) return;
  await runJob(jobId);
}

/** Marks jobs claimed by other (gone) processes and never finished as errored.
 *  Returns how many. Run once at boot, before the sweep. */
export async function recoverInterrupted(workerId = WORKER_ID): Promise<number> {
  const stuck = await prisma.tfJob.findMany({
    where: { claimedAt: { not: null }, claimedBy: { not: workerId }, status: { in: ["pending", "running"] } },
    select: { id: true, stage: true, status: true, statusMessage: true },
  });
  let n = 0;
  for (const job of stuck) {
    const from: JobState = { stage: job.stage as Stage, status: job.status as Status, message: job.statusMessage };
    if (isTerminal(from)) continue;
    const next = transition(from, { type: "fail", message: INTERRUPTED });
    // Conditional, so a job that finished meanwhile is left alone.
    const { count } = await prisma.tfJob.updateMany({
      where: { id: job.id, status: job.status },
      data: { status: next.status, statusMessage: next.message },
    });
    n += count;
  }
  return n;
}

/** Pending jobs nobody claimed, oldest first. Waits a moment after creation
 *  so a job startJob() is about to claim is not raced. */
export async function sweep(limit = 5, minAgeMs = 10_000): Promise<string[]> {
  const jobs = await prisma.tfJob.findMany({
    where: { status: "pending", claimedAt: null, createdAt: { lt: new Date(Date.now() - minAgeMs) } },
    orderBy: { createdAt: "asc" },
    take: limit,
    select: { id: true },
  });
  return jobs.map((j) => j.id);
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Starts the worker for this process: recover, then sweep on an interval. */
export async function startJobWorker(intervalMs = 15_000): Promise<void> {
  const recovered = await recoverInterrupted();
  if (recovered) console.log(`job worker: marked ${recovered} interrupted job(s) as errored`);
  const tick = async () => {
    for (const id of await sweep()) {
      await claimAndRun(id).catch((err) => console.error(`tf job ${id} failed:`, err));
    }
  };
  await tick().catch((err) => console.error("job worker sweep failed:", err));
  timer = setInterval(() => void tick().catch((err) => console.error("job worker sweep failed:", err)), intervalMs);
  timer.unref();
}

export function stopJobWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
