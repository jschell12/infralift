import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InventoryItem } from "@prisma/client";
import { buildDemoHerokuAssessment } from "../lib/demo-fixture.js";
import { computeEffectivePricing } from "../lib/pricing.js";

// GET /assessments summaries. What is asserted is the database work: the same
// number of queries against the assessment, finding and inventory tables for
// one assessment or forty, where it used to be three or four per assessment.
// The inventory is the demo Heroku account, which emits what the connector
// emits; the catalog ranking is stubbed as in assessments.test.ts.

const h = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  assessmentFindMany: vi.fn(),
  findingGroupBy: vi.fn(),
  inventoryFindMany: vi.fn(),
  recommend: vi.fn(),
}));

vi.mock("../lib/db.js", () => ({
  prisma: {
    assessment: { findMany: h.assessmentFindMany },
    finding: { groupBy: h.findingGroupBy },
    inventoryItem: { findMany: h.inventoryFindMany },
    providerCapability: { findMany: async () => [] },
  },
}));
vi.mock("../lib/recommend.js", () => ({ recommend: h.recommend }));

const { listAssessmentSummaries, ASSESSMENT_PAGE_SIZE } = await import("./assessments.js");

const heroku = buildDemoHerokuAssessment();

function assessmentRows(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `a${i}`,
    provider: "heroku",
    status: "completed",
    startedAt: new Date("2026-11-01T00:00:00Z"),
    completedAt: new Date("2026-11-01T00:01:00Z"),
    resourceCount: heroku.inventory.length,
    estimatedMonthlyCostCents: heroku.estimatedMonthlyCostCents,
    reportedMonthlySpendCents: null,
    connectionId: "conn_1",
  }));
}

function inventoryFor(ids: string[]): InventoryItem[] {
  return ids.flatMap((assessmentId) =>
    heroku.inventory.map((i, n) => ({
      ...i,
      id: `${assessmentId}-${n}`,
      assessmentId,
      region: i.region ?? null,
      monthlyCostCents: i.monthlyCostCents ?? null,
      metadata: (i.metadata ?? null) as InventoryItem["metadata"],
    }))
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  h.assessmentFindMany.mockImplementation(async ({ take }: { take: number }) => h.rows.slice(0, take));
  h.findingGroupBy.mockImplementation(async ({ where }: { where: { assessmentId: { in: string[] } } }) =>
    where.assessmentId.in.map((assessmentId) => ({ assessmentId, severity: "high", _count: { _all: 2 } }))
  );
  h.inventoryFindMany.mockImplementation(async ({ where }: { where: { assessmentId: { in: string[] } } }) =>
    inventoryFor(where.assessmentId.in)
  );
  const seeded = (slug: string, name: string, category: string, typicalMonthlyCents: number, managedLevel: number) => ({
    slug, name, category, pricingModel: "fixed", minMonthlyCents: typicalMonthlyCents, typicalMonthlyCents,
    managedLevel, egressFreeGb: 0, benefits: "", drawbacks: "", score: 10,
    scoreBreakdown: { requiredFit: 0, preferredFit: 0, budgetFit: 0, opsFit: 0, egressFit: 0 },
    pricing: computeEffectivePricing(typicalMonthlyCents, []),
  });
  // The HostingProvider rows prisma/seed.ts writes for these targets.
  h.recommend.mockResolvedValue([
    seeded("render", "Render", "paas", 3500, 3),
    seeded("cloudflare", "Cloudflare (Workers + Pages)", "edge", 1500, 3),
    seeded("hetzner", "Hetzner", "vps", 1200, 0),
  ]);
});

describe("listAssessmentSummaries", () => {
  it.each([1, 40])("reads the row tables in three queries for %i assessment(s)", async (n) => {
    h.rows = assessmentRows(n);
    const { summaries } = await listAssessmentSummaries("org_1", { limit: ASSESSMENT_PAGE_SIZE });
    expect(summaries).toHaveLength(n);
    expect(h.assessmentFindMany).toHaveBeenCalledTimes(1);
    expect(h.findingGroupBy).toHaveBeenCalledTimes(1);
    expect(h.inventoryFindMany).toHaveBeenCalledTimes(1);
    // Each summary still gets its own savings figure and finding counts.
    expect(summaries.every((s) => s.netMonthlySavingsCents !== null)).toBe(true);
    expect(summaries[0]!.findingCounts).toEqual({ info: 0, low: 0, medium: 0, high: 2 });
  });

  it("skips the inventory query when no assessment has a bill to compare", async () => {
    h.rows = assessmentRows(3).map((r) => ({ ...r, status: "running" }));
    await listAssessmentSummaries("org_1", { limit: 10 });
    expect(h.inventoryFindMany).not.toHaveBeenCalled();
    expect(h.recommend).not.toHaveBeenCalled();
  });

  it("asks for one row past the page, and hands back a cursor only when it came back", async () => {
    h.rows = assessmentRows(3);
    const first = await listAssessmentSummaries("org_1", { limit: 2 });
    expect(h.assessmentFindMany.mock.calls[0][0]).toMatchObject({ where: { orgId: "org_1" }, take: 3 });
    expect(first.summaries.map((s) => s.id)).toEqual(["a0", "a1"]);
    expect(first.nextCursor).toBe("a1");

    const last = await listAssessmentSummaries("org_1", { limit: 5, cursor: "a1" });
    expect(h.assessmentFindMany.mock.calls[1][0]).toMatchObject({ cursor: { id: "a1" }, skip: 1, take: 6 });
    expect(last.nextCursor).toBeNull();
  });

  it("returns an empty page without querying findings or inventory", async () => {
    h.rows = [];
    expect(await listAssessmentSummaries("org_1", { limit: 50 })).toEqual({ summaries: [], nextCursor: null });
    expect(h.findingGroupBy).not.toHaveBeenCalled();
  });
});
