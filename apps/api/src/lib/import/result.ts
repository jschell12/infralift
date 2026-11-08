import type { ChangeRequestState, CheckRun } from "../git/hosts.js";
import { READ } from "./contract.js";

// What the import check said, read back from GitHub. The workflow writes one
// annotation per outcome (lib/import/check.ts), and this turns the check run
// and those annotations into a state the dashboard can show.

export type ImportCheckState =
  /** No pull request recorded yet: the import job has not opened it. */
  | "no-pr"
  /** Opened, but no run of the check yet (Actions disabled, or queued behind others). */
  | "waiting"
  | "running"
  /** The plan changed nothing: safe to take over. */
  | "passed"
  /** The plan would change resources. */
  | "changes"
  /** Credentials or variables are not set. */
  | "needs-setup"
  /** The plan errored before it could compare. */
  | "error"
  /** Cancelled, timed out, or failed in a way the check did not explain. */
  | "failed";

export interface ImportCheckResult {
  state: ImportCheckState;
  /** One line for the dashboard, from the check's own annotation when there is one. */
  message: string;
  prUrl: string | null;
  prState: ChangeRequestState["state"] | null;
  checkUrl: string | null;
  headSha: string | null;
  checkedAt: string;
}

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
