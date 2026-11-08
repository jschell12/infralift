import { describe, expect, it, vi } from "vitest";
import { INITIAL, IllegalTransitionError, JobRun, transition, type JobState } from "./state.js";

describe("transition", () => {
  it("walks forward through the stages to complete", () => {
    let s: JobState = INITIAL;
    for (const stage of ["render", "repo", "commit", "workspace"] as const) s = transition(s, { type: "start", stage });
    expect(s).toEqual({ stage: "workspace", status: "running", message: "" });
    expect(transition(s, { type: "succeed", message: "done" })).toEqual({ stage: "complete", status: "success", message: "done" });
  });

  it("skips optional stages", () => {
    const s = transition(transition(INITIAL, { type: "start", stage: "render" }), { type: "start", stage: "commit" });
    expect(s.stage).toBe("commit");
  });

  it("refuses to go back, repeat a stage, or start complete", () => {
    const commit: JobState = { stage: "commit", status: "running", message: "" };
    for (const stage of ["render", "commit", "complete", "queued"] as const) {
      expect(() => transition(commit, { type: "start", stage }), stage).toThrow(IllegalTransitionError);
    }
  });

  it("fails at the current stage or one it reached, never earlier", () => {
    const render: JobState = { stage: "render", status: "running", message: "" };
    expect(transition(render, { type: "fail", message: "x" })).toMatchObject({ stage: "render", status: "errored" });
    expect(transition(render, { type: "fail", message: "x", stage: "repo" })).toMatchObject({ stage: "repo" });
    const commit: JobState = { stage: "commit", status: "running", message: "" };
    expect(() => transition(commit, { type: "fail", message: "x", stage: "render" })).toThrow(IllegalTransitionError);
  });

  it("allows nothing after the job ends", () => {
    for (const end of [
      { stage: "complete", status: "success", message: "" },
      { stage: "commit", status: "errored", message: "" },
    ] as JobState[]) {
      expect(() => transition(end, { type: "fail", message: "x" })).toThrow(IllegalTransitionError);
      expect(() => transition(end, { type: "succeed", message: "x" })).toThrow(IllegalTransitionError);
    }
  });

  it("only a running job can succeed", () => {
    expect(() => transition(INITIAL, { type: "succeed", message: "x" })).toThrow(IllegalTransitionError);
  });
});

describe("JobRun", () => {
  it("writes each state and trims messages to the dashboard's limit", async () => {
    const write = vi.fn(async () => {});
    const run = new JobRun("j1", write);
    await run.start("render");
    await run.fail("x".repeat(400));
    expect(write).toHaveBeenNthCalledWith(1, "j1", { stage: "render", status: "running", message: "" });
    expect((write.mock.calls[1] as unknown as [string, JobState])[1].message).toHaveLength(280);
  });

  it("failSafely records an error once and never throws after the end", async () => {
    const write = vi.fn(async () => {});
    const run = new JobRun("j1", write);
    await run.start("render");
    await run.succeed("ok");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(run.failSafely(new Error("late"))).resolves.toBeUndefined();
    expect(write).toHaveBeenCalledTimes(2);
    log.mockRestore();
  });
});
