import type { ChangeRequestState, CheckRun } from "../git/hosts.js";
import { READ, READ_DRIFT } from "./contract.js";
import type { DriftState } from "@infralift/shared";

// What the import check said, read back from GitHub. The workflow writes one
// annotation per outcome (lib/import/check.ts), and this turns the check run
// and those annotations into a state the dashboard can show.

// The result types are shared with the dashboard (@infralift/shared).
export type { ImportCheckResult, ImportCheckState } from "@infralift/shared";
import type { ImportCheckResult } from "@infralift/shared";

export function classifyCheck(
  pr: ChangeRequestState | null,
  run: CheckRun | null,
  now = new Date()
): ImportCheckResult {
  const base = {
    prUrl: pr?.url ?? null,
    prState: pr?.state ?? null,
    checkUrl: run?.url ?? null,
    headSha: pr?.headSha ?? null,
    checkedAt: now.toISOString(),
  };
  if (!pr) return { ...base, state: "no-pr", message: "The import pull request has not been opened yet." };
  if (!run) {
    return {
      ...base,
      state: "waiting",
      message:
        pr.state === "open"
          ? "Waiting for the check to start. If it never does, check that Actions is enabled for the repository."
          : `The pull request is ${pr.state} and the check never ran on its last commit.`,
    };
  }
  if (run.status !== "completed") return { ...base, state: "running", message: "The read-only plan is running." };

  let errors = run.annotations.filter((a) => a.level === "failure").map((a) => a.message);
  let notices = run.annotations.filter((a) => a.level === "notice").map((a) => a.message);
  // A run the check created for its own generated commit has no annotations;
  // its result is the title.
  if (!run.annotations.length && run.title) {
    if (run.conclusion === "success") notices = [run.title];
    else errors = [run.title];
  }
  if (run.conclusion === "success") {
    return { ...base, state: "passed", message: notices.find(READ.passed) ?? "No changes." };
  }
  if (run.conclusion === "failure") {
    const changes = errors.find(READ.changes);
    if (changes) return { ...base, state: "changes", message: changes };
    const setup = errors.find(READ.missing);
    if (setup) return { ...base, state: "needs-setup", message: setup };
    const error = errors.find(READ.planFailed);
    if (error) return { ...base, state: "error", message: error };
  }
  return {
    ...base,
    state: "failed",
    message: errors[0] ?? `The check ended as ${run.conclusion ?? run.status}.`,
  };
}

/** What the newest `infra drift` run said. Success counts as no drift only
 *  with the no-drift notice, and failure as drift only with the drift marker:
 *  a run that passed or failed for any other reason (credentials missing, the
 *  plan erroring) says nothing about drift, so it is unknown. */
export function classifyDrift(
  run: CheckRun | null,
  branch: string
): { state: DriftState; message: string; checkUrl: string | null; ranAt: string | null } {
  const base = { checkUrl: run?.url ?? null, ranAt: run?.completedAt ?? null };
  if (!run) return { ...base, state: "unknown", message: `The drift check has not run on ${branch} yet.` };
  if (run.status !== "completed") return { ...base, state: "unknown", message: "The drift check is running." };
  const by = (level: string) => run.annotations.filter((a) => a.level === level).map((a) => a.message);
  const notices = by("notice");
  const errors = by("failure");
  if (run.conclusion === "success") {
    const none = notices.find(READ_DRIFT.none);
    if (none) return { ...base, state: "none", message: none };
  }
  if (run.conclusion === "failure") {
    const found = errors.find(READ_DRIFT.found);
    if (found) return { ...base, state: "drift", message: found };
  }
  return {
    ...base,
    state: "unknown",
    message: errors[0] ?? `The drift check ended as ${run.conclusion ?? run.status} without saying whether anything changed.`,
  };
}
