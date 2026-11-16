// Plans the AWS catalog stacks against moto, the AWS emulator the e2e suite
// already uses (docker-compose.e2e.yml), so a stack that validates but cannot
// plan, because a data source or a module wiring is wrong, fails here rather
// than in a customer's first CI run.
//
//   MOTO_ENDPOINT=http://127.0.0.1:55000 pnpm --filter @infralift/api plan:stacks
//
// Nothing here reaches AWS: every request goes to MOTO_ENDPOINT through
// AWS_ENDPOINT_URL, with moto's fixed test credentials. Needs tofu on PATH.
//
// What runs, in order, because each stack needs the one before it:
//
//   network-baseline       applied, then planned again, which must change
//                          nothing: the stack converges.
//   postgres-with-backups  planned into that VPC and its private subnets.
//                          (It also applies in moto, but moto does not report
//                          a parameter group's parameters back, so a second
//                          plan always shows a change there; not checked.)
//   static-site-cdn        planned against a Route 53 zone made for it. Not
//                          applied: moto cannot publish a CloudFront Function.
//   any other AWS stack    planned with its example inputs.
//
// Each stack is rendered with its example inputs, with backend.tf removed so
// state stays local, and an override file that fills in the emulator's
// provider settings.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { listStacks, renderStack, type StackManifest } from "../src/lib/stacks/index.js";
import type { TfArguments } from "../src/lib/tf/render.js";
import { providerVersion } from "../src/lib/tf/baseline.js";

const endpoint = process.env.MOTO_ENDPOINT;
if (!endpoint) {
  if (process.env.CI) {
    console.error("MOTO_ENDPOINT is not set, and CI must plan the AWS stacks against moto");
    process.exit(1);
  }
  console.log("skip: MOTO_ENDPOINT is not set (start moto: docker compose -f docker-compose.e2e.yml up -d moto)");
  process.exit(0);
}

// A service container can still be starting when the job reaches this step.
async function waitForMoto(url: string): Promise<void> {
  for (let i = 0; i < 30; i++) {
    try {
      if ((await fetch(`${url}/moto-api/data.json`, { signal: AbortSignal.timeout(2000) })).ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.error(`FAIL moto did not answer at ${url} within 30 seconds`);
  process.exit(1);
}
await waitForMoto(endpoint);

const env = {
  ...process.env,
  AWS_ENDPOINT_URL: endpoint,
  AWS_ACCESS_KEY_ID: "test",
  AWS_SECRET_ACCESS_KEY: "test",
  TF_IN_AUTOMATION: "1",
  TF_PLUGIN_CACHE_DIR: process.env.TF_PLUGIN_CACHE_DIR ?? mkdtempSync(join(tmpdir(), "moto-plugins-")),
};

/** Runs tofu, failing unless it exits with one of okCodes. Returns the exit
 *  code and the output, which plans are read from. */
function tofu(cwd: string, args: string[], okCodes = [0]): { code: number; out: string } {
  let code = 0;
  let out = "";
  try {
    out = execFileSync("tofu", args, { cwd, env, stdio: "pipe" }).toString();
  } catch (err) {
    const e = err as { status?: number | null; stdout?: Buffer; stderr?: Buffer };
    if (typeof e.status !== "number") throw err;
    code = e.status;
    out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
  if (!okCodes.includes(code)) {
    throw new Error(`tofu ${args.join(" ")} exited ${code} in ${cwd}, expected ${okCodes.join(" or ")}:\n${out}`);
  }
  return { code, out };
}

// Provider settings for the emulator, merged into the stack's own provider
// blocks by OpenTofu's override-file rules. Every alias the stack declares
// needs its own block.
const providerOverride = (alias?: string) => `provider "aws" {
${alias ? `  alias                       = "${alias}"\n` : ""}  skip_credentials_validation = true
  skip_requesting_account_id  = true
  skip_metadata_api_check     = true
  s3_use_path_style           = true
}
`;

/** Renders a stack into a fresh directory, ready for a local-state plan.
 *  Returns the directory holding its root module. */
function renderForMoto(stack: StackManifest, inputs: TfArguments, root: string): string {
  let rootDir = "";
  for (const f of renderStack(stack, { ...stack.example, ...inputs })) {
    const full = join(root, f.path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, f.content);
    if (f.path.endsWith("/main.tf") && !f.path.includes("/modules/") && !f.path.includes("/bootstrap/")) {
      rootDir = dirname(full);
    }
  }
  if (!rootDir) throw new Error(`${stack.slug} rendered no root main.tf`);
  unlinkSync(join(rootDir, "backend.tf"));
  const aliases = stack.slug === "static-site-cdn" ? [undefined, "us_east_1"] : [undefined];
  writeFileSync(join(rootDir, "moto_override.tf"), aliases.map(providerOverride).join("\n"));
  tofu(rootDir, ["init", "-input=false", "-no-color"]);
  return rootDir;
}

/** A plan that must succeed and must create something. Returns its summary. */
function planCreates(dir: string): string {
  const { code, out } = tofu(dir, ["plan", "-input=false", "-no-color", "-detailed-exitcode"], [2]);
  const summary = out.match(/^Plan: .*$/m)?.[0];
  if (code !== 2 || !summary) throw new Error(`expected a plan that creates resources in ${dir}:\n${out}`);
  return summary;
}

const work = mkdtempSync(join(tmpdir(), "moto-stacks-"));
const aws = listStacks().filter((s) => s.target.slug === "aws");
const bySlug = new Map(aws.map((s) => [s.slug, s]));
let failures = 0;

function step(label: string, fn: () => string) {
  try {
    console.log(`ok   ${label}: ${fn()}`);
  } catch (err) {
    failures++;
    console.error(`FAIL ${label}\n${(err as Error).message}`);
  }
}

try {
  const network = bySlug.get("network-baseline");
  let vpcId = "";
  let subnetIds = "";
  if (network) {
    step("network-baseline: apply, then a second plan changes nothing", () => {
      const dir = renderForMoto(network, {}, join(work, "network"));
      const applied = tofu(dir, ["apply", "-auto-approve", "-input=false", "-no-color"]).out;
      const again = tofu(dir, ["plan", "-input=false", "-no-color", "-detailed-exitcode"], [0, 2]);
      if (again.code !== 0) throw new Error(`the second plan would change something:\n${again.out}`);
      vpcId = tofu(dir, ["output", "-raw", "vpc_id"]).out.trim();
      subnetIds = tofu(dir, ["output", "-raw", "private_subnet_ids_csv"]).out.trim();
      return `${applied.match(/^Apply complete!.*$/m)?.[0] ?? "applied"} No changes on the second plan.`;
    });
  }

  const postgres = bySlug.get("postgres-with-backups");
  if (postgres) {
    step("postgres-with-backups: plan into the network-baseline VPC", () => {
      if (!vpcId || !subnetIds) throw new Error("network-baseline did not apply, so there is no VPC to plan into");
      const dir = renderForMoto(postgres, { vpc_id: vpcId, subnet_ids: subnetIds }, join(work, "postgres"));
      return planCreates(dir);
    });
  }

  const site = bySlug.get("static-site-cdn");
  if (site) {
    step("static-site-cdn: plan against a Route 53 zone", () => {
      const zone = String(site.example.zone);
      const zoneDir = join(work, "zone");
      mkdirSync(zoneDir, { recursive: true });
      writeFileSync(
        join(zoneDir, "main.tf"),
        `terraform {\n  required_providers {\n    aws = { source = "hashicorp/aws", version = "${providerVersion("hashicorp/aws")}" }\n  }\n}\n` +
          `provider "aws" {\n  region = "us-east-1"\n}\nresource "aws_route53_zone" "site" {\n  name = "${zone}"\n}\n`
      );
      writeFileSync(join(zoneDir, "moto_override.tf"), providerOverride());
      tofu(zoneDir, ["init", "-input=false", "-no-color"]);
      tofu(zoneDir, ["apply", "-auto-approve", "-input=false", "-no-color"]);
      const dir = renderForMoto(site, {}, join(work, "site"));
      return planCreates(dir);
    });
  }

  for (const stack of aws) {
    if (["network-baseline", "postgres-with-backups", "static-site-cdn"].includes(stack.slug)) continue;
    step(`${stack.slug}: plan with its example inputs`, () => planCreates(renderForMoto(stack, {}, join(work, stack.slug))));
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

if (aws.length === 0) {
  console.error("FAIL no AWS stacks in the catalog, so nothing was planned");
  failures++;
}
process.exit(failures ? 1 : 0);
