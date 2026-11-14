import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { TfInputValidationError, type TfArguments } from "../tf/render.js";
import { DRIFT, DRIFT_JOB_NAME } from "../import/contract.js";
import { getStack, listStacks, renderStack, resolveStackInputs, type StackManifest } from "./index.js";
import { checkManifest } from "./team.js";

// The infrastructure stacks (ADR 0010): one cloud account's modules, no app.
// Each is rendered from its own example, the inputs validate-stacks and the
// moto plan in CI use, and the rendered files are read for what the stack
// promises: modules where stack.json says, settings in main.tf, a workflow
// that only applies a saved plan on main, and no template placeholders left.

const INFRA = ["network-baseline", "postgres-with-backups", "static-site-cdn"];
const stack = (slug: string) => getStack(slug)!;

function render(slug: string, extra: TfArguments = {}) {
  const s = stack(slug);
  return new Map(renderStack(s, { ...s.example, ...extra }).map((f) => [f.path, f.content]));
}

const names = (hcl: string, block: "variable" | "output") =>
  [...hcl.matchAll(new RegExp(`^${block} "([a-z0-9_]+)"`, "gm"))].map((m) => m[1]).sort();

describe("infrastructure catalog stacks", () => {
  it("are in the catalog, and none carries an app template, runtime or source", () => {
    const slugs = listStacks().map((s) => s.slug);
    for (const slug of INFRA) {
      expect(slugs).toContain(slug);
      const s = stack(slug);
      expect(s.template, slug).toBeUndefined();
      expect(s.runtime, slug).toBeUndefined();
      expect(s.source, slug).toBeUndefined();
      expect(s.target.slug, slug).toBe("aws");
    }
  });

  it.each(INFRA)("%s: the manifest passes the team-stack checks once its patterns are removed", (slug) => {
    // The catalog may use pattern (ADR 0009); everything else a team stack
    // must satisfy, a catalog stack satisfies too.
    const s = stack(slug);
    const strip = (v: unknown): unknown =>
      Array.isArray(v)
        ? v.map(strip)
        : v && typeof v === "object"
          ? Object.fromEntries(Object.entries(v).filter(([k]) => k !== "pattern").map(([k, x]) => [k, strip(x)]))
          : v;
    const paths = new Set(s.rendered.map((r) => `templates/${r.template}`));
    expect(checkManifest({ ...s, inputSchema: strip(s.inputSchema) }, paths)).toEqual([]);
  });

  it.each(INFRA)("%s: renders into infra/<slug>/ and its workflow, leaving no placeholder", (slug) => {
    for (const backend of ["r2", "tfc"]) {
      const files = render(slug, { backend, ...(backend === "tfc" ? { tfc_organization: "acme" } : {}) });
      for (const [path, content] of files) {
        expect(path.startsWith(`infra/${slug}/`) || path === `.github/workflows/${slug}.yml`, path).toBe(true);
        expect(content, path).not.toMatch(/\{\{[#/]?[A-Za-z_]/);
      }
      expect(files.has(`infra/${slug}/main.tf`)).toBe(true);
      expect(files.has(`infra/${slug}/README.md`)).toBe(true);
    }
  });

  it.each(INFRA)("%s: every module stack.json lists is rendered, with the inputs and outputs it lists", (slug) => {
    const files = render(slug);
    const modules = stack(slug).modules ?? [];
    expect(modules.length).toBeGreaterThanOrEqual(2);
    const main = files.get(`infra/${slug}/main.tf`)!;
    for (const m of modules) {
      const body = files.get(`${m.path}/main.tf`);
      expect(body, m.path).toBeDefined();
      expect(body, m.path).toMatch(new RegExp(`^resource "${m.anchor}" `, "m"));
      expect(names(files.get(`${m.path}/variables.tf`)!, "variable"), m.path).toEqual([...(m.inputs ?? [])].sort());
      expect(names(files.get(`${m.path}/outputs.tf`)!, "output"), m.path).toEqual([...(m.outputs ?? [])].sort());
      // The root module calls it.
      expect(main).toContain(`source = "./${m.path.slice(`infra/${slug}/`.length)}"`);
    }
  });

  it.each(INFRA)("%s: pins hashicorp/aws as adoption does, in the root and every module", (slug) => {
    const files = render(slug);
    const versionFiles = [...files].filter(([p, c]) => p.endsWith(".tf") && c.includes('source  = "hashicorp/aws"'));
    expect(versionFiles.length).toBe((stack(slug).modules ?? []).length + 1);
    for (const [path, content] of versionFiles) expect(content, path).toMatch(/version\s+= "~> 5\.0"/);
  });

  it.each(INFRA)("%s: r2 encrypts state and keeps its bucket credentials apart from AWS's", (slug) => {
    const files = render(slug, { backend: "r2" });
    const backend = files.get(`infra/${slug}/backend.tf`)!;
    expect(backend).toContain("encryption {");
    expect(backend).toContain("access_key                  = var.state_access_key_id");
    expect(files.get(`infra/${slug}/backend.r2.hcl.example`)).toContain(`key       = "${slug}/terraform.tfstate"`);
    expect(files.has(`infra/${slug}/bootstrap/main.tf`)).toBe(true);
  });

  it.each(INFRA)("%s: tfc gets a cloud block named after the project, and no R2 files", (slug) => {
    const files = render(slug, { backend: "tfc", tfc_organization: "acme" });
    const backend = files.get(`infra/${slug}/backend.tf`)!;
    expect(backend).toContain('organization = "acme"');
    expect(backend).toContain(`name = "${String(stack(slug).example.name)}"`);
    expect(backend).not.toContain("encryption");
    expect([...files.keys()].some((p) => p.includes("/bootstrap/") || p.endsWith(".hcl.example"))).toBe(false);
  });

  it.each(INFRA)("%s: refuses unknown keys, a bad name, and tfc without an organization", (slug) => {
    const s = stack(slug);
    for (const bad of [
      { ...s.example, extra: "x" },
      { ...s.example, name: "Bad Name" },
      { ...s.example, name: 'x" ; evil = "' },
      { ...s.example, backend: "tfc" },
    ]) {
      expect(() => renderStack(s, bad), JSON.stringify(bad)).toThrow(TfInputValidationError);
    }
  });
});

describe("network-baseline", () => {
  it("puts the settings into main.tf, defaults included", () => {
    const main = render("network-baseline").get("infra/network-baseline/main.tf")!;
    expect(main).toContain('region = "us-east-1"');
    expect(main).toContain('cidr       = "10.0.0.0/16"');
    expect(main).toContain("az_count   = 2");
    expect(main).toContain("single_nat = true");
    expect(main).toContain("retention_days = 30");
  });

  it("renders single_nat false and three zones as HCL literals", () => {
    const main = render("network-baseline", { single_nat: false, az_count: 3 }).get("infra/network-baseline/main.tf")!;
    expect(main).toContain("single_nat = false");
    expect(main).toContain("az_count   = 3");
  });

  it("refuses a public range, a /24, four zones and a retention CloudWatch does not offer", () => {
    const s = stack("network-baseline");
    for (const bad of [{ cidr: "8.8.0.0/16" }, { cidr: "10.0.0.0/24" }, { az_count: 4 }, { flow_log_retention_days: 10 }]) {
      expect(() => renderStack(s, { ...s.example, ...bad }), JSON.stringify(bad)).toThrow(TfInputValidationError);
    }
  });

  it("refuses single_nat as a string, which is what an untyped form would send", () => {
    const s = stack("network-baseline");
    expect(() => renderStack(s, { ...s.example, single_nat: "true" })).toThrow(TfInputValidationError);
  });
});

describe("postgres-with-backups", () => {
  it("passes the settings through, with an empty allowed_cidr meaning the VPC's range", () => {
    const main = render("postgres-with-backups").get("infra/postgres-with-backups/main.tf")!;
    expect(main).toContain('vpc_id                    = "vpc-0a1b2c3d4e5f60718"');
    expect(main).toContain('split(",", "subnet-0a1b2c3d4e5f60718,subnet-0f1e2d3c4b5a69788")');
    expect(main).toContain('allowed_cidr              = ""');
    expect(main).toContain('instance_class            = "db.t4g.micro"');
    expect(main).toContain('engine_version            = "17"');
    expect(main).toContain("backup_retention_days     = 7");
    expect(main).toContain("retention_days = 365");
    const db = render("postgres-with-backups").get("infra/postgres-with-backups/modules/database/main.tf")!;
    expect(db).toContain("var.allowed_cidr != \"\" ? var.allowed_cidr : data.aws_vpc.this.cidr_block");
  });

  it("keeps the master password out of the code: RDS manages it, and nothing asks for one", () => {
    const files = render("postgres-with-backups");
    const db = files.get("infra/postgres-with-backups/modules/database/main.tf")!;
    expect(db).toContain("manage_master_user_password = true");
    expect(db).toMatch(/storage_encrypted = true/);
    expect(db).toMatch(/deletion_protection\s+= true/);
    expect(db).toMatch(/publicly_accessible\s+= false/);
    for (const [path, content] of files) expect(content, path).not.toMatch(/^\s*password\s*=/m);
    expect(Object.keys(stack("postgres-with-backups").inputSchema.properties as object)).not.toContain("password");
  });

  it("refuses one subnet, a malformed VPC id, a CIDR with no prefix and 36 days of backups", () => {
    const s = stack("postgres-with-backups");
    for (const bad of [
      { subnet_ids: "subnet-0a1b2c3d4e5f60718" },
      { vpc_id: "vpc-xyz" },
      { allowed_cidr: "10.0.0.0" },
      { allowed_security_group_id: "group-1" },
      { backup_retention_days: 36 },
      { engine_version: "14" },
    ]) {
      expect(() => renderStack(s, { ...s.example, ...bad }), JSON.stringify(bad)).toThrow(TfInputValidationError);
    }
    expect(() =>
      renderStack(s, { ...s.example, allowed_cidr: "10.20.0.0/16", allowed_security_group_id: "sg-0a1b2c3d4e5f60718" })
    ).not.toThrow();
  });

  it("stores the defaults it filled in, and the stored settings validate again", () => {
    // updateStackSettings re-validates what createStackProject stored, so a
    // default the schema itself refuses (allowed_cidr "") would lock a project.
    const s = stack("postgres-with-backups");
    const stored = resolveStackInputs(s, s.example);
    expect(stored).toMatchObject({ allowed_cidr: "", allowed_security_group_id: "", backend: "r2" });
    expect(() => resolveStackInputs(s, stored)).not.toThrow();
  });
});

describe("static-site-cdn", () => {
  it("serves the domain from the zone, with the certificate in us-east-1", () => {
    const files = render("static-site-cdn", { domain: "docs.acme.io", zone: "acme.io" });
    const main = files.get("infra/static-site-cdn/main.tf")!;
    expect(main).toContain('domain                      = "docs.acme.io"');
    expect(main).toContain('zone_name                   = "acme.io"');
    expect(main).toMatch(/alias\s+= "us_east_1"\n\s+region = "us-east-1"/);
    const cdn = files.get("infra/static-site-cdn/modules/cdn/main.tf")!;
    expect(cdn).toContain('minimum_protocol_version = "TLSv1.2_2021"');
    expect(cdn).toContain('viewer_protocol_policy     = "redirect-to-https"');
    expect(cdn).toContain("origin_access_control_id");
    expect(files.has("infra/static-site-cdn/modules/cdn/index-rewrite.js")).toBe(true);
  });

  it("keeps the bucket private: only this distribution may read it", () => {
    const files = render("static-site-cdn");
    const bucket = files.get("infra/static-site-cdn/modules/site-bucket/main.tf")!;
    for (const flag of ["block_public_acls", "block_public_policy", "ignore_public_acls", "restrict_public_buckets"]) {
      expect(bucket).toMatch(new RegExp(`${flag}\\s+= true`));
    }
    const cdn = files.get("infra/static-site-cdn/modules/cdn/main.tf")!;
    expect(cdn).toContain('variable = "AWS:SourceArn"');
    expect(cdn).toContain("values   = [aws_cloudfront_distribution.site.arn]");
  });

  it("refuses a domain that is not a host name", () => {
    const s = stack("static-site-cdn");
    for (const bad of [{ domain: "https://www.example.com" }, { zone: "example" }, { price_class: "PriceClass_50" }]) {
      expect(() => renderStack(s, { ...s.example, ...bad }), JSON.stringify(bad)).toThrow(TfInputValidationError);
    }
  });
});

// -- delivery ------------------------------------------------------------------

interface Step {
  run?: string;
  uses?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}
interface Job {
  name?: string;
  if?: string;
  needs?: string | string[];
  environment?: string;
  steps: Step[];
}
interface Workflow {
  on: { pull_request: { paths: string[] }; push: { branches: string[]; paths: string[] } };
  permissions: Record<string, string>;
  defaults: { run: { shell: string; "working-directory": string } };
  jobs: Record<string, Job>;
}

const workflowText = (slug: string) => render(slug).get(`.github/workflows/${slug}.yml`)!;
const workflow = (slug: string) => parse(workflowText(slug)) as Workflow;

describe("infrastructure stack workflows", () => {
  it("are one workflow: the copies differ only in the stack's directory and the drift minute", () => {
    // Three copies because a stack's files are its own (ADR 0009). This keeps
    // a fix to one from silently missing the others.
    const normal = (slug: string) =>
      workflowText(slug).replaceAll(slug, "STACK").replace(/cron: "\d+ 6 \* \* \*"/, "CRON").replace(/daily \(06:\d\d UTC\)/, "DAILY");
    expect(normal("postgres-with-backups")).toBe(normal("network-baseline"));
    expect(normal("static-site-cdn")).toBe(normal("network-baseline"));
  });

  it.each(INFRA)("%s: runs in the stack's directory, on changes to it, with a read-only token", (slug) => {
    const wf = workflow(slug);
    expect(wf.permissions).toEqual({ contents: "read" });
    expect(wf.defaults.run).toEqual({ shell: "bash", "working-directory": `infra/${slug}` });
    expect(wf.on.pull_request.paths).toContain(`infra/${slug}/**`);
    expect(wf.on.push.branches).toEqual(["main"]);
  });

  it.each(INFRA)("%s: applies only the saved plan, on a push to main, in production", (slug) => {
    const { jobs } = workflow(slug);
    expect(jobs.apply.if).toContain("github.event_name == 'push'");
    expect(jobs.apply.if).toContain("github.ref == 'refs/heads/main'");
    expect(jobs.apply.environment).toBe("production");
    const applies = jobs.apply.steps.map((s) => s.run ?? "").filter((r) => / apply /.test(r));
    expect(applies.length).toBe(2);
    for (const r of applies) expect(r).toMatch(/apply -input=false -no-color tfplan/);
    for (const name of ["plan", "drift", "validate"]) {
      expect(jobs[name].steps.map((s) => s.run ?? "").join("\n"), name).not.toMatch(/\b(tofu|terraform) apply\b/);
    }
    // A pull request's plan is never saved where it could be applied from.
    expect(jobs.plan.steps.find((s) => s.uses?.startsWith("actions/upload-artifact"))).toMatchObject({
      with: { name: "infra-plan" },
    });
    expect(workflowText(slug)).toContain("SAVE_PLAN: ${{ github.event_name == 'push' }}");
  });

  it.each(INFRA)("%s: the drift job is the one infralift reads, in its words", (slug) => {
    const { jobs } = workflow(slug);
    expect(jobs.drift.name).toBe(DRIFT_JOB_NAME);
    const result = jobs.drift.steps.map((s) => s.run ?? "").join("\n");
    expect(result).toContain(`title="${DRIFT.none}"`);
    expect(result).toContain(`title="${DRIFT.foundPrefix} `);
  });

  it.each(INFRA)("%s: reads only credentials its README tells the customer to set", (slug) => {
    const readme =
      render(slug, { backend: "r2" }).get(`infra/${slug}/README.md`)! +
      render(slug, { backend: "tfc", tfc_organization: "acme" }).get(`infra/${slug}/README.md`)!;
    const used = new Set([...workflowText(slug).matchAll(/\b(?:secrets|vars)\.([A-Z0-9_]+)/g)].map((m) => m[1]));
    expect(used.size).toBeGreaterThan(0);
    for (const name of used) expect(readme, name).toContain(`\`${name}\``);
  });
});

describe("costs", () => {
  it.each(INFRA)("%s: the description carries a dated estimate", (slug) => {
    const s: StackManifest = stack(slug);
    expect(s.description).toMatch(/\$\d+/);
    expect(s.description).toContain("2026-11-14");
    expect(s.description.toLowerCase()).toContain("estimated");
  });
});
