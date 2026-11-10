// ---------------------------------------------------------------------------
// The contract between the import check workflow and infralift.
//
// The workflow (check.ts) runs in the customer's CI and reports its outcome
// as a check run: one annotation, or a title on a run it creates itself.
// infralift (result.ts) reads that back and classifies it. Both sides use
// only what is defined here, so the wording cannot drift between them.
//
// The message builders take strings because the workflow passes shell
// variables ("$total"); tests and the reader pass real numbers.
// ---------------------------------------------------------------------------

/** The check job's name, which GitHub uses as the check run's name. */
export const CHECK_JOB_NAME = "Plan changes nothing";

/** Subject of the commit the check makes when it generates resource code.
 *  GitHub runs no workflow for a commit pushed with the job's own token, so
 *  the check records its result on that commit itself, and the reader also
 *  knows to look past it. */
export const GENERATED_COMMIT_SUBJECT = "infralift: generated code for imported resources";

export const OUTCOME = {
  /** Notice: the plan changes nothing. */
  passed: (total: string) => `No changes: all ${total} resources match the code.`,
  /** Error: the plan would change resources. */
  changes: (changes: string, total: string) => `${changes} of ${total} resources would change.`,
  /** Error: credentials or variables are not set. Followed by what is missing. */
  missingPrefix: "Missing credentials.",
  /** Error: the plan failed before comparing anything. */
  planFailed: "The plan failed before it could compare anything. Nothing was changed.",
} as const;

/** Readers for each outcome, matching exactly what OUTCOME writes. */
export const READ = {
  passed: (m: string) => /^No changes: all \d+ resources match the code\.$/.test(m),
  changes: (m: string) => /^\d+ of \d+ resources would change\.$/.test(m),
  missing: (m: string) => m.startsWith(OUTCOME.missingPrefix),
  planFailed: (m: string) => m === OUTCOME.planFailed,
} as const;

// -- drift ---------------------------------------------------------------------
// The scheduled drift check: the same read-only plan, run daily on the default
// branch, under its own job name so it never answers for a pull request's
// check. Written by the import check workflow (check.ts) and by stacks that
// ship one (apps/api/stacks/*/deliveries/github-actions/.../infra.yml, which
// spell these strings out literally; a test pins them). Read by the drift
// sweep (services/drift.ts).

/** The stack's drift job name, which GitHub uses as the check run's name. */
export const DRIFT_JOB_NAME = "infra drift";

/** An imported module's drift job name. One repository can hold several
 *  imported modules, each with its own workflow, and all their scheduled runs
 *  land on the same commit, so each name carries the module's slug
 *  (check.ts checkSlug, the same string as its workflow file name) and the
 *  sweep asks for exactly its own. */
export const driftJobName = (moduleSlug: string) => `${DRIFT_JOB_NAME}: ${moduleSlug}`;

export const DRIFT = {
  /** Notice: nothing changed outside the code. */
  none: "No drift: the plan changes nothing.",
  /** Error prefix: the plan would change something. */
  foundPrefix: "Drift:",
} as const;

/** A drift run's outcome. The import check's own messages count too, since
 *  its drift job reuses the import plan step. */
export const READ_DRIFT = {
  none: (m: string) => m === DRIFT.none || READ.passed(m),
  found: (m: string) => m.startsWith(DRIFT.foundPrefix) || READ.changes(m),
} as const;
