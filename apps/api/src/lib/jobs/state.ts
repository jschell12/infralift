// ---------------------------------------------------------------------------
// Job state machine.
//
// A TfJob moves forward through stages and ends exactly once, in success or
// errored. Every change goes through transition(), which refuses anything
// else, so the order a job can be in is written here once rather than spread
// across the runners that move it.
//
//   queued -> render -> [repo] -> commit -> [workspace] -> complete
//   status:   pending -> running -> success (only at complete) | errored
//
// The stage and status strings are stored in the database and shown on the
// dashboard as they are; changing one is a data migration.
// ---------------------------------------------------------------------------

export const STAGES = ["queued", "render", "repo", "commit", "workspace", "complete"] as const;
export type Stage = (typeof STAGES)[number];

export const STATUSES = ["pending", "running", "errored", "success"] as const;
export type Status = (typeof STATUSES)[number];

export interface JobState {
  stage: Stage;
  status: Status;
  message: string;
}

export type JobEvent =
  /** Begin work on a later stage. */
  | { type: "start"; stage: Stage }
  /** Stop with an error, at the current stage or a later one it reached. */
  | { type: "fail"; message: string; stage?: Stage }
  /** Finish: the job is complete. */
  | { type: "succeed"; message: string };

export class IllegalTransitionError extends Error {
  constructor(
    readonly from: JobState,
    readonly event: JobEvent
  ) {
    super(`job cannot ${event.type}${"stage" in event && event.stage ? ` ${event.stage}` : ""} from ${from.stage}/${from.status}`);
  }
}

export const INITIAL: JobState = { stage: "queued", status: "pending", message: "" };

const order = (s: Stage) => STAGES.indexOf(s);
export const isTerminal = (s: JobState) => s.status === "errored" || s.status === "success";

/** The state after `event`, or IllegalTransitionError. Pure. */
export function transition(from: JobState, event: JobEvent): JobState {
  if (isTerminal(from)) throw new IllegalTransitionError(from, event);
  switch (event.type) {
    case "start":
      // Strictly forward, and never into "complete": that is what succeed is for.
      if (event.stage === "complete" || event.stage === "queued" || order(event.stage) <= order(from.stage)) {
        throw new IllegalTransitionError(from, event);
      }
      return { stage: event.stage, status: "running", message: "" };
    case "fail": {
      const stage = event.stage ?? from.stage;
      if (order(stage) < order(from.stage) || stage === "complete") throw new IllegalTransitionError(from, event);
      return { stage, status: "errored", message: event.message };
    }
    case "succeed":
      if (from.status !== "running") throw new IllegalTransitionError(from, event);
      return { stage: "complete", status: "success", message: event.message };
  }
}

/** Messages are shown in the dashboard's job row, which holds 280 characters. */
export const MESSAGE_LIMIT = 280;

/**
 * One job's run: holds its state, applies events through transition(), and
 * writes each new state. The write is injected so tests can watch it.
 */
export class JobRun {
  private state: JobState;

  constructor(
    readonly jobId: string,
    private readonly write: (jobId: string, s: JobState) => Promise<void>,
    from: JobState = INITIAL
  ) {
    this.state = from;
  }

  get current(): JobState {
    return this.state;
  }

  private async apply(event: JobEvent) {
    const t = transition(this.state, event);
    const next = { ...t, message: t.message.slice(0, MESSAGE_LIMIT) };
    // Recorded first, adopted second: if the write fails, the run still holds
    // the last state the database has, so a later failSafely can record the
    // error instead of believing the job already ended.
    await this.write(this.jobId, next);
    this.state = next;
  }

  start(stage: Stage) {
    return this.apply({ type: "start", stage });
  }

  fail(message: string, stage?: Stage) {
    return this.apply({ type: "fail", message, stage });
  }

  succeed(message: string) {
    return this.apply({ type: "succeed", message });
  }

  /** For catch blocks: records the error unless the job already ended. It
   *  never throws (a failed write is logged), so an error path cannot raise a
   *  second error. */
  async failSafely(err: unknown) {
    if (isTerminal(this.state)) {
      console.error(`job ${this.jobId} errored after it ended:`, err);
      return;
    }
    try {
      await this.fail(err instanceof Error ? err.message : String(err));
    } catch (writeErr) {
      console.error(`job ${this.jobId} could not record its error:`, err, writeErr);
    }
  }
}
