import { describe, expect, it } from "vitest";
import {
  buildDemoHerokuAssessment,
  buildDemoVercelAssessment,
  buildDemoRenderAssessment,
  buildDemoRailwayAssessment,
  buildDemoDigitaloceanAssessment,
  buildDemoFirebaseAssessment,
} from "../demo-fixture.js";
import { computeFootprint, planTarget, sizeTarget } from "../sizing.js";
import { generateHcl } from "./codegen.js";
import type { Provider, ResourceInventoryItem } from "@infralift/shared";

const FIXTURES = [
  ["heroku", buildDemoHerokuAssessment],
  ["vercel", buildDemoVercelAssessment],
  ["render", buildDemoRenderAssessment],
  ["railway", buildDemoRailwayAssessment],
  ["digitalocean", buildDemoDigitaloceanAssessment],
  ["firebase", buildDemoFirebaseAssessment],
] as const;

const TARGETS = ["hetzner", "cloudflare"] as const;

function generate(
  provider: string,
  inventory: ResourceInventoryItem[],
  target: (typeof TARGETS)[number]
) {
  const files = generateHcl({
    provider: provider as Provider,
    inventory,
    backend: "local",
    migrationTarget: target,
    projectName: "demo",
  });
  const byName = new Map(files.map((f) => [f.fileName, f.content]));
  return { files, byName };
}

describe("migration target codegen", () => {
  it("emits an hcloud_server for every instance the estimate was priced against", () => {
    const { inventory } = buildDemoHerokuAssessment();
    const plan = planTarget("hetzner", computeFootprint(inventory))!;
    const target = generate("heroku", inventory, "hetzner").byName.get(
      "target-hetzner.tf"
    )!;

    // The demo workload is big enough to need more than one instance type;
    // if it ever stops being, this test would silently prove much less.
    expect(plan.hetzner!.instances.length).toBeGreaterThan(1);

    for (const group of plan.hetzner!.instances) {
      expect(target).toContain(`server_type  = "${group.serverType}"`);
      const block = target.slice(
        target.indexOf(`resource "hcloud_server" "app_${group.serverType}"`)
      );
      expect(block).toContain(`count        = ${group.count}`);
    }

    // ...and nothing it was not priced against.
    const emitted = [...target.matchAll(/server_type\s+=\s+"([a-z0-9]+)"/g)].map(
      (m) => m[1]
    );
    expect(emitted.sort()).toEqual(
      plan.hetzner!.instances.map((g) => g.serverType).sort()
    );
  });

  it("puts a load balancer in front only when there is more than one web process", () => {
    const many = buildDemoHerokuAssessment().inventory;
    expect(computeFootprint(many).webInstances).toBeGreaterThan(1);
    expect(generate("heroku", many, "hetzner").byName.get("target-hetzner.tf")).toContain(
      'resource "hcloud_load_balancer" "web"'
    );

    const single: ResourceInventoryItem[] = [
      {
        provider: "heroku",
        type: "heroku:dyno",
        externalId: "solo:web",
        name: "solo web",
        metadata: { size: "basic", quantity: 1 },
      } as ResourceInventoryItem,
    ];
    expect(computeFootprint(single).webInstances).toBe(1);
    expect(
      generate("heroku", single, "hetzner").byName.get("target-hetzner.tf")
    ).not.toContain('resource "hcloud_load_balancer"');
  });

  it("emits data services only when the plan prices them", () => {
    // Heroku demo has both a Postgres and a Redis add-on.
    const withData = buildDemoHerokuAssessment().inventory;
    const withDataPlan = planTarget("hetzner", computeFootprint(withData))!;
    expect(withDataPlan.postgres).not.toBeNull();
    expect(withDataPlan.redis).not.toBeNull();
    const hcl = generate("heroku", withData, "hetzner").byName.get(
      "target-hetzner.tf"
    )!;
    expect(hcl).toContain('resource "neon_project" "main"');
    expect(hcl).toContain('resource "upstash_redis_database" "cache"');
    expect(hcl).toContain(
      `autoscaling_limit_max_cu = ${withDataPlan.postgres!.maxComputeUnits}`
    );
    expect(hcl).toContain(`budget         = ${withDataPlan.redis!.budgetUsd}`);

    // Vercel demo is frontend-only: no managed database was found, so none
    // should be invented.
    const noData = buildDemoVercelAssessment().inventory;
    const noDataPlan = planTarget("cloudflare", computeFootprint(noData))!;
    expect(noDataPlan.postgres).toBeNull();
    const cf = generate("vercel", noData, "cloudflare").byName.get(
      "target-cloudflare.tf"
    )!;
    expect(cf).not.toContain("neon_project");
    expect(cf).not.toContain("upstash_redis_database");
  });

  it("gives scheduled and queue workloads the trigger their role needs", () => {
    const { inventory } = buildDemoVercelAssessment();
    const hcl = generate("vercel", inventory, "cloudflare").byName.get(
      "target-cloudflare.tf"
    )!;

    // The fixture carries a project named *-worker-cron and others named
    // *-worker-*; a cron job is not a fetch handler and should not be
    // generated as one.
    expect(hcl).toContain('resource "cloudflare_workers_cron_trigger"');
    expect(hcl).toContain('resource "cloudflare_queue" "jobs"');
    expect(hcl).toContain('resource "cloudflare_queue_consumer"');
  });

  it("never references a provider versions.tf did not declare", () => {
    // The generator used to emit neon_project into target-hetzner.tf while
    // only declaring the neon provider on the cloudflare path, so `init`
    // failed for every Hetzner migration with a database.
    for (const [provider, build] of FIXTURES) {
      for (const target of TARGETS) {
        const { files, byName } = generate(
          provider,
          build().inventory,
          target
        );
        const versions = byName.get("versions.tf")!;
        const declared = new Set(
          [...versions.matchAll(/^\s{4}(\w+)\s+=\s+\{$/gm)].map((m) => m[1])
        );

        const used = new Set<string>();
        for (const file of files) {
          if (!file.fileName.endsWith(".tf")) continue;
          for (const match of file.content.matchAll(
            /^resource\s+"([a-z0-9]+)_[a-z0-9_]*"/gm
          )) {
            used.add(match[1]);
          }
        }

        for (const prefix of used) {
          expect(
            declared,
            `${provider} -> ${target}: ${prefix}_* used but not in required_providers`
          ).toContain(prefix);
        }
      }
    }
  });

  it("declares no provider the generated files do not use", () => {
    // A stray required_providers entry costs a download and implies the
    // migration touches a service it does not.
    for (const [provider, build] of FIXTURES) {
      for (const target of TARGETS) {
        const { files, byName } = generate(provider, build().inventory, target);
        const versions = byName.get("versions.tf")!;
        const declared = [
          ...versions.matchAll(/^\s{4}(\w+)\s+=\s+\{$/gm),
        ].map((m) => m[1]);

        const body = files
          .filter((f) => f.fileName.endsWith(".tf"))
          .map((f) => f.content)
          .join("\n");

        for (const name of declared) {
          const used =
            new RegExp(`^resource\\s+"${name}_`, "m").test(body) ||
            new RegExp(`^provider\\s+"${name}"`, "m").test(body);
          expect(
            used,
            `${provider} -> ${target}: ${name} declared but never used`
          ).toBe(true);
        }
      }
    }
  });

  it("generates target HCL that needs no files present to evaluate", () => {
    // filesha256() on a build artifact that CI has not produced yet makes the
    // whole directory fail `validate`, which defeats the point of shipping
    // reviewable infrastructure ahead of the migration.
    for (const [provider, build] of FIXTURES) {
      for (const target of TARGETS) {
        const hcl = generate(provider, build().inventory, target).byName.get(
          `target-${target}.tf`
        )!;
        expect(hcl).not.toMatch(/filesha256\(/);
        expect(hcl).not.toMatch(/\bfile\(/);
      }
    }
  });

  it("agrees with the priced estimate on what the migration includes", () => {
    for (const [provider, build] of FIXTURES) {
      const { inventory } = build();
      for (const target of TARGETS) {
        const footprint = computeFootprint(inventory);
        const plan = planTarget(target, footprint)!;
        const sizing = sizeTarget(target, footprint)!;
        const hcl = generate(provider, inventory, target).byName.get(
          `target-${target}.tf`
        )!;

        const pricesPostgres = sizing.lineItems.some((i) =>
          i.label.includes("Neon Postgres")
        );
        expect(pricesPostgres).toBe(plan.postgres !== null);
        expect(hcl.includes("neon_project")).toBe(pricesPostgres);

        const pricesRedis = sizing.lineItems.some((i) =>
          i.label.includes("Upstash Redis")
        );
        expect(pricesRedis).toBe(plan.redis !== null);
        expect(hcl.includes("upstash_redis_database")).toBe(pricesRedis);
      }
    }
  });

  it("separates what the target replaces from what it does not", () => {
    const { inventory } = buildDemoHerokuAssessment();
    const hcl = generate("heroku", inventory, "hetzner").byName.get(
      "target-hetzner.tf"
    )!;

    // Postgres and Redis have replacements in the plan; a log drain and a
    // message broker do not, and saying otherwise turns into a surprise
    // during cutover.
    expect(hcl).toContain("# NOT replaced by this configuration");
    const notReplaced = hcl.slice(hcl.indexOf("# NOT replaced"));
    expect(notReplaced).toContain("papertrail");
    expect(notReplaced).toContain("cloudamqp");

    const replaced = hcl.slice(
      hcl.indexOf("# Replaced by this configuration"),
      hcl.indexOf("# NOT replaced")
    );
    expect(replaced).toContain("heroku-postgresql");
    expect(replaced).toContain("heroku-redis");
  });
});
