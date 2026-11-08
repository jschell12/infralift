import { describe, expect, it } from "vitest";
import { classifyCheck } from "./result.js";
import type { CheckRun } from "../git/hosts.js";

const pr = { url: "https://github.com/acme/infra/pull/4", headSha: "abc", state: "open" as const };
const run = (over: Partial<CheckRun>): CheckRun => ({
  status: "completed",
  conclusion: "success",
  url: "https://github.com/acme/infra/runs/1",
  completedAt: "2026-11-08T00:00:00Z",
  annotations: [],
  ...over,
});
const at = new Date("2026-11-08T12:00:00Z");

describe("classifyCheck", () => {
  it("reads each outcome from the check's own annotation", () => {
    const cases: [Partial<CheckRun>, string, RegExp][] = [
      [{ annotations: [{ level: "notice", message: "No changes: all 12 resources match the code." }] }, "passed", /all 12 resources/],
      [{ conclusion: "failure", annotations: [{ level: "failure", message: "3 of 12 resources would change." }] }, "changes", /3 of 12/],
      [
        { conclusion: "failure", annotations: [{ level: "failure", message: "Missing credentials. Add these repository secrets, then re-run: HCLOUD_TOKEN." }] },
        "needs-setup",
        /HCLOUD_TOKEN/,
      ],
      [
        { conclusion: "failure", annotations: [{ level: "failure", message: "The plan failed before it could compare anything. Nothing was changed." }] },
        "error",
        /before it could compare/,
      ],
      [{ conclusion: "cancelled" }, "failed", /cancelled/],
      [{ conclusion: "failure", annotations: [{ level: "failure", message: "Process completed with exit code 2." }] }, "failed", /exit code 2/],
      [{ status: "in_progress", conclusion: null }, "running", /running/],
    ];
    for (const [over, state, msg] of cases) {
      const r = classifyCheck(pr, run(over), at);
      expect(r.state, state).toBe(state);
      expect(r.message).toMatch(msg);
    }
  });

  it("waits while there is no run, and says so differently once the PR is closed", () => {
    expect(classifyCheck(pr, null, at)).toMatchObject({ state: "waiting", prUrl: pr.url, checkUrl: null });
    expect(classifyCheck({ ...pr, state: "merged" }, null, at).message).toMatch(/merged and the check never ran/);
  });

  it("reports no PR yet", () => {
    expect(classifyCheck(null, null, at)).toMatchObject({ state: "no-pr", prUrl: null, checkedAt: at.toISOString() });
  });
});
