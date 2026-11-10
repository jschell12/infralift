import { describe, expect, it, vi } from "vitest";
import type { ResourceInventoryItem } from "@infralift/shared";
import { compareTarget } from "./compare.js";
import {
  buildDemoHerokuAssessment,
  buildDemoVercelAssessment,
} from "./demo-fixture.js";
import { DEFAULT_HOURLY_RATE_USD, opsBurden } from "./estimate.js";
import { computeExitToll } from "./exit-toll.js";
import { computeEffectivePricing } from "./pricing.js";
import type { Recommendation, RecommendInput } from "./recommend.js";
import { computeFootprint, sizeTarget } from "./sizing.js";

// buildMigrationOptions ranks in Postgres. The ranking is stubbed with the
// HostingProvider rows prisma/seed.ts writes for these three providers, so
// what is under test is everything after the ranking: current spend, sizing,
// ops, and the comparison.
const h = vi.hoisted(() => ({
  recommend: vi.fn(),
}));
vi.mock("./db.js", () => ({
  prisma: { providerCapability: { findMany: async () => [] } },
}));
vi.mock("./recommend.js", () => ({ recommend: h.recommend }));

function seeded(
  slug: string,
  name: string,
  category: string,
  typicalMonthlyCents: number,
  managedLevel: number
): Recommendation {
  return {
    slug,
    name,
    category,
    pricingModel: "fixed",
    minMonthlyCents: typicalMonthlyCents,
    typicalMonthlyCents,
    managedLevel,
    egressFreeGb: 0,
    benefits: "",
    drawbacks: "",
    score: 10,
    scoreBreakdown: { requiredFit: 0, preferredFit: 0, budgetFit: 0, opsFit: 0, egressFit: 0 },
    pricing: computeEffectivePricing(typicalMonthlyCents, []),
  };
}

h.recommend.mockImplementation(async (_input: RecommendInput) => [
  seeded("render", "Render", "paas", 3500, 3),
  seeded("cloudflare", "Cloudflare (Workers + Pages)", "edge", 1500, 3),
  seeded("hetzner", "Hetzner", "vps", 1200, 0),
]);

const { buildMigrationOptions, inferProfile, resolveCurrentSpend } = await import(
  "./options.js"
);

const item = (
  type: string,
  name: string,
  metadata: Record<string, unknown> = {},
  externalId = "x"
): ResourceInventoryItem => ({
  provider: type.split(":")[0] as ResourceInventoryItem["provider"],
  type,
  externalId,
  name,
  metadata,
});

describe("inferProfile", () => {
  it("reads a Heroku app as a long-running node workload", () => {
    const { runtime, needs } = inferProfile([
      item("heroku:app", "shop-web"),
      item("heroku:dyno", "shop-web web (Basic x1)", { processType: "web" }, "uuid:web"),
    ]);
    expect(runtime).toBe("node_server");
    expect(needs.map((n) => n.key)).toContain("full_node_runtime");
  });

  it("derives postgres, redis, and worker needs from Heroku add-ons and dynos", () => {
    const { needs } = inferProfile([
      item("heroku:addon", "shop-data: heroku-postgresql", {
        plan: "heroku-postgresql:essential-0",
        appName: "shop-data",
      }),
      item("heroku:addon", "shop-data: heroku-redis", {
        plan: "heroku-redis:mini",
        appName: "shop-data",
      }),
      item("heroku:dyno", "shop-worker worker (Basic x1)", { processType: "worker" }, "uuid:worker"),
    ]);
    const keys = needs.map((n) => n.key);
    expect(keys).toContain("managed_postgres");
    expect(keys).toContain("managed_redis");
    expect(keys).toContain("background_workers");
  });

  it("reads a Next.js Vercel project as SSR", () => {
    const { runtime, needs } = inferProfile([
      item("vercel:project", "acme-web", { framework: "nextjs" }),
    ]);
    expect(runtime).toBe("ssr");
    expect(needs.map((n) => n.key)).toContain("ssr");
  });

  it("spots cron workloads from project names", () => {
    const { needs } = inferProfile([
      item("vercel:project", "acme-worker-cron", { framework: "nextjs" }),
    ]);
    expect(needs.map((n) => n.key)).toContain("cron");
  });

  it("carries the inventory item name as evidence", () => {
    const { needs } = inferProfile([
      item("heroku:addon", "shop-data: heroku-postgresql", {
        plan: "heroku-postgresql:essential-0",
      }),
    ]);
    const pg = needs.find((n) => n.key === "managed_postgres");
    expect(pg?.evidence).toBe("shop-data: heroku-postgresql");
  });

  it("falls back to static for an inventory with no compute", () => {
    const { runtime } = inferProfile([]);
    expect(runtime).toBe("static");
  });
});

describe("resolveCurrentSpend", () => {
  it("prefers the bill the customer entered over the inventory list price", () => {
    expect(resolveCurrentSpend(250000, 322900)).toEqual({
      monthlyCents: 250000,
      source: "customer_reported",
    });
  });

  it("falls back to the inventory list price, labelled as such", () => {
    expect(resolveCurrentSpend(null, 322900)).toEqual({
      monthlyCents: 322900,
      source: "inventory_list_price",
    });
  });

  it("keeps a reported $0 as a claim rather than as unknown", () => {
    expect(resolveCurrentSpend(0, null)).toEqual({
      monthlyCents: 0,
      source: "customer_reported",
    });
  });

  it("says unknown, never zero, when neither is known", () => {
    expect(resolveCurrentSpend(null, null)).toEqual({
      monthlyCents: null,
      source: "unknown",
    });
  });
});

describe("buildMigrationOptions", () => {
  // The Vercel connector returns estimatedMonthlyCostCents: null (vercel.ts:
  // no billing read API on standard tokens), so that is what an assessment
  // of this inventory carries.
  const vercel = buildDemoVercelAssessment();
  const heroku = buildDemoHerokuAssessment();

  it("makes no savings claim when the bill is unknown, and still sizes", async () => {
    const report = await buildMigrationOptions({
      id: "a1",
      provider: "vercel",
      estimatedMonthlyCostCents: null,
      reportedMonthlySpendCents: null,
      inventory: vercel.inventory,
    });

    expect(report.currentSpend).toEqual({ monthlyCents: null, source: "unknown" });
    const sized = report.options.filter((o) => o.sizing);
    expect(sized.map((o) => o.slug).sort()).toEqual(["cloudflare", "hetzner"]);
    for (const o of report.options) {
      expect(o.monthlySavingsCents).toBeNull();
      expect(o.netMonthlySavingsCents).toBeNull();
      expect(o.breakEvenMonths).toBeNull();
      expect(o.firstYearNetCents).toBeNull();
    }
    // The ops line is known without a bill, so it is still shown.
    for (const o of sized) expect(o.ops!.monthlyCents).toBeGreaterThan(0);
    // With nothing to save against, the cheaper sized target leads, as on
    // /estimate.
    expect(sized[0].sizing!.monthlyCents).toBeLessThanOrEqual(
      sized[1].sizing!.monthlyCents
    );
    // Unsized targets stay visible but last, with no ops model.
    const render = report.options.find((o) => o.slug === "render")!;
    expect(render.sizing).toBeNull();
    expect(render.ops).toBeNull();
    expect(report.options.at(-1)!.slug).toBe("render");
  });

  it("compares against a reported bill, net of ops, through compareTarget", async () => {
    const report = await buildMigrationOptions({
      id: "a1",
      provider: "vercel",
      estimatedMonthlyCostCents: null,
      reportedMonthlySpendCents: 75500,
      inventory: vercel.inventory,
    });

    expect(report.currentSpend).toEqual({
      monthlyCents: 75500,
      source: "customer_reported",
    });
    const footprint = computeFootprint(vercel.inventory);
    const toll = computeExitToll("vercel", vercel.inventory);
    for (const o of report.options.filter((x) => x.sizing)) {
      const ops = opsBurden(o.slug, footprint, DEFAULT_HOURLY_RATE_USD);
      const expected = compareTarget({
        currentMonthlyCents: 75500,
        targetMonthlyCents: sizeTarget(o.slug, footprint)!.monthlyCents,
        ops,
        exitTollCents: toll.centsAfterWaiver,
      });
      expect(o.ops).toEqual(ops);
      expect(o.monthlySavingsCents).toBe(expected.grossMonthlySavingsCents);
      expect(o.netMonthlySavingsCents).toBe(expected.netMonthlySavingsCents);
      expect(o.breakEvenMonths).toBe(expected.breakEvenMonths);
      expect(o.firstYearNetCents).toBe(expected.firstYearNetCents);
    }
  });

  it("lets a reported bill override the inventory list price", async () => {
    const listed = await buildMigrationOptions({
      id: "a1",
      provider: "heroku",
      estimatedMonthlyCostCents: heroku.estimatedMonthlyCostCents,
      reportedMonthlySpendCents: null,
      inventory: heroku.inventory,
    });
    const reported = await buildMigrationOptions({
      id: "a1",
      provider: "heroku",
      estimatedMonthlyCostCents: heroku.estimatedMonthlyCostCents,
      reportedMonthlySpendCents: 250000,
      inventory: heroku.inventory,
    });

    expect(listed.currentSpend).toEqual({
      monthlyCents: 322900,
      source: "inventory_list_price",
    });
    expect(reported.currentSpend.source).toBe("customer_reported");
    const net = (r: typeof listed) =>
      r.options.find((o) => o.slug === "hetzner")!.netMonthlySavingsCents!;
    expect(net(listed) - net(reported)).toBe(322900 - 250000);
  });

  it("ranks sized targets by net saving once the bill is known", async () => {
    const report = await buildMigrationOptions({
      id: "a1",
      provider: "heroku",
      estimatedMonthlyCostCents: heroku.estimatedMonthlyCostCents,
      reportedMonthlySpendCents: null,
      inventory: heroku.inventory,
    });
    const sized = report.options.filter((o) => o.sizing);
    expect(sized[0].netMonthlySavingsCents!).toBeGreaterThanOrEqual(
      sized[1].netMonthlySavingsCents!
    );
  });

  it("qualifies discount tiers on target spend, not on today's bill", async () => {
    h.recommend.mockClear();
    await buildMigrationOptions({
      id: "a1",
      provider: "heroku",
      estimatedMonthlyCostCents: heroku.estimatedMonthlyCostCents,
      reportedMonthlySpendCents: null,
      inventory: heroku.inventory,
    });
    // Omitted, computeEffectivePricing sizes each target's tier off that
    // target's own price. Passing 12x a $3,229/mo Heroku bill qualified it
    // for Cloudflare's $36k/yr enterprise tier.
    const input = h.recommend.mock.calls[0][0] as RecommendInput;
    expect(input.annualSpendCents).toBeUndefined();
  });
});
