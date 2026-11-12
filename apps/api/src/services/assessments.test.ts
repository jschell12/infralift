import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InventoryItem } from "@prisma/client";
import type { ResourceInventoryItem } from "@infralift/shared";
import {
  buildDemoHerokuAssessment,
  buildDemoVercelAssessment,
} from "../lib/demo-fixture.js";
import { computeEffectivePricing } from "../lib/pricing.js";
import type { Recommendation } from "../lib/recommend.js";

// The savings figure on the dashboard home and the projects list. What is
// asserted is that it is the options page's number, not a second calculation
// of it: each case builds the options report directly from the same inputs
// and compares. Postgres is stubbed the way options.test.ts stubs it, with
// the HostingProvider rows prisma/seed.ts writes for these targets, and the
// inventory rows are the demo accounts, which emit what the connectors emit.

const h = vi.hoisted(() => ({
  inventory: vi.fn(),
  recommend: vi.fn(),
  assessments: [] as { id: string; status: string; startedAt: Date | null; error: string | null; completedAt: Date | null }[],
}));

vi.mock("../lib/db.js", () => ({
  prisma: {
    inventoryItem: { findMany: h.inventory },
    // Honours the conditional update failStuckAssessments makes.
    assessment: {
      updateMany: async ({ where, data }: { where: { status: string; startedAt: { lt: Date } }; data: object }) => {
        const hit = h.assessments.filter(
          (a) => a.status === where.status && a.startedAt !== null && a.startedAt < where.startedAt.lt
        );
        hit.forEach((a) => Object.assign(a, data));
        return { count: hit.length };
      },
    },
    providerCapability: { findMany: async () => [] },
  },
}));
vi.mock("../lib/recommend.js", () => ({ recommend: h.recommend }));

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

const { assessmentSavings } = await import("./assessments.js");
const { buildMigrationOptions } = await import("../lib/options.js");

/** Inventory as Postgres hands it back: nulls, not undefineds. */
function rows(inventory: ResourceInventoryItem[], assessmentId = "a1"): InventoryItem[] {
  return inventory.map((i, n) => ({
    ...i,
    id: `${assessmentId}-item-${n}`,
    assessmentId,
    region: i.region ?? null,
    monthlyCostCents: i.monthlyCostCents ?? null,
    metadata: (i.metadata ?? null) as InventoryItem["metadata"],
  }));
}

const heroku = buildDemoHerokuAssessment();
const vercel = buildDemoVercelAssessment();

const herokuRows = rows(heroku.inventory);

const herokuRow = {
  id: "a1",
  provider: "heroku",
  status: "completed",
  estimatedMonthlyCostCents: heroku.estimatedMonthlyCostCents,
  reportedMonthlySpendCents: null as number | null,
};

/** The headline the options page leads with, for the same assessment. */
async function optionsPageNet(row: typeof herokuRow, inventory: ResourceInventoryItem[]) {
  const report = await buildMigrationOptions({ ...row, inventory });
  return report.options[0].netMonthlySavingsCents;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.recommend.mockResolvedValue([
    seeded("render", "Render", "paas", 3500, 3),
    seeded("cloudflare", "Cloudflare (Workers + Pages)", "edge", 1500, 3),
    seeded("hetzner", "Hetzner", "vps", 1200, 0),
  ]);
  h.inventory.mockResolvedValue(rows(heroku.inventory));
});

describe("assessmentSavings", () => {
  it("is the options page's net figure, not the bill minus a $20 VPS", async () => {
    const { currentSpend, netMonthlySavingsCents } = await assessmentSavings(herokuRow, herokuRows);

    expect(currentSpend).toEqual({ monthlyCents: 322900, source: "inventory_list_price" });
    expect(netMonthlySavingsCents).toBe(await optionsPageNet(herokuRow, heroku.inventory));
    // The flat figure the connector used to store for this account.
    expect(netMonthlySavingsCents).not.toBe(322900 - 2000);
    expect(netMonthlySavingsCents!).toBeLessThan(322900 - 2000);
  });

  it("follows a reported bill on the next read, with nothing to recompute", async () => {
    const listed = await assessmentSavings(herokuRow, herokuRows);
    const reported = await assessmentSavings({ ...herokuRow, reportedMonthlySpendCents: 250000 }, herokuRows);

    expect(reported.currentSpend).toEqual({ monthlyCents: 250000, source: "customer_reported" });
    expect(reported.netMonthlySavingsCents).toBe(
      await optionsPageNet({ ...herokuRow, reportedMonthlySpendCents: 250000 }, heroku.inventory)
    );
    expect(listed.netMonthlySavingsCents! - reported.netMonthlySavingsCents!).toBe(
      322900 - 250000
    );
  });

  it("is negative when staying put is cheaper, so the caller can say so", async () => {
    const small = { ...herokuRow, reportedMonthlySpendCents: 30000 };
    const { netMonthlySavingsCents } = await assessmentSavings(small, herokuRows);
    expect(netMonthlySavingsCents).toBe(await optionsPageNet(small, heroku.inventory));
    expect(netMonthlySavingsCents!).toBeLessThan(0);
  });

  it("is null, not zero, when the bill is unknown, and skips the comparison", async () => {
    // The Vercel connector prices nothing: there is no billing read API.
    const { currentSpend, netMonthlySavingsCents } = await assessmentSavings(
      { ...herokuRow, provider: "vercel", estimatedMonthlyCostCents: null },
      rows(vercel.inventory)
    );

    expect(currentSpend).toEqual({ monthlyCents: null, source: "unknown" });
    expect(netMonthlySavingsCents).toBeNull();
    expect(h.recommend).not.toHaveBeenCalled();
  });

  it("gives a figure for that same account once the customer enters the bill", async () => {
    const row = {
      ...herokuRow,
      provider: "vercel",
      estimatedMonthlyCostCents: null,
      reportedMonthlySpendCents: 75500,
    };
    const { netMonthlySavingsCents } = await assessmentSavings(row, rows(vercel.inventory));
    expect(netMonthlySavingsCents).not.toBeNull();
    expect(netMonthlySavingsCents).toBe(await optionsPageNet(row, vercel.inventory));
  });

  it("makes no claim for an assessment that has not completed", async () => {
    const { netMonthlySavingsCents } = await assessmentSavings({ ...herokuRow, status: "running" }, herokuRows);
    expect(netMonthlySavingsCents).toBeNull();
    expect(h.recommend).not.toHaveBeenCalled();
  });

  it("is null rather than throwing when the comparison fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    h.recommend.mockRejectedValueOnce(new Error("catalog unavailable"));

    const { currentSpend, netMonthlySavingsCents } = await assessmentSavings(herokuRow, herokuRows);

    expect(netMonthlySavingsCents).toBeNull();
    expect(currentSpend.monthlyCents).toBe(322900);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});

describe("failStuckAssessments", () => {
  it("fails an assessment running past the limit and leaves a fresh or finished one", async () => {
    const { failStuckAssessments, ASSESSMENT_TIME_LIMIT_MS, ASSESSMENT_TIMED_OUT } = await import("./assessments.js");
    const now = new Date("2026-11-11T12:00:00Z");
    const ago = (ms: number) => new Date(now.getTime() - ms);
    const base = { error: null, completedAt: null };
    h.assessments.push(
      { ...base, id: "stuck", status: "running", startedAt: ago(ASSESSMENT_TIME_LIMIT_MS + 1_000) },
      { ...base, id: "fresh", status: "running", startedAt: ago(ASSESSMENT_TIME_LIMIT_MS - 1_000) },
      { ...base, id: "done", status: "completed", startedAt: ago(ASSESSMENT_TIME_LIMIT_MS * 2) }
    );
    expect(await failStuckAssessments(now)).toBe(1);
    const by = Object.fromEntries(h.assessments.map((a) => [a.id, a]));
    expect(by.stuck).toMatchObject({ status: "failed", error: ASSESSMENT_TIMED_OUT, completedAt: now });
    expect(ASSESSMENT_TIMED_OUT).toMatch(/run it again$/);
    expect(by.fresh).toMatchObject({ status: "running", error: null });
    expect(by.done.status).toBe("completed");
  });
});
