import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { getStack, renderStack } from "./index.js";
import { DRIFT_JOB_NAME, READ_DRIFT } from "../import/contract.js";

// The stack's CI plans every change and applies only the plan saved on the
// default branch. These tests read the rendered workflow files for the
// properties that make that safe, and run the scripts that turn a plan into a
// summary over real `tofu plan` output (__fixtures__/plan-output, made with
// OpenTofu 1.12 against terraform_data resources).

const stack = getStack("app-foundry-hetzner")!;

function render(delivery: "github-actions" | "gitlab-ci", backend: "r2" | "tfc") {
  const files = renderStack(stack, {
    ...stack.example,
    delivery,
    backend,
    ...(delivery === "gitlab-ci" ? { gitlab_project: "acme/web" } : {}),
    ...(backend === "tfc" ? { tfc_organization: "acme" } : {}),
  });
  return new Map(files.map((f) => [f.path, f.content]));
}

const planOutput = (name: string) =>
  readFileSync(new URL(`./__fixtures__/plan-output/${name}.txt`, import.meta.url), "utf8");

interface Step {
  name?: string;
  id?: string;
  if?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}
interface Job {
  name?: string;
  if?: string;
  needs?: string | string[];
  environment?: string | { name: string };
  permissions?: unknown;
  steps: Step[];
}
interface Workflow {
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  concurrency: { group: string; "cancel-in-progress": string | boolean };
  jobs: Record<string, Job>;
}

const workflow = (backend: "r2" | "tfc" = "r2") =>
  parse(render("github-actions", backend).get(".github/workflows/infra.yml")!) as Workflow;

const runs = (job: Job) => job.steps.map((s) => s.run ?? "").join("\n");

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), "stack-ci-"));
  dirs.push(d);
  return d;
};

describe("github-actions infra.yml", () => {
  it("is the same file for both backends, which it tells apart at run time", () => {
    expect(render("github-actions", "r2").get(".github/workflows/infra.yml")).toBe(
      render("github-actions", "tfc").get(".github/workflows/infra.yml")
    );
    const step = workflow().jobs.plan.steps.find((s) => s.id === "backend")!;
    expect(step.run).toContain("deploy/infra/backend.tf");
    // The detection matches what each backend's rendered backend.tf says.
    const cloud = /^[ \t]*cloud[ \t]*\{/m;
    expect(render("github-actions", "tfc").get("deploy/infra/backend.tf")).toMatch(cloud);
    expect(render("github-actions", "r2").get("deploy/infra/backend.tf")).not.toMatch(cloud);
  });

  it("grants the workflow token read access only", () => {
    const wf = workflow();
    expect(wf.permissions).toEqual({ contents: "read" });
    for (const [name, job] of Object.entries(wf.jobs)) {
      expect(job.permissions, name).toBeUndefined();
    }
  });

  it("never applies from the plan job, and a pull request plan saves nothing", () => {
    const plan = workflow().jobs.plan;
    expect(plan.name).toBe("infra plan");
    expect(runs(plan)).not.toMatch(/\b(tofu|terraform) apply\b/);
    expect(runs(plan)).toContain("-lock=false");
    expect(runs(plan)).toContain("-detailed-exitcode");
    // -out only when SAVE_PLAN, which is true only for a push.
    for (const line of runs(plan).split("\n").filter((l) => l.includes("-out="))) {
      expect(line).toContain('[ "$SAVE_PLAN" = true ]');
    }
    expect((plan as unknown as { env: Record<string, string> }).env.SAVE_PLAN).toBe(
      "${{ github.event_name == 'push' }}"
    );
    const keep = plan.steps.find((s) => s.uses?.startsWith("actions/upload-artifact"))!;
    expect(keep.if).toContain("github.event_name == 'push'");
  });

  it("runs the plan only for this repository's pull requests; forks get a notice", () => {
    const { plan, "plan-fork": fork } = workflow().jobs;
    expect(plan.if).toContain("github.event.pull_request.head.repo.full_name == github.repository");
    expect(fork.if).toContain("github.event.pull_request.head.repo.full_name != github.repository");
    expect(runs(fork)).toContain("::notice");
    // The fork job touches nothing a fork could use.
    expect(JSON.stringify(fork)).not.toMatch(/secrets\.|vars\.|checkout/);
  });

  it("applies the saved plan, on push only, in the production environment", () => {
    const { apply } = workflow().jobs;
    expect(apply.name).toBe("infra apply");
    expect(apply.environment).toBe("production");
    expect(apply.needs).toBe("plan");
    expect(apply.if).toContain("github.event_name == 'push'");
    expect(apply.if).toContain("needs.plan.outputs.changes == 'true'");
    const applies = runs(apply).split("\n").filter((l) => /\b(tofu|terraform) apply\b/.test(l));
    expect(applies).toHaveLength(2); // one per backend
    for (const line of applies) expect(line).toMatch(/ tfplan\b/);
    expect(runs(apply)).not.toMatch(/\b(tofu|terraform) plan\b/);
    expect(runs(apply)).not.toContain("-auto-approve");
    const download = apply.steps.find((s) => s.uses?.startsWith("actions/download-artifact"))!;
    expect(download.with).toMatchObject({ name: "infra-plan", path: "deploy/infra" });
  });

  it("keeps the lock file with the plan, which upload-artifact skips unless told", () => {
    const keep = workflow().jobs.plan.steps.find((s) => s.uses?.startsWith("actions/upload-artifact"))!;
    expect(String(keep.with!.path)).toContain("deploy/infra/.terraform.lock.hcl");
    expect(keep.with!["include-hidden-files"]).toBe(true);
  });

  it("serializes pushes and never cancels one in progress", () => {
    const { concurrency } = workflow();
    expect(concurrency.group).toContain("github.event_name == 'push' && 'infra-main'");
    expect(concurrency["cancel-in-progress"]).toBe("${{ github.event_name == 'pull_request' }}");
  });

  it("reads only credentials the README tells the customer to set", () => {
    const text = render("github-actions", "r2").get(".github/workflows/infra.yml")!;
    const names = [...new Set([...text.matchAll(/\b(?:secrets|vars)\.([A-Z0-9_]+)/g)].map((m) => m[1]))];
    expect(names.length).toBeGreaterThan(5);
    const readme = render("github-actions", "r2").get("deploy/README.md")! +
      render("github-actions", "tfc").get("deploy/README.md")!;
    for (const n of names) expect(readme, n).toContain(`\`${n}\``);
  });
});

describe("github-actions plan summary script", () => {
  const script = workflow().jobs.plan.steps.find((s) => s.id === "summary")!.run!;

  function summarize(plan: string, code: string) {
    const dir = scratch();
    writeFileSync(join(dir, "plan.txt"), plan);
    writeFileSync(join(dir, "out"), "");
    writeFileSync(join(dir, "summary"), "");
    // How Actions runs a `run:` step with `shell: bash` (the workflow default).
    const r = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", script], {
      cwd: dir,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        CODE: code,
        TOOL: "tofu",
        GITHUB_OUTPUT: join(dir, "out"),
        GITHUB_STEP_SUMMARY: join(dir, "summary"),
      },
    });
    return {
      status: r.status,
      stdout: r.stdout,
      output: readFileSync(join(dir, "out"), "utf8"),
      summary: readFileSync(join(dir, "summary"), "utf8"),
    };
  }

  it("counts a plan that creates", () => {
    const r = summarize(planOutput("create"), "2");
    expect(r.status).toBe(0);
    expect(r.output).toBe("changes=true\n");
    expect(r.summary).toContain("### infra plan: 2 to add, 0 to change, 0 to destroy");
    expect(r.summary).toContain("terraform_data.a will be created");
    expect(r.stdout).toContain("::notice title=infra plan::2 to add");
  });

  it("raises a destroy to a warning", () => {
    const r = summarize(planOutput("update-destroy"), "2");
    expect(r.output).toBe("changes=true\n");
    expect(r.stdout).toContain("::warning title=infra plan::0 to add, 1 to change, 1 to destroy");
  });

  it("reports no changes, so nothing is applied", () => {
    const r = summarize(planOutput("no-changes"), "0");
    expect(r.status).toBe(0);
    expect(r.output).toBe("changes=false\n");
    expect(r.summary).toContain("### infra plan: no changes");
  });

  it("treats an outputs-only plan as a change, from the exit code alone", () => {
    const r = summarize(planOutput("outputs-only"), "2");
    expect(r.output).toBe("changes=true\n");
  });

  it("fails on a plan error, and on a missing exit code", () => {
    const failed = summarize(planOutput("error"), "1");
    expect(failed.status).toBe(1);
    expect(failed.output).toBe("changes=false\n");
    expect(failed.summary).toContain("Reference to undeclared input variable");
    const empty = summarize("", "");
    expect(empty.status).toBe(1);
    expect(empty.output).toBe("changes=false\n");
  });

  it("truncates a plan too long for the summary", () => {
    const big = planOutput("create").repeat(100);
    expect(big.length).toBeGreaterThan(60000);
    const r = summarize(big, "2");
    expect(r.summary).toContain("Truncated at 60000 bytes");
    expect(r.summary.length).toBeLessThan(61000);
  });
});

describe("github-actions infra drift", () => {
  const wf = workflow();
  const drift = wf.jobs.drift;

  it("runs daily off the hour and on demand, on the default branch only", () => {
    const cron = (wf.on.schedule as { cron: string }[])[0].cron;
    expect(cron).toBe("41 6 * * *");
    expect(cron.split(" ")[0]).not.toBe("0");
    expect(wf.on).toHaveProperty("workflow_dispatch");
    expect(drift.name).toBe(DRIFT_JOB_NAME);
    expect(drift.if).toContain("github.event_name == 'schedule'");
    expect(drift.if).toContain("github.ref_name == github.event.repository.default_branch");
  });

  it("plans only: no -out, no artifact, no apply, nothing depends on it", () => {
    expect(runs(drift)).toContain("-detailed-exitcode");
    expect(runs(drift)).not.toMatch(/-out=|\b(tofu|terraform) apply\b|-auto-approve/);
    expect(drift.steps.filter((s) => s.uses?.includes("artifact"))).toEqual([]);
    expect(drift.permissions).toBeUndefined();
    expect(drift.environment).toBeUndefined();
    for (const job of Object.values(wf.jobs)) expect([job.needs].flat()).not.toContain("drift");
  });

  it("leaves every other job off the schedule, and never cancels a push", () => {
    for (const name of ["validate", "box", "plan", "plan-fork", "apply"]) {
      const cond = wf.jobs[name].if ?? "";
      // Each names the events it runs on; none of them is schedule or dispatch.
      expect(cond, name).toMatch(/github\.event_name == 'pull_request'|github\.event_name == 'push'/);
      expect(cond, name).not.toMatch(/schedule|workflow_dispatch/);
    }
    expect(wf.concurrency.group).toContain("'infra-drift'");
  });

  const script = drift.steps.find((s) => s.name === "Result")!.run!;
  function result(plan: string, code: string) {
    const dir = scratch();
    writeFileSync(join(dir, "plan.txt"), plan);
    writeFileSync(join(dir, "summary"), "");
    const r = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", script], {
      cwd: dir,
      encoding: "utf8",
      env: { PATH: process.env.PATH, CODE: code, GITHUB_STEP_SUMMARY: join(dir, "summary") },
    });
    const message = /::(?:notice|error) title=infra drift::(.*)/.exec(r.stdout)?.[1] ?? "";
    return { status: r.status, message, summary: readFileSync(join(dir, "summary"), "utf8") };
  }

  it("passes with the no-drift notice when the plan changes nothing", () => {
    const r = result(planOutput("no-changes"), "0");
    expect(r.status).toBe(0);
    expect(READ_DRIFT.none(r.message)).toBe(true);
    expect(READ_DRIFT.found(r.message)).toBe(false);
  });

  it("fails with the drift marker on exit code 2, counting from the plan", () => {
    const r = result(planOutput("update-destroy"), "2");
    expect(r.status).toBe(1);
    expect(READ_DRIFT.found(r.message)).toBe(true);
    expect(r.message).toContain("0 to add, 1 to change, 1 to destroy");
    expect(r.summary).toContain("### infra drift");
  });

  it("fails with neither marker when the plan errors or never ran", () => {
    for (const [plan, code] of [[planOutput("error"), "1"], ["", ""]]) {
      const r = result(plan, code);
      expect(r.status).toBe(1);
      expect(r.message).not.toBe("");
      expect(READ_DRIFT.none(r.message)).toBe(false);
      expect(READ_DRIFT.found(r.message)).toBe(false);
    }
  });
});

describe("gitlab-ci infra jobs", () => {
  interface GlJob {
    stage: string;
    needs?: string[];
    rules: { if?: string; when?: string; changes?: string[]; allow_failure?: boolean }[];
    script: string[];
    environment?: { name: string };
    resource_group?: string;
    artifacts?: { reports?: Record<string, string>; paths?: string[] };
  }
  const ci = parse(render("gitlab-ci", "r2").get(".gitlab-ci.yml")!) as Record<string, GlJob> & {
    stages: string[];
  };

  it("is the same file for both backends", () => {
    expect(render("gitlab-ci", "r2").get(".gitlab-ci.yml")).toBe(
      render("gitlab-ci", "tfc").get(".gitlab-ci.yml")
    );
  });

  it("plans same-project merge requests and the default branch, and never applies there", () => {
    const plan = ci.infra_plan;
    expect(ci.stages.indexOf("infra")).toBeGreaterThan(ci.stages.indexOf("deploy"));
    const ifs = plan.rules.map((r) => r.if ?? "");
    expect(ifs).toContain(
      '$CI_PIPELINE_SOURCE == "merge_request_event" && $CI_MERGE_REQUEST_SOURCE_PROJECT_ID == $CI_PROJECT_ID'
    );
    expect(plan.script.join("\n")).not.toMatch(/\$TF apply\b/);
    expect(plan.script.join("\n")).toContain('if [ "$CI_COMMIT_BRANCH" = "$CI_DEFAULT_BRANCH" ]; then set -- "$@" -out=tfplan');
    expect(plan.artifacts?.reports).toMatchObject({ terraform: "deploy/infra/plan.json" });
  });

  it("applies only on the default branch, by hand unless opted out, in production", () => {
    const apply = ci.infra_apply;
    expect(apply.needs).toEqual(["infra_plan"]);
    expect(apply.environment).toEqual({ name: "production" });
    expect(apply.resource_group).toBe("production");
    expect(apply.rules[1]).toEqual({ if: "$CI_COMMIT_BRANCH != $CI_DEFAULT_BRANCH", when: "never" });
    expect(apply.rules.at(-1)).toMatchObject({ when: "manual", allow_failure: false });
    expect(apply.rules.filter((r) => r.when === undefined)).toEqual([
      { if: '$INFRA_AUTO_APPLY == "1"', changes: ["deploy/**/*", ".gitlab-ci.yml"] },
    ]);
  });

  // The jobs' scripts, run with a stand-in for tofu that prints real plan
  // output. before_script (apt, the tool install) is not run; it leaves the
  // shell in deploy/infra with INFRA_BACKEND, TF and INFRA_MISSING set.
  function runJob(job: GlJob, env: Record<string, string>, plan?: { text: string; code: number }) {
    const dir = scratch();
    const calls = join(dir, "calls");
    writeFileSync(calls, "");
    writeFileSync(join(dir, "plan-fixture"), plan?.text ?? "");
    const tf = join(dir, "fake-tofu");
    writeFileSync(
      tf,
      `#!/bin/sh\necho "$*" >> "${calls}"\nif [ "$1" = plan ]; then cat "${dir}/plan-fixture"; exit ${plan?.code ?? 0}; fi\nexit 0\n`
    );
    chmodSync(tf, 0o755);
    const r = spawnSync("bash", ["-eo", "pipefail", "-c", job.script.join("\n")], {
      cwd: dir,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        INFRA_BACKEND: "r2",
        TF: tf,
        INFRA_MISSING: "",
        CI_DEFAULT_BRANCH: "main",
        ...env,
      },
    });
    const read = (f: string) => {
      try {
        return readFileSync(join(dir, f), "utf8");
      } catch {
        return null;
      }
    };
    return { status: r.status, stdout: r.stdout, calls: read("calls")!, env: read("infra.env"), json: read("plan.json") };
  }

  it("a merge request plan: read-only, unsaved, counted for the widget", () => {
    const r = runJob(ci.infra_plan, { CI_COMMIT_BRANCH: "" }, { text: planOutput("update-destroy"), code: 2 });
    expect(r.status).toBe(0);
    expect(r.calls).toContain("plan -input=false -no-color -detailed-exitcode -lock=false\n");
    expect(r.calls).not.toContain("-out=");
    expect(JSON.parse(r.json!)).toEqual({ create: 0, update: 1, delete: 1 });
    expect(r.env).toBe("INFRA_CHANGES=true\n");
  });

  it("a default branch plan is saved; no changes means nothing to apply", () => {
    const r = runJob(ci.infra_plan, { CI_COMMIT_BRANCH: "main" }, { text: planOutput("no-changes"), code: 0 });
    expect(r.status).toBe(0);
    expect(r.calls).toContain("-out=tfplan");
    expect(r.env).toBe("INFRA_CHANGES=false\n");
    expect(JSON.parse(r.json!)).toEqual({ create: 0, update: 0, delete: 0 });
  });

  it("a failed plan fails the job; missing credentials skip it without running tofu", () => {
    const failed = runJob(ci.infra_plan, { CI_COMMIT_BRANCH: "main" }, { text: planOutput("error"), code: 1 });
    expect(failed.status).toBe(1);
    expect(failed.env).toBe("INFRA_CHANGES=false\n");
    const skipped = runJob(ci.infra_plan, { INFRA_MISSING: " HCLOUD_TOKEN" });
    expect(skipped.status).toBe(0);
    expect(skipped.stdout).toContain("infra plan skipped");
    expect(skipped.calls).toBe("");
  });

  it("apply runs the saved plan, and only when the plan changed something", () => {
    const noop = runJob(ci.infra_apply, { INFRA_CHANGES: "false" });
    expect(noop.status).toBe(0);
    expect(noop.calls).toBe("");
    const real = runJob(ci.infra_apply, { INFRA_CHANGES: "true" });
    expect(real.status).toBe(0);
    expect(real.calls).toContain("apply -input=false -no-color tfplan\n");
    expect(real.calls).not.toMatch(/^plan/m);
    const missing = runJob(ci.infra_apply, { INFRA_CHANGES: "true", INFRA_MISSING: " TF_STATE_PASSPHRASE" });
    expect(missing.status).toBe(1);
    expect(missing.calls).toBe("");
  });

  it("reads only variables the README tells the customer to set", () => {
    const text = render("gitlab-ci", "r2").get(".gitlab-ci.yml")!;
    const needs = /INFRA_NEEDS="([^"]+)"\n\s+fi/.exec(text)![1].split(" ");
    const tfc = /INFRA_NEEDS="(TF_API_TOKEN)"/.exec(text)![1];
    const readme = render("gitlab-ci", "r2").get("deploy/README.md")!;
    for (const n of needs) expect(readme, n).toContain(`\`${n}\``);
    expect(render("gitlab-ci", "tfc").get("deploy/README.md")).toContain(`\`${tfc}\``);
  });
});

describe("github-actions apply failures", () => {
  it("runs every step under bash with pipefail", () => {
    const wf = workflow() as Workflow & { defaults?: { run?: { shell?: string } } };
    expect(wf.defaults?.run?.shell).toBe("bash");
  });

  it("fails the apply step when the apply fails, despite the tee", () => {
    const step = workflow("tfc").jobs.apply.steps.find((s) => /terraform apply\b/.test(s.run ?? ""))!;
    const dir = scratch();
    // A terraform that initialises and then refuses the saved plan.
    writeFileSync(
      join(dir, "terraform"),
      '#!/bin/sh\n[ "$1" = init ] && exit 0\necho "Error: Saved plan is stale"; exit 1\n'
    );
    chmodSync(join(dir, "terraform"), 0o755);
    // `shell: bash` is `bash --noprofile --norc -eo pipefail {0}`; without
    // pipefail (the default shell) this exits 0 and the job goes green.
    const run = (flags: string[]) =>
      spawnSync("bash", [...flags, "-c", step.run!], {
        cwd: dir,
        encoding: "utf8",
        env: { PATH: `${dir}:${process.env.PATH}` },
      }).status;
    expect(run(["--noprofile", "--norc", "-eo", "pipefail"])).not.toBe(0);
    expect(run(["-e"])).toBe(0);
  });
});
