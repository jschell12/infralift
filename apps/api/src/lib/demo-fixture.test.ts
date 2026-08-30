import { describe, expect, it } from "vitest";
import {
  buildDemoHerokuAssessment,
  buildDemoVercelAssessment,
} from "./demo-fixture.js";
import { inferProfile } from "./options.js";
import { generateHcl } from "./tf/codegen.js";

describe("demo heroku fixture", () => {
  const fixture = buildDemoHerokuAssessment();

  it("totals $3,229/mo, matching the testenv large tier", () => {
    expect(fixture.estimatedMonthlyCostCents).toBe(322900);
    // The connector derives the total by summing items; the fixture must agree.
    const itemSum = fixture.inventory.reduce(
      (sum, i) => sum + (i.monthlyCostCents ?? 0),
      0
    );
    expect(itemSum).toBe(322900);
    expect(fixture.estimatedMonthlySavingsCents).toBe(320900);
  });

  it("emits dyno externalIds inferProfile can read the process type from", () => {
    const dynos = fixture.inventory.filter((i) => i.type === "heroku:dyno");
    expect(dynos).toHaveLength(3);
    for (const d of dynos) {
      expect(d.externalId).toMatch(/^[0-9a-f-]{36}:(web|worker)$/);
    }
  });

  it("carries appName on every addon (load-bearing for codegen)", () => {
    const addons = fixture.inventory.filter((i) => i.type === "heroku:addon");
    expect(addons).toHaveLength(5);
    for (const a of addons) {
      expect(a.metadata?.appName).toBeTruthy();
    }
  });

  it("infers the profile a real large Heroku account would produce", () => {
    const { runtime, needs } = inferProfile(fixture.inventory);
    expect(runtime).toBe("node_server");
    const keys = needs.map((n) => n.key);
    expect(keys).toEqual(
      expect.arrayContaining([
        "full_node_runtime",
        "managed_postgres",
        "managed_redis",
        "background_workers",
        "cron", // scheduler addon
      ])
    );
  });

  it("generates HCL with no unmapped resource types and valid references", () => {
    const files = generateHcl({
      provider: "heroku",
      inventory: fixture.inventory,
      backend: "local",
      migrationTarget: null,
    });
    const body = files.find((f) => f.fileName === "heroku.tf")?.content ?? "";
    expect(body).not.toContain("(no HCL mapping yet)");
    // Every addon references an app resource that is actually declared.
    for (const [, ref] of body.matchAll(/app_id\s*=\s*heroku_app\.(\w+)\.id/g)) {
      expect(body).toContain(`resource "heroku_app" "${ref}"`);
    }
  });
});

describe("demo vercel fixture", () => {
  const fixture = buildDemoVercelAssessment();

  it("carries the modeled run-rate and a finding explaining it", () => {
    expect(fixture.estimatedMonthlyCostCents).toBe(276000);
    const modeled = fixture.findings.find((f) =>
      f.title.startsWith("Modeled")
    );
    expect(modeled?.severity).toBe("high");
    expect(modeled?.detail).toContain("no billing read API");
  });

  it("emits 11 nextjs projects and 4 domains", () => {
    const projects = fixture.inventory.filter(
      (i) => i.type === "vercel:project"
    );
    const domains = fixture.inventory.filter((i) => i.type === "vercel:domain");
    expect(projects).toHaveLength(11);
    expect(domains).toHaveLength(4);
    for (const p of projects) {
      expect(p.metadata?.framework).toBe("nextjs");
    }
  });

  it("infers ssr + cron from the project shapes", () => {
    const { runtime, needs } = inferProfile(fixture.inventory);
    expect(runtime).toBe("ssr");
    expect(needs.map((n) => n.key)).toContain("cron");
  });
});
