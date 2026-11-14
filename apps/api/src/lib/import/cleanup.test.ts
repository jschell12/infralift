import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { CLEANUP_STEP_NAME, GENERATED_CLEANUP_RULES, cleanupAwk, cleanupStep } from "./cleanup.js";
import { renderImportCheck } from "./check.js";
import { renderAdoption, planAdoption } from "./adopt.js";
import { scanRepo } from "./scan.js";
import { providerSource } from "../tf/codegen.js";

// The fixtures are real `plan -generate-config-out` output from the e2e stack
// (moto 5.2.5, OpenTofu 1.12.6, hashicorp/aws 6.73.0) on 2026-11-14: one from
// a `make e2e` run, one from API-created resources on the same stack. Each
// file's header says how. moto, not real AWS.
const FIX = join(__dirname, "__fixtures__");
const MOTO = readFileSync(join(FIX, "generated-aws-moto.tf"), "utf8");
const API_CREATED = readFileSync(join(FIX, "generated-aws-moto-api-created.tf"), "utf8");
const RANDOM = readFileSync(join(FIX, "generated-random.tf"), "utf8");

const ALL_TYPES = Object.keys(GENERATED_CLEANUP_RULES);

/** Runs the step's script, as the workflow does, against `content` as
 *  generated.tf. Uses the awk on PATH: BSD awk on a Mac, mawk on CI's ubuntu
 *  (the e2e suite covers busybox). */
function clean(content: string, types: string[] = ALL_TYPES) {
  const dir = mkdtempSync(join(tmpdir(), "infralift-cleanup-"));
  writeFileSync(join(dir, "generated.tf"), content);
  const step = cleanupStep(types)!;
  const r = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", step.run!], { cwd: dir, encoding: "utf8" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, result: readFileSync(join(dir, "generated.tf"), "utf8") };
}

/** `content` without these exact lines (each must occur exactly once). */
function without(content: string, lines: string[]): string {
  let out = content;
  for (const l of lines) {
    const hits = out.split("\n").filter((x) => x === l).length;
    expect(hits, `expected exactly one line ${JSON.stringify(l)} in the fixture`).toBe(1);
    out = out.replace(`${l}\n`, "");
  }
  return out;
}

/** The lines the cleanup should remove from generated-aws-moto.tf, read off
 *  the fixture: these are the lines `tofu validate` rejected there. */
const MOTO_REMOVED = [
  '  name_prefix            = ""',
  '  availability_zone_id                           = "use1-az6"',
  "  enable_lni_at_device_index                     = 0",
  '  ipv6_cidr_block                                = ""',
  '  log_group_class             = ""',
  '  name_prefix                 = ""',
  '  deduplication_scope               = ""',
  '  fifo_throughput_limit             = ""',
  '  kms_master_key_id                 = ""',
  '  name_prefix                       = ""',
  '  fifo_throughput_scope                    = ""',
  "  maximum_message_size                     = 0",
  '  name_prefix                              = ""',
  "  signature_version                = 0",
  '  tracing_config = ""',
  '  custom_key_store_id                = ""',
  "  rotation_period_in_days = 0",
  '  xks_key_id = ""',
  "    recovery_period_in_days = 0",
  '  ipv6_cidr_block                      = ""',
  '  ipv6_ipam_pool_id                    = ""',
  "  ipv6_netmask_length                  = 0",
  '  bucket_prefix       = ""',
];

describe("cleaning generated AWS code (hashicorp/aws 6.73.0, captured on moto)", () => {
  it("removes exactly the lines the provider rejected, and changes nothing else", () => {
    const r = clean(MOTO);
    expect(r.status, r.stderr).toBe(0);
    expect(r.result).toBe(without(MOTO, MOTO_REMOVED));
  });

  it("logs each removal by line, attribute and resource, never by value", () => {
    const r = clean(MOTO);
    const log = r.stdout.trim().split("\n");
    expect(log).toHaveLength(MOTO_REMOVED.length + 1);
    expect(log).toContain("generated.tf:271: removed bucket_prefix from aws_s3_bucket.e2e_handmade_assets: computed from the bucket name, which is set; the two conflict");
    expect(log).toContain(
      "generated.tf:234: removed point_in_time_recovery.recovery_period_in_days from aws_dynamodb_table.e2e_handmade_sessions: 0 means not set, and the provider rejects 0 as out of range"
    );
    expect(log.at(-1)).toBe(`removed ${MOTO_REMOVED.length} generated attribute(s) the provider rejects`);
    // The availability zone id is a real value; the log must not carry it.
    expect(r.stdout).not.toContain("use1-az6");
    expect(r.stdout).not.toContain("e2e-handmade");
  });

  it("was captured on the provider version adoption pins, so the pin cannot move without new fixtures", () => {
    // The table is only as good as the version it was measured on. Adoption
    // allows patch releases of that minor and nothing newer.
    const pin = providerSource("aws")!.version;
    expect(pin).toMatch(/^~> \d+\.\d+\.\d+$/);
    const minor = pin.replace(/^~> (\d+\.\d+)\.\d+$/, "$1");
    for (const [name, fixture] of [["generated-aws-moto.tf", MOTO], ["generated-aws-moto-api-created.tf", API_CREATED]]) {
      const captured = /hashicorp\/aws (\d+\.\d+)\.\d+/.exec(fixture.split("# __generated__")[0])?.[1];
      expect(captured, name).toBe(minor);
    }
  });

  it("every rule in the table is exercised by a captured snippet", () => {
    const log = clean(MOTO).stdout;
    for (const [type, rules] of Object.entries(GENERATED_CLEANUP_RULES)) {
      for (const rule of rules) expect(log, `${type} ${rule.attribute}`).toMatch(new RegExp(` removed ${rule.attribute.replace(".", "\\.")} from ${type}\\.`));
    }
  });

  it("keeps a real value where the rule names a placeholder", () => {
    const edited = MOTO.replace("  signature_version                = 0", "  signature_version                = 2")
      .replace("  rotation_period_in_days = 0", "  rotation_period_in_days = 365")
      .replace('  tracing_config = ""', '  tracing_config = "Active"')
      .replace('  kms_master_key_id                 = ""', '  kms_master_key_id                 = "alias/queue-key"');
    const r = clean(edited);
    // A queue encrypted with a customer key keeps it.
    expect(r.result).toContain('  kms_master_key_id                 = "alias/queue-key"\n');
    expect(r.result).toContain("  signature_version                = 2\n");
    expect(r.result).toContain("  rotation_period_in_days = 365\n");
    expect(r.result).toContain('  tracing_config = "Active"\n');
  });

  it("keeps a name prefix when the block does not set the name it would be derived from", () => {
    for (const bucket of ["", '  bucket              = null\n', '  bucket              = ""\n']) {
      const edited = MOTO.replace('  bucket              = "e2e-handmade-assets"\n', bucket);
      expect(clean(edited).result, JSON.stringify(bucket)).toContain('  bucket_prefix       = ""\n');
    }
  });

  it("matches a nested attribute only inside its block, and a top-level one only at the top", () => {
    // recovery_period_in_days is a rule only inside point_in_time_recovery.
    const top = MOTO.replace("  billing_mode                = \"PAY_PER_REQUEST\"\n", '  billing_mode                = "PAY_PER_REQUEST"\n  recovery_period_in_days     = 0\n');
    expect(clean(top).result).toContain("  recovery_period_in_days     = 0\n");
    // A rule for one type does not fire on another type's attribute of the same name.
    const r = clean(MOTO, ["aws_vpc"]);
    expect(r.result).toContain('  ipv6_cidr_block                                = ""\n'); // the subnet's
    expect(r.result).not.toContain('  ipv6_cidr_block                      = ""\n'); // the vpc's
  });
});

describe("what the cleanup will not touch", () => {
  it("leaves key_usage = \"\" for the gate to refuse: removing it would plan a replacement on moto", () => {
    const r = clean(API_CREATED);
    expect(r.status, r.stderr).toBe(0);
    expect(r.result).toContain('  key_usage                          = ""\n');
    // The rules that do apply to this key and queue still do, and the queue
    // keeps its 1 MiB size: no rule touches it, and 6.x accepts it.
    expect(r.result).toBe(
      without(API_CREATED, [
        '  deduplication_scope               = ""',
        '  fifo_throughput_limit             = ""',
        '  kms_master_key_id                 = ""',
        '  name_prefix                       = ""',
        '  custom_key_store_id                = ""',
        "  rotation_period_in_days = 0",
        '  xks_key_id              = ""',
      ])
    );
    expect(r.result).toContain("  max_message_size                  = 1048576\n");
  });

  it("passes code for types with no rules through byte for byte", () => {
    const r = clean(RANDOM);
    expect(r.result).toBe(RANDOM);
    expect(r.stdout).toBe("nothing to remove from generated.tf\n");
  });

  it("handles an empty file and a file with no resource blocks", () => {
    expect(clean("")).toMatchObject({ status: 0, result: "", stdout: "nothing to remove from generated.tf\n" });
    const comments = "# __generated__ by OpenTofu\n# Please review these resources.\n";
    expect(clean(comments).result).toBe(comments);
  });

  it("treats a heredoc body as text, even where it looks like an attribute or a closing brace", () => {
    const heredoc = [
      'resource "aws_s3_bucket" "assets" {',
      '  bucket        = "assets"',
      "  description   = <<-EOT",
      '  bucket_prefix = ""',
      "}",
      "  EOT",
      '  bucket_prefix = ""',
      "}",
      "",
    ].join("\n");
    const r = clean(heredoc);
    expect(r.result).toBe(heredoc.replace('  EOT\n  bucket_prefix = ""\n', "  EOT\n"));
  });

  it("passes a block that never closes through as it was", () => {
    const open = 'resource "aws_s3_bucket" "assets" {\n  bucket        = "assets"\n  bucket_prefix = ""\n';
    expect(clean(open).result).toBe(open);
  });

  it("does not cut a value that spans lines", () => {
    const multi = 'resource "aws_sns_topic" "t" {\n  name        = "t"\n  name_prefix = <<-EOT\n    x\n  EOT\n  tracing_config = [\n  ]\n}\n';
    expect(clean(multi).result).toBe(multi);
  });
});

describe("the cleanup step in the import check", () => {
  const adoption = (arns: string[]) =>
    renderAdoption({
      provider: "aws",
      plan: planAdoption("aws", arns.map((arn) => ({ provider: "aws", type: "aws:any", externalId: arn, name: "thing", region: "us-east-1", metadata: { arn } }))),
      backend: { kind: "s3", bucket: "state-bucket", key: "infra/terraform.tfstate", region: "us-east-1" },
      path: "infra",
      label: "infra",
    }).root;

  it("runs after generation and before the secret guard and the gate", () => {
    const wf = parse(renderImportCheck(adoption(["arn:aws:s3:::assets"])).content);
    const names = wf.jobs.plan.steps.map((s: { name?: string }) => s.name);
    const at = (n: string) => names.indexOf(n);
    expect(at(CLEANUP_STEP_NAME)).toBe(at("Generate code for the imported resources") + 1);
    expect(at(CLEANUP_STEP_NAME)).toBeLessThan(at("Check the generated code holds no secrets"));
    expect(at(CLEANUP_STEP_NAME)).toBeLessThan(at("Plan (read-only, no lock)"));
    const step = wf.jobs.plan.steps[at(CLEANUP_STEP_NAME)];
    expect(step.if).toBe("steps.gen.outcome == 'success'");
    // Only the rules for the module's own types are written.
    expect(step.run).toContain('derived["aws_s3_bucket bucket_prefix"] = "bucket"');
    expect(step.run).not.toContain("aws_kms_key");
  });

  it("is left out when no rule covers the module, and for a repository import", () => {
    expect(cleanupStep(["random_string"])).toBeNull();
    const wf = parse(renderImportCheck(adoption([`arn:aws:lambda:us-east-1:123456789012:function:resize`])).content);
    expect(wf.jobs.plan.steps.map((s: { name?: string }) => s.name)).not.toContain(CLEANUP_STEP_NAME);
    const repo = scanRepo([{ path: "infra/main.tf", content: 'resource "aws_s3_bucket" "a" {\n  bucket = "a"\n}\n' }]).roots[0];
    expect(renderImportCheck(repo).content).not.toContain(CLEANUP_STEP_NAME);
  });

  it("says in the generated commit that attributes were removed, only when the step exists", () => {
    const withStep = renderImportCheck(adoption(["arn:aws:s3:::assets"])).content;
    const without = renderImportCheck(adoption([`arn:aws:lambda:us-east-1:123456789012:function:resize`])).content;
    expect(withStep).toContain("as they run, minus attributes the provider rejects in its own output");
    expect(without).toContain("as they run. Edit freely");
    expect(without).not.toContain("minus attributes");
  });

  it("is never in the drift job, which does not generate", () => {
    const wf = parse(renderImportCheck(adoption(["arn:aws:s3:::assets"])).content);
    expect(wf.jobs.drift.steps.map((s: { name?: string }) => s.name)).not.toContain(CLEANUP_STEP_NAME);
  });

  it("refuses to write a rule whose name or reason could break out of the awk program", () => {
    expect(() => cleanupAwk([["aws_s3_bucket", [{ attribute: "x", placeholder: '""', why: "it's quoted" }]]])).toThrow(/reason/);
    expect(() => cleanupAwk([["aws_s3_bucket", [{ attribute: 'x"]', placeholder: '""', why: "fine" }]]])).toThrow(/attribute/);
    expect(() => cleanupAwk([["aws s3", [{ attribute: "x", placeholder: '""', why: "fine" }]]])).toThrow(/type/);
    expect(() => cleanupAwk([["aws_s3_bucket", [{ attribute: "x", derivedFrom: "a.b", why: "fine" }]]])).toThrow(/top-level/);
    // And the table itself passes those checks, with no single quote in the program.
    expect(cleanupAwk(Object.entries(GENERATED_CLEANUP_RULES))).not.toContain("'");
  });
});
