import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { applyWorkflowPath, renderApplyWorkflow } from "./apply.js";
import { renderImportCheck } from "./check.js";
import { DRIFT, READ_DRIFT } from "./contract.js";
import { GITLEAKS_SHA256, GITLEAKS_VERSION, secretGuardSteps } from "./guard.js";
import { classifyDrift } from "./result.js";
import { scanRepo } from "./scan.js";
import type { CheckRun } from "../git/hosts.js";

// Fixtures are real Terraform 1.15.7 output from the random provider:
// generated-random.tf from `plan -generate-config-out` over two import blocks,
// plan-import-only.json from `show -json` of that plan, plan-error.jsonl from
// `plan -json` against a resource that cannot be imported. Variants of
// generated.tf below edit one line of the real file and say which.
const FIX = join(__dirname, "__fixtures__");
const GENERATED = readFileSync(join(FIX, "generated-random.tf"), "utf8");

const ADOPTED = {
  ...scanRepo([
    { path: "infra/main.tf", content: 'terraform {\n  backend "s3" {\n    bucket = "b"\n    key = "k"\n  }\n}\nresource "aws_s3_bucket" "b" {}\n' },
  ]).roots[0],
  generateConfig: true,
};

type Wf = { on: Record<string, unknown>; jobs: Record<string, { steps: { run?: string; uses?: string; name?: string; id?: string; with?: Record<string, unknown> }[] } & Record<string, unknown>> } & Record<string, unknown>;
const apply = () => parse(renderApplyWorkflow(ADOPTED, { branch: "main", repo: "acme/infra" }).content) as Wf;

const has = (cmd: string) => spawnSync("sh", ["-c", `command -v ${cmd}`]).status === 0;
const scratch = () => mkdtempSync(join(tmpdir(), "infralift-apply-"));
/** A terraform that plans successfully and shows `planJson`. */
function stubTerraform(dir: string, planJson: string, planExit = 0, planLog = "") {
  writeFileSync(join(dir, "plan.fixture.json"), planJson);
  writeFileSync(join(dir, "plan.fixture.log"), planLog);
  writeFileSync(
    join(dir, "terraform"),
    `#!/bin/sh\ncase "$1" in\n  plan) cat "${dir}/plan.fixture.log"; exit ${planExit} ;;\n  show) cat "${dir}/plan.fixture.json" ;;\nesac\n`
  );
  chmodSync(join(dir, "terraform"), 0o755);
}
const bash = (script: string, cwd: string, env: Record<string, string> = {}) =>
  spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", script], {
    cwd,
    encoding: "utf8",
    env: { PATH: `${cwd}:${process.env.PATH}`, RUNNER_TEMP: cwd, GITHUB_STEP_SUMMARY: join(cwd, "summary"), GITHUB_OUTPUT: join(cwd, "out"), ...env },
  });

describe("the apply workflow", () => {
  it("applies only on a push to the default branch, never on a pull request or the schedule", () => {
    const wf = apply();
    expect(Object.keys(wf.on)).toEqual(["push"]);
    expect(wf.on.push).toEqual({ branches: ["main"], paths: ["infra/**", applyWorkflowPath("infra")] });
    for (const job of Object.values(wf.jobs)) {
      expect(job.if).toContain("github.event_name == 'push' && github.ref == 'refs/heads/main'");
      // A fork's copy of the workflow never plans or applies.
      expect(job.if).toContain("github.repository == 'acme/infra'");
    }
    // The import check gains no apply and no push trigger.
    const check = renderImportCheck(ADOPTED).content;
    expect(Object.keys(parse(check).on)).toEqual(["pull_request", "schedule", "workflow_dispatch"]);
    expect(check).not.toMatch(/\b(terraform|tofu) apply\b|upload-artifact|environment:/);
  });

  it("applies exactly the saved plan, in production, with the lock file it was made with", () => {
    const wf = apply();
    const { plan, apply: job } = wf.jobs;
    expect(job.environment).toBe("production");
    expect(plan).not.toHaveProperty("environment");
    expect(job.needs).toBe("plan");
    expect(job.if).toMatch(/^needs\.plan\.outputs\.apply == 'true' && /);
    const planRun = plan.steps.find((s) => s.id === "plan")!.run!;
    expect(planRun).toContain("terraform plan -input=false -no-color -json -out=infralift.tfplan");
    expect(planRun).not.toContain("-lock=false");
    const upload = plan.steps.find((s) => s.uses === "actions/upload-artifact@v4")!;
    expect(upload.with!.path).toBe("infra/infralift.tfplan\ninfra/.terraform.lock.hcl\n");
    expect(upload.with!["include-hidden-files"]).toBe(true);
    expect(job.steps.find((s) => s.uses === "actions/download-artifact@v4")!.with).toEqual({ name: "infralift-plan-infra", path: "infra" });
    expect(job.steps.find((s) => s.name === "Init")!.run).toContain("terraform init -input=false -lockfile=readonly");
    expect(job.steps.at(-1)!.run).toBe("terraform apply -input=false -no-color infralift.tfplan\n");
    expect(Object.values(wf.jobs).flatMap((j) => j.steps.map((s) => s.run ?? "")).join("\n")).not.toContain("-auto-approve");
  });

  it("runs bash with pipefail, reads only, and is never cancelled by anything", () => {
    const wf = apply() as Wf & { defaults: { run: { shell: string } } };
    expect(wf.defaults.run.shell).toBe("bash");
    for (const job of Object.values(wf.jobs)) expect((job.defaults as { run: { shell: string } }).run.shell).toBe("bash");
    expect(wf.permissions).toEqual({ contents: "read", "id-token": "write" });
    expect(wf.concurrency).toEqual({ group: "infralift-apply-infra", "cancel-in-progress": false });
    // The check's group cancels in progress; the two must never meet.
    expect(parse(renderImportCheck(ADOPTED).content).concurrency.group).not.toBe("infralift-apply-infra");
  });

  it("uses the same backend credentials as the check", () => {
    const content = renderApplyWorkflow(ADOPTED, { branch: "main", repo: "acme/infra" }).content;
    expect(content).toContain("AWS_SECRET_ACCESS_KEY: ${{ steps.aws.outputs.aws-secret-access-key || secrets.AWS_SECRET_ACCESS_KEY }}");
    // OIDC is offered, so a sign-in step can ask for a token; nothing writes.
    expect(apply().permissions).toEqual({ contents: "read", "id-token": "write" });
  });

  it("refuses a branch or repository it would have to escape", () => {
    expect(() => renderApplyWorkflow(ADOPTED, { branch: "main' || true || '", repo: "acme/infra" })).toThrow(/branch/);
    expect(() => renderApplyWorkflow(ADOPTED, { branch: "-x", repo: "acme/infra" })).toThrow(/branch/);
    expect(() => renderApplyWorkflow(ADOPTED, { branch: "main", repo: "acme/infra'" })).toThrow(/repository/);
  });

  it("applies nothing when the plan imports and changes nothing", () => {
    const step = apply().jobs.plan.steps.find((s) => s.id === "plan")!;
    const real = readFileSync(join(FIX, "plan-import-only.json"), "utf8");
    const dir = scratch();
    stubTerraform(dir, real);
    expect(bash(step.run!, dir).status).toBe(0);
    expect(readFileSync(join(dir, "out"), "utf8")).toBe("apply=true\n");
    expect(readFileSync(join(dir, "summary"), "utf8")).toContain("2 to import, 0 to change.");

    // The same plan once applied: nothing imports any more.
    const applied = JSON.parse(real);
    for (const rc of applied.resource_changes) delete rc.change.importing;
    const again = scratch();
    stubTerraform(again, JSON.stringify(applied));
    const r = bash(step.run!, again);
    expect(r.status).toBe(0);
    expect(readFileSync(join(again, "out"), "utf8")).toBe("apply=false\n");
  });
});

describe("drift on an adopted module that was never applied", () => {
  const driftGate = () => parse(renderImportCheck(ADOPTED).content).jobs.drift.steps.find((s: { id?: string }) => s.id === "gate").run as string;

  it("says not yet applied, not no drift, when the plan only imports", () => {
    const dir = scratch();
    stubTerraform(dir, readFileSync(join(FIX, "plan-import-only.json"), "utf8"));
    const r = bash(driftGate(), dir, { MODULE_LABEL: "infra" });
    expect(r.status).toBe(0);
    const msg = DRIFT.unapplied("2", "2");
    expect(r.stdout.trim()).toBe(`::notice::${msg}`);
    expect(READ_DRIFT.unapplied(msg)).toBe(true);
    expect(READ_DRIFT.none(msg)).toBe(false);
    expect(readFileSync(join(dir, "summary"), "utf8")).toContain("Adopted, not yet applied");
  });

  it("classifies that notice as unapplied, and no drift still as none", () => {
    const run = (message: string): CheckRun => ({
      status: "completed",
      conclusion: "success",
      url: "https://github.com/acme/infra/runs/1",
      completedAt: "2026-11-10T06:30:00Z",
      title: null,
      annotations: [{ level: "notice", message }],
    }) as unknown as CheckRun;
    expect(classifyDrift(run(DRIFT.unapplied("2", "2")), "main").state).toBe("unapplied");
    expect(classifyDrift(run("No changes: all 2 resources match the code."), "main").state).toBe("none");
  });

  it("prints a failed plan's error diagnostics, not its output", () => {
    const dir = scratch();
    const log = readFileSync(join(FIX, "plan-error.jsonl"), "utf8");
    stubTerraform(dir, "{}", 1, log);
    const r = bash(driftGate(), dir, { MODULE_LABEL: "infra" });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("Error: Resource Import Not Implemented: This resource does not support import.");
    expect(r.stdout).not.toContain("@message");
    expect(r.stdout).not.toContain("Plan: 0 to add");
  });
});

describe("the secret guard on generated.tf", () => {
  const [install, guard] = secretGuardSteps();
  const awkOnly = /awk '[\s\S]*?' generated\.tf/.exec(guard.run!)![0];

  const scan = (content: string) => {
    const dir = scratch();
    writeFileSync(join(dir, "generated.tf"), content);
    return bash(awkOnly, dir);
  };

  it("pins gitleaks and verifies its checksum before running it", () => {
    expect(install.run).toContain(`/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz`);
    expect(install.run).toContain(`echo "${GITLEAKS_SHA256}  gitleaks.tgz" | sha256sum -c -`);
    expect(guard.env).toEqual({ GITLEAKS: "${{ runner.temp }}/gitleaks" });
  });

  it("passes real generated code", () => {
    expect(scan(GENERATED).status).toBe(0);
  });

  it("blocks a literal password and names the line, never the value", () => {
    // The real file with one line edited.
    const r = scan(GENERATED.replace("  override_special = null", '  admin_password = "hunter2-literal-value"'));
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("generated.tf:14: admin_password holds a literal value\n");
    expect(r.stdout).not.toContain("hunter2");
  });

  it("passes what Terraform writes for a sensitive attribute, and references to secrets", () => {
    for (const line of ["  admin_password = null # sensitive", '  secret_arn = "arn:aws:secretsmanager:us-east-1:1:secret:x"', "  token_length = 32", '  password = ""']) {
      expect(scan(GENERATED.replace("  override_special = null", line)).status, line).toBe(0);
    }
  });

  it("blocks a config_vars map with values, inline or across lines, and passes an empty one", () => {
    expect(scan(GENERATED.replace("  override_special = null", '  config_vars = {\n    DATABASE_URL = "x"\n  }')).status).toBe(1);
    expect(scan(GENERATED.replace("  override_special = null", '  config_vars = { A = "b" }')).status).toBe(1);
    expect(scan(GENERATED.replace("  override_special = null", "  config_vars = {\n  }")).status).toBe(0);
  });

  it.skipIf(!has("gitleaks") || !has("jq"))("runs gitleaks too, and stops the commit on either finding", () => {
    const run = (content: string) => {
      const dir = scratch();
      writeFileSync(join(dir, "generated.tf"), content);
      const gitleaks = spawnSync("sh", ["-c", "command -v gitleaks"], { encoding: "utf8" }).stdout.trim();
      mkdirSync(join(dir, "bin"));
      copyFileSync(gitleaks, join(dir, "bin/gitleaks"));
      chmodSync(join(dir, "bin/gitleaks"), 0o755);
      return bash(guard.run!, dir, { GITLEAKS: join(dir, "bin/gitleaks") });
    };
    expect(run(GENERATED).status).toBe(0);
    // A token-shaped value in an attribute the name list does not cover, made
    // here so no token-shaped string is committed.
    const token = `ghp_${randomBytes(27).toString("base64").replace(/[^A-Za-z0-9]/g, "a").slice(0, 36)}`;
    const leaked = run(GENERATED.replace("  override_special = null", `  description = "${token}"`));
    expect(leaked.status).toBe(1);
    expect(leaked.stdout).toContain("gitleaks rule github-pat");
    expect(leaked.stdout).toContain("::error::generated.tf was not committed");
    expect(leaked.stdout).not.toContain(token);
  });

  it("is wired between generating and committing", () => {
    const steps = parse(renderImportCheck(ADOPTED).content).jobs.plan.steps as { id?: string; name?: string; if?: string }[];
    const at = (id: string) => steps.findIndex((s) => s.id === id || s.name === id);
    expect(at("gen")).toBeLessThan(at("guard"));
    expect(at("guard")).toBeLessThan(at("gate"));
    expect(steps[at("Commit the generated code")].if).toContain("steps.guard.outcome == 'success'");
  });
});

describe.skipIf(!has("actionlint"))("actionlint", () => {
  it("accepts the rendered check and apply workflows", () => {
    const dir = scratch();
    mkdirSync(join(dir, ".github/workflows"), { recursive: true });
    const files = [renderImportCheck(ADOPTED), renderApplyWorkflow(ADOPTED, { branch: "main", repo: "acme/infra" })];
    for (const f of files) writeFileSync(join(dir, f.path), f.content);
    const r = spawnSync("actionlint", files.map((f) => f.path), { cwd: dir, encoding: "utf8" });
    expect(r.stdout + r.stderr).toBe("");
    expect(r.status).toBe(0);
  });
});
