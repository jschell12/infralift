import { hostname } from "node:os";
import { prisma } from "../db.js";
import { runJob } from "../tf/pipeline.js";
import { failStuckAssessments } from "../../services/assessments.js";
import { isTerminal, transition, type JobState, type Stage, type Status } from "./state.js";

// ---------------------------------------------------------------------------
// Job queue. A TfJob row is the queue entry: it is created "queued/pending",
// claimed by exactly one API process, then run by the pipeline.
//
//   claim     one conditional UPDATE (claimedAt is null, status pending), so
//             two processes cannot both run a job (compare-and-set: the
//             WHERE clause is the expected state, the row count the verdict)
//   run now   startJob() claims and runs a new job right away
//   sweep     the worker picks up pending jobs nobody claimed, such as one
//             queued just before a restart
//   recover   at boot, a claimed job that never finished belonged to a process
//             that is gone; it is marked errored ("interrupted") so it does
//             not sit at "running" forever. It is not retried automatically:
//             a job writes to a customer's repository, and a person decides
//             whether to run it again.
//   overdue   each sweep also fails a claimed job still unfinished
//             JOB_TIME_LIMIT_MS after its claim, whichever process holds it.
//             Every outbound call has a deadline (lib/http.ts), so this is
//             for the hang nobody predicted, not the normal path. If the job
//             was only slow and later finishes, its runner's write wins,
//             which is the truer record. The same
//             tick fails assessments stuck at "running" (services/
//             assessments.ts), because it is the one periodic sweep there is.
//   drain     on SIGTERM, drainJobs() stops claiming and waits a bounded time
//             for jobs already running (server.ts). One still running at exit
//             is marked interrupted by the next process's recover.
//
// Assumes one API process at a time (the Nomad job runs one copy and a deploy
// restarts it in place): recovery treats every claim by another process as
// abandoned. Running two copies at once needs a heartbeat on claimed jobs.
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

/** How long a claimed job may go unfinished before the sweep fails it. The
 *  longest real jobs (a codegen commit of a few hundred files, then a TFC
 *  workspace) take a few minutes. */
export const JOB_TIME_LIMIT_MS = 30 * 60 * 1000;

export const OVERDUE =
  "timed out: this job ran for more than 30 minutes without finishing, so it was marked failed. Nothing after the last step shown is known to have happened; start it again.";

/** False once drainJobs() has been called: this process is shutting down. */
let accepting = true;
/** Jobs this process is running, so a shutdown can wait for them. */
const inFlight = new Set<Promise<void>>();

/** Claims and runs a job; does nothing if it cannot be claimed or this
 *  process is shutting down (the job stays pending for the next process's
 *  sweep). A failure before the job's first step (the runners record their
 *  own errors after that) marks it errored rather than leaving it claimed and
 *  pending. */
export function claimAndRun(jobId: string): Promise<void> {
  if (!accepting) return Promise.resolve();
  const work = claimThenRun(jobId);
  inFlight.add(work);
  const forget = () => void inFlight.delete(work);
  work.then(forget, forget);
  return work;
}

async function claimThenRun(jobId: string): Promise<void> {
  if (!(await claim(jobId))) return;
  try {
    await runJob(jobId);
  } catch (err) {
    const message = `could not start: ${err instanceof Error ? err.message : String(err)}`.slice(0, 280);
    await prisma.tfJob.updateMany({ where: { id: jobId, status: "pending" }, data: { status: "errored", statusMessage: message } });
    throw err;
  }
}

/** Marks jobs claimed by other (gone) processes and never finished as errored.
 *  Returns how many. Run once at boot, before the sweep. */
export async function recoverInterrupted(workerId = WORKER_ID): Promise<number> {
  const stuck = await prisma.tfJob.findMany({
    where: { claimedAt: { not: null }, claimedBy: { not: workerId }, status: { in: ["pending", "running"] } },
    select: { id: true, stage: true, status: true, statusMessage: true },
  });
  return failJobs(stuck, INTERRUPTED);
}

/** Fails claimed jobs still unfinished `limitMs` after their claim, by any
 *  process. Returns how many. Run on every sweep. */
export async function failOverdueJobs(now = new Date(), limitMs = JOB_TIME_LIMIT_MS): Promise<number> {
  const overdue = await prisma.tfJob.findMany({
    where: { claimedAt: { not: null, lt: new Date(now.getTime() - limitMs) }, status: { in: ["pending", "running"] } },
    select: { id: true, stage: true, status: true, statusMessage: true },
  });
  return failJobs(overdue, OVERDUE);
}

type JobRow = { id: string; stage: string; status: string; statusMessage: string };

async function failJobs(jobs: JobRow[], message: string): Promise<number> {
  let n = 0;
  for (const job of jobs) {
    const from: JobState = { stage: job.stage as Stage, status: job.status as Status, message: job.statusMessage };
    if (isTerminal(from)) continue;
    const next = transition(from, { type: "fail", message });
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

/** One pass of the worker: fail what is overdue, then run what is waiting.
 *  Each part logs its own failure so one cannot stop the others. */
export async function workerTick(): Promise<void> {
  const overdue = await failOverdueJobs().catch((err) => {
    console.error("job worker: overdue sweep failed:", err);
    return 0;
  });
  if (overdue) console.log(`job worker: marked ${overdue} overdue job(s) as errored`);
  const stale = await failStuckAssessments().catch((err) => {
    console.error("job worker: assessment sweep failed:", err);
    return 0;
  });
  if (stale) console.log(`job worker: marked ${stale} stuck assessment(s) as failed`);
  for (const id of await sweep()) {
    if (!accepting) return;
    await claimAndRun(id).catch((err) => console.error(`tf job ${id} failed:`, err));
  }
}

/** Starts the worker for this process: recover, then sweep on an interval. */
export async function startJobWorker(intervalMs = 15_000): Promise<void> {
  const recovered = await recoverInterrupted();
  if (recovered) console.log(`job worker: marked ${recovered} interrupted job(s) as errored`);
  const tick = () => workerTick().catch((err) => console.error("job worker sweep failed:", err));
  await tick();
  timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
}

export function stopJobWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Stops claiming jobs and waits up to `timeoutMs` for the ones this process
 *  is running. `stillRunning` is how many were cut off; the next process
 *  marks them interrupted at boot. */
export async function drainJobs(timeoutMs: number): Promise<{ drained: boolean; stillRunning: number }> {
  accepting = false;
  stopJobWorker();
  if (inFlight.size === 0) return { drained: true, stillRunning: 0 };
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    deadline = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  const finished = Promise.allSettled([...inFlight]).then(() => "done" as const);
  const outcome = await Promise.race([finished, timedOut]);
  clearTimeout(deadline);
  return { drained: outcome === "done", stillRunning: inFlight.size };
}

/** For tests: undo drainJobs(). */
export function resetQueueForTests(): void {
  accepting = true;
  inFlight.clear();
}
