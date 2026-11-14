// ---------------------------------------------------------------------------
// Adopt from an AWS account, end to end, with nothing real.
//
// AWS is moto, GitHub is the fake, the customer's CI is the import check
// workflow infralift committed, its `run:` steps executed verbatim in an
// OpenTofu container against moto. Each step below is a step the customer,
// infralift or the customer's CI takes in production.
// ---------------------------------------------------------------------------

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { CHECK_JOB_NAME, DRIFT, GENERATED_COMMIT_SUBJECT, OUTCOME } from "../src/lib/import/contract.js";
import { api, until } from "./harness/api.js";
import { STACK } from "./harness/env.js";
import { branchFiles, gh, postCheckRun, pushCommit, violations } from "./harness/github.js";
import { runInTofu } from "./harness/tofu.js";
import { parseWorkflow, runStep, type Workflow } from "./harness/workflow.js";
import { removeInvalidEmptyAttributes } from "./harness/fixup.js";
import { FAKE_LOGIN } from "./github-fake/server.js";

const REPO = `${FAKE_LOGIN}/aws-infra`;
const PATH = "infra/aws";
const CHECK_FILE = ".github/workflows/infralift-import-infra-aws.yml";
const APPLY_FILE = ".github/workflows/infralift-apply-infra-aws.yml";
const ADOPTED = {
  bucket: "arn:aws:s3:::e2e-handmade-assets",
  table: `arn:aws:dynamodb:us-east-1:${STACK.awsAccount}:table/e2e-handmade-sessions`,
  topic: `arn:aws:sns:us-east-1:${STACK.awsAccount}:e2e-handmade-events`,
};

const db = new PrismaClient({ datasources: { db: { url: STACK.databaseUrl } } });
const work = mkdtempSync(join(tmpdir(), "infralift-e2e-aws-"));

/** Credentials and settings the customer's repository would hold, as the
 *  values the workflow's `${{ }}` expressions resolve to. The AWS keys and
 *  endpoint come from the tofu service's environment (moto). */
const CI_ENV = {
  OIDC_AWS: "false",
  // The s3 backend reaches moto by path, not by bucket hostname.
  TF_CLI_ARGS_init: "-backend-config=use_path_style=true",
};

let githubId: string;
let awsId: string;
let projectId: string;
let branch: string;
let checkWorkflow: Workflow;

async function ledger() {
  const rows = await db.managedResource.findMany({ where: { projectId }, select: { resourceType: true, providerId: true, status: true } });
  return rows.sort((a, b) => a.providerId.localeCompare(b.providerId));
}

async function readCheck() {
  return (await api("GET", `/tf/imports/${projectId}/check`)).body;
}

/** A fresh checkout of `ref` in `dir`, plus the one file the harness adds:
 *  s3_use_path_style on each aws provider, because moto is reached by path.
 *  The file is never committed. */
async function checkout(ref: string, dir: string): Promise<void> {
  rmSync(dir, { recursive: true, force: true });
  for (const [path, content] of await branchFiles(REPO, ref)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  const providers = readFileSync(join(dir, PATH, "provider.tf"), "utf8");
  const aliases = [...providers.matchAll(/alias\s*=\s*"([^"]+)"/g)].map((m) => m[1]);
  const blocks = [null, ...aliases].map((a) => `provider "aws" {\n${a ? `  alias = "${a}"\n` : ""}  s3_use_path_style = true\n}\n`);
  writeFileSync(join(dir, PATH, "e2e_override.tf"), blocks.join("\n"));
  mkdirSync(join(dir, ".runner"), { recursive: true });
}

const resultOf = (dir: string) => readFileSync(join(dir, ".runner/infralift-result"), "utf8").trim();

beforeAll(async () => {
  // The resources someone built by hand, in moto.
  const seed = join(work, "seed");
  cpSync(new URL("./aws-seed", import.meta.url).pathname, seed, { recursive: true });
  const applied = await runInTofu({ dir: seed, script: "tofu init -input=false -no-color >/dev/null && tofu apply -auto-approve -input=false -no-color" });
  expect(applied.code, applied.output).toBe(0);
  // The customer's repository.
  await gh("POST", "/user/repos", { name: "aws-infra", auto_init: true, private: true });
});

afterAll(async () => {
  await db.$disconnect();
  rmSync(work, { recursive: true, force: true });
});

describe("adopt from an AWS account", () => {
  it("connects GitHub and AWS through the API, as the dashboard does", async () => {
    const github = await api("POST", "/connections", { provider: "github", label: "e2e github", token: STACK.githubToken });
    expect(github.status).toBe(201);
    expect(github.body.status).toBe("valid");
    githubId = github.body.id;

    const aws = await api("POST", "/connections", {
      provider: "aws",
      label: "e2e aws",
      token: JSON.stringify({ roleArn: STACK.awsRoleArn, regions: ["us-east-1"] }),
    });
    expect(aws.status).toBe(201);
    expect(aws.body).toMatchObject({ status: "valid", lastError: null });
    awsId = aws.body.id;
  });

  it("lists the hand-built resources as unmanaged and adoptable", async () => {
    const { status, body } = await api("GET", `/connections/${awsId}/unmanaged?refresh=1`);
    expect(status).toBe(200);
    const byId = new Map(body.resources.map((r: any) => [r.providerId, r]));
    for (const arn of Object.values(ADOPTED)) expect(byId.get(arn), arn).toMatchObject({ adoptable: true });
    expect(byId.get(ADOPTED.bucket)).toMatchObject({ type: "aws:s3_bucket", terraformType: "aws_s3_bucket" });
    expect(byId.get(STACK.awsAccount)).toMatchObject({ type: "aws:account", adoptable: false });
    expect(body.backendDefaults.awsRegion).toBe("us-east-1");
  });

  it("adopts three of them, reserving them in the ledger before any pull request", async () => {
    const { status, body } = await api("POST", `/connections/${awsId}/adopt`, {
      resources: [
        { type: "aws:s3_bucket", providerId: ADOPTED.bucket },
        { type: "aws:dynamodb_table", providerId: ADOPTED.table },
        { type: "aws:sns_topic", providerId: ADOPTED.topic },
      ],
      target: {
        kind: "new",
        name: "aws-e2e",
        repo: REPO,
        gitConnectionId: githubId,
        path: PATH,
        backend: { kind: "s3", bucket: "e2e-tofu-state", key: `${PATH}/terraform.tfstate`, region: "us-east-1" },
      },
    });
    expect(status, JSON.stringify(body)).toBe(202);
    expect(body).toMatchObject({ projectName: "aws-e2e", adopted: 3, replayed: false });
    projectId = body.projectId;

    expect((await ledger()).map((r) => r.status)).toEqual(["pending", "pending", "pending"]);
    const after = await api("GET", `/connections/${awsId}/unmanaged`);
    const left = after.body.resources.map((r: any) => r.providerId);
    for (const arn of Object.values(ADOPTED)) expect(left).not.toContain(arn);
  });

  it("opens one pull request carrying import blocks, a provider, a backend and both workflows", async () => {
    const check = await until("the adoption pull request", readCheck, (c) => c.state !== "no-pr");
    expect(check.state).toBe("waiting");
    const pulls = await gh<any[]>("GET", `/repos/${REPO}/pulls?state=open`);
    expect(pulls).toHaveLength(1);
    branch = pulls[0].head.ref;
    expect(pulls[0].base.ref).toBe("main");

    const files = await branchFiles(REPO, branch);
    expect([...files.keys()].sort()).toEqual([APPLY_FILE, CHECK_FILE, "README.md", `${PATH}/imports.tf`, `${PATH}/provider.tf`, `${PATH}/versions.tf`].sort());
    const imports = files.get(`${PATH}/imports.tf`)!;
    expect(imports.match(/^import \{/gm)).toHaveLength(3);
    expect(imports).toContain('id       = "e2e-handmade-assets"');
    expect(imports).toContain('id       = "e2e-handmade-sessions"');
    expect(imports).toContain(`id       = "${ADOPTED.topic}"`);
    expect(files.get(`${PATH}/versions.tf`)).toContain('backend "s3"');
    expect(files.has(`${PATH}/generated.tf`)).toBe(false);
    checkWorkflow = parseWorkflow(files.get(CHECK_FILE)!);
  });

  const dir = join(work, "checkout");

  it("runs the import check as committed: code is generated, and the plan fails before comparing", async () => {
    await checkout(branch, dir);
    for (const name of ["Check the credentials are set", "Init", "Generate code for the imported resources"]) {
      const step = await runStep({ wf: checkWorkflow, job: "plan", name, dir, env: CI_ENV });
      expect(step.code, `${name}:\n${step.output}`).toBe(0);
    }
    const generated = readFileSync(join(dir, PATH, "generated.tf"), "utf8");
    expect(generated.match(/^resource "/gm)).toHaveLength(3);

    // hashicorp/aws ~> 5.0 generates attributes it then rejects (bucket_prefix
    // = "" beside bucket, fifo_throughput_scope = ""), so the gate cannot
    // compare anything yet. ADR 0003 expects hand edits here; this records
    // that for these three kinds they are needed every time.
    const gate = await runStep({ wf: checkWorkflow, job: "plan", name: "Plan (read-only, no lock)", dir, env: CI_ENV });
    expect(gate.code).toBe(1);
    expect(resultOf(dir)).toBe(OUTCOME.planFailed);

    // "Commit the generated code": generated.tf onto the branch, and the
    // run's result recorded on that commit, as the workflow does.
    const head = await pushCommit(REPO, branch, [{ path: `${PATH}/generated.tf`, content: generated }], GENERATED_COMMIT_SUBJECT);
    await postCheckRun(REPO, { name: CHECK_JOB_NAME, headSha: head, conclusion: "failure", title: resultOf(dir) });

    const check = await readCheck();
    expect(check).toMatchObject({ state: "error", message: OUTCOME.planFailed, headSha: head });
    expect((await ledger()).map((r) => r.status)).toEqual(["pending", "pending", "pending"]);
  });

  it("after the customer's edit, the plan imports three resources and changes nothing (ADR 0002)", async () => {
    const removed = await removeInvalidEmptyAttributes(dir, PATH);
    expect(removed.length).toBeGreaterThan(0);
    const head = await pushCommit(REPO, branch, [{ path: `${PATH}/generated.tf`, content: readFileSync(join(dir, PATH, "generated.tf"), "utf8") }], "Remove empty generated attributes the provider rejects");

    // The push runs the workflow again; generated.tf exists, so generation is skipped.
    await checkout(head, dir);
    for (const name of ["Init", "Plan (read-only, no lock)"]) {
      const step = await runStep({ wf: checkWorkflow, job: "plan", name, dir, env: CI_ENV });
      expect(step.code, `${name}:\n${step.output}`).toBe(0);
    }
    expect(resultOf(dir)).toBe(OUTCOME.passed("3"));
    const summary = readFileSync(join(dir, ".runner/summary.md"), "utf8");
    expect(summary).toContain("No changes. All 3 resources match the code");
    expect(summary).toContain("3 resource(s) will be imported into state on apply");
    // Actions turns the step's ::notice:: into an annotation on the job's run.
    await postCheckRun(REPO, { name: CHECK_JOB_NAME, headSha: head, conclusion: "success", title: "", annotation: { level: "notice", message: resultOf(dir), path: CHECK_FILE } });

    const check = await readCheck();
    expect(check).toMatchObject({ state: "passed", message: OUTCOME.passed("3"), headSha: head, prState: "open" });
    expect(await ledger()).toEqual([
      { resourceType: "aws:s3_bucket", providerId: ADOPTED.bucket, status: "managed" },
      { resourceType: "aws:dynamodb_table", providerId: ADOPTED.table, status: "managed" },
      { resourceType: "aws:sns_topic", providerId: ADOPTED.topic, status: "managed" },
    ].sort((a, b) => a.providerId.localeCompare(b.providerId)));
  });

  it("merging runs the apply workflow, which records the resources in state; the drift job then sees no drift (ADR 0008)", async () => {
    const pr = (await gh<any[]>("GET", `/repos/${REPO}/pulls?state=open`))[0];
    await gh("PUT", `/repos/${REPO}/pulls/${pr.number}/merge`, {});
    await checkout("main", dir);
    const applyWorkflow = parseWorkflow((await branchFiles(REPO, "main")).get(APPLY_FILE)!);
    const env = { ...CI_ENV, GITHUB_OUTPUT: "/work/.runner/output" };
    for (const name of ["Init", "Plan", "Apply the plan above"]) {
      const step = await runStep({ wf: applyWorkflow, job: "apply", name, dir, env });
      expect(step.code, `${name}:\n${step.output}`).toBe(0);
    }
    expect(readFileSync(join(dir, ".runner/output"), "utf8")).toContain("apply=true");
    const listed = await runInTofu({ dir, cwd: PATH, script: "tofu state list -no-color" });
    expect(listed.output.trim().split("\n").filter((l) => l.startsWith("aws_")).sort()).toHaveLength(3);

    // The scheduled drift job, on the default branch after the apply.
    rmSync(join(dir, ".runner/infralift-result"), { force: true });
    const drift = await runStep({ wf: checkWorkflow, job: "drift", name: "Plan (read-only, no lock)", dir, env: CI_ENV });
    expect(drift.code, drift.output).toBe(0);
    expect(resultOf(dir)).not.toMatch(/^Not applied yet/);
    expect([DRIFT.none, OUTCOME.passed("3")]).toContain(resultOf(dir));
    expect(existsSync(join(dir, PATH, "infralift-import.tfplan"))).toBe(true);
  });

  it("the GitHub fake saw only requests and answers GitHub documents", async () => {
    expect(await violations()).toEqual([]);
  });
});
