import { parse } from "yaml";
import { runInTofu, type StepResult } from "./tofu.js";

// Runs steps of a workflow infralift rendered, as GitHub Actions would: the
// `run:` scripts verbatim, in the job's working directory, with the job's
// env. The `uses:` steps are what the harness stands in for (checkout is the
// mounted directory, setup-opentofu is the container), and `${{ }}`
// expressions are not evaluated: the caller passes the values they resolve to.

export interface Workflow {
  jobs: Record<string, { env?: Record<string, string>; defaults?: { run?: { "working-directory"?: string } }; steps: { name?: string; run?: string; env?: Record<string, string> }[] }>;
}

export function parseWorkflow(text: string): Workflow {
  return parse(text) as Workflow;
}

export function stepScript(wf: Workflow, job: string, name: string): string {
  const step = wf.jobs[job]?.steps.find((s) => s.name === name);
  if (!step?.run) throw new Error(`job ${job} has no run step named "${name}"`);
  return step.run;
}

/** Runs one named step of `job` against the checkout in `dir`. RUNNER_TEMP is
 *  a directory inside the checkout so it survives from step to step, as it
 *  does on a runner. */
export function runStep(opts: { wf: Workflow; job: string; name: string; dir: string; env: Record<string, string> }): Promise<StepResult> {
  const job = opts.wf.jobs[opts.job];
  const cwd = job.defaults?.run?.["working-directory"] ?? ".";
  return runInTofu({
    dir: opts.dir,
    cwd,
    script: stepScript(opts.wf, opts.job, opts.name),
    env: {
      ...Object.fromEntries(Object.entries(job.env ?? {}).filter(([, v]) => !String(v).includes("${{"))),
      RUNNER_TEMP: "/work/.runner",
      GITHUB_STEP_SUMMARY: "/work/.runner/summary.md",
      ...opts.env,
    },
  });
}
