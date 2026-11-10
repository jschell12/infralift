import { describe, expect, it } from "vitest";
import {
  buildDemoDigitaloceanAssessment,
  buildDemoFirebaseAssessment,
  buildDemoHerokuAssessment,
  buildDemoRailwayAssessment,
  buildDemoRenderAssessment,
  buildDemoVercelAssessment,
} from "./demo-fixture.js";
import { inferProfile } from "./options.js";
import { computeFootprint, sizeTarget } from "./sizing.js";
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
    // Like the connector, the fixture prices the bill and claims no saving:
    // 320900 here was $3,229 minus a flat $20 VPS.
    expect(fixture).not.toHaveProperty("estimatedMonthlySavingsCents");
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

  it("itemizes the bill as usage line items that sum to the run-rate", () => {
    const usage = fixture.inventory.filter((i) => i.type === "vercel:usage");
    expect(usage.length).toBeGreaterThanOrEqual(5);
    const sum = usage.reduce((s, u) => s + (u.monthlyCostCents ?? 0), 0);
    expect(sum).toBe(276000);
    // Bandwidth is the dominant line — the reason to leave.
    const bandwidth = usage.find(
      (u) => (u.metadata as Record<string, unknown>)?.kind === "bandwidth"
    );
    expect(bandwidth?.monthlyCostCents).toBe(135000);
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

  it("keeps usage items out of generated HCL", () => {
    const files = generateHcl({
      provider: "vercel",
      inventory: fixture.inventory,
      backend: "local",
      migrationTarget: null,
    });
    const body = files.find((f) => f.fileName === "vercel.tf")?.content ?? "";
    expect(body).not.toContain("usage");
    expect(body).not.toContain("(no HCL mapping yet)");
  });

  it("infers ssr + cron from the project shapes", () => {
    const { runtime, needs } = inferProfile(fixture.inventory);
    expect(runtime).toBe("ssr");
    expect(needs.map((n) => n.key)).toContain("cron");
  });
});

describe("provider demo fixtures (render, railway, digitalocean, firebase)", () => {
  const cases = [
    {
      name: "render",
      build: buildDemoRenderAssessment,
      totalCents: 118900,
      runtime: "node_server",
      needs: ["full_node_runtime", "background_workers", "managed_postgres", "managed_redis"],
      sizedTarget: "hetzner",
      sizedBand: [30000, 45000],
    },
    {
      name: "railway",
      build: buildDemoRailwayAssessment,
      totalCents: 98000,
      runtime: "node_server",
      needs: ["full_node_runtime", "managed_postgres", "managed_redis"],
      sizedTarget: "hetzner",
      sizedBand: [8000, 16000],
    },
    {
      name: "digitalocean",
      build: buildDemoDigitaloceanAssessment,
      totalCents: 106600,
      runtime: "node_server",
      needs: ["full_node_runtime", "managed_postgres", "managed_redis"],
      sizedTarget: "hetzner",
      sizedBand: [35000, 50000],
    },
    {
      name: "firebase",
      build: buildDemoFirebaseAssessment,
      totalCents: 257000,
      runtime: "serverless_fn",
      needs: ["cron"],
      sizedTarget: "cloudflare",
      sizedBand: [4000, 9000],
    },
  ] as const;

  for (const c of cases) {
    it(`${c.name}: items sum to the bill and the sized exit is credible`, () => {
      const fixture = c.build();
      const itemSum = fixture.inventory.reduce(
        (s, i) => s + (i.monthlyCostCents ?? 0),
        0
      );
      expect(itemSum).toBe(c.totalCents);
      expect(fixture.estimatedMonthlyCostCents).toBe(c.totalCents);

      const { runtime, needs } = inferProfile(fixture.inventory);
      expect(runtime).toBe(c.runtime);
      expect(needs.map((n) => n.key)).toEqual(expect.arrayContaining([...c.needs]));

      const sized = sizeTarget(
        c.sizedTarget,
        computeFootprint(fixture.inventory)
      );
      expect(sized).not.toBeNull();
      expect(sized!.monthlyCents).toBeGreaterThanOrEqual(c.sizedBand[0]);
      expect(sized!.monthlyCents).toBeLessThanOrEqual(c.sizedBand[1]);
    });

    it(`${c.name}: usage items stay out of generated HCL`, () => {
      const fixture = c.build();
      const files = generateHcl({
        provider: c.name,
        inventory: fixture.inventory,
        backend: "local",
        migrationTarget: null,
      });
      const body =
        files.find((f) => f.fileName === `${c.name}.tf`)?.content ?? "";
      expect(body).not.toContain(":usage");
    });
  }
});
