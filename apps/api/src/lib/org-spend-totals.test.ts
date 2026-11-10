import { describe, expect, it } from "vitest";
import { orgSpendTotals, type AssessmentSummary } from "@infralift/shared";

// The dashboard home headline. Shapes are AssessmentSummary as GET
// /assessments returns it (routes/assessments.ts summarize()).
function summary(over: Partial<AssessmentSummary>): AssessmentSummary {
  return {
    id: "a",
    provider: "heroku",
    status: "completed",
    startedAt: "2026-11-01T00:00:00.000Z",
    completedAt: "2026-11-01T00:00:10.000Z",
    resourceCount: 3,
    estimatedMonthlyCostCents: 10_000,
    currentSpend: { monthlyCents: 10_000, source: "inventory_list_price" },
    netMonthlySavingsCents: null,
    findingCounts: { info: 0, low: 0, medium: 0, high: 0 },
    connectionId: "conn_1",
    ...over,
  };
}

describe("orgSpendTotals", () => {
  it("counts an unknown bill as unknown, not $0", () => {
    // A Vercel-only org: the connector exposes no billing.
    const vercel = summary({
      id: "v",
      provider: "vercel",
      estimatedMonthlyCostCents: null,
      currentSpend: { monthlyCents: null, source: "unknown" },
    });
    expect(orgSpendTotals([vercel])).toEqual({
      counted: [vercel],
      knownMonthlyCents: 0,
      unknownCount: 1,
    });

    const heroku = summary({ id: "h", connectionId: "conn_2" });
    const out = orgSpendTotals([vercel, heroku]);
    expect(out.knownMonthlyCents).toBe(10_000);
    expect(out.unknownCount).toBe(1);
  });

  it("uses the reported bill where there is one, as the options page does", () => {
    const out = orgSpendTotals([
      summary({
        estimatedMonthlyCostCents: 10_000,
        currentSpend: { monthlyCents: 42_000, source: "customer_reported" },
      }),
    ]);
    expect(out.knownMonthlyCents).toBe(42_000);
  });

  it("counts only the latest completed rerun of each connection", () => {
    const first = summary({ id: "r1", completedAt: "2026-11-01T00:00:00.000Z" });
    const rerun = summary({
      id: "r2",
      completedAt: "2026-11-05T00:00:00.000Z",
      currentSpend: { monthlyCents: 12_000, source: "inventory_list_price" },
    });
    const failedRerun = summary({ id: "r3", status: "failed", completedAt: "2026-11-09T00:00:00.000Z" });
    const other = summary({ id: "o", connectionId: "conn_2" });

    const out = orgSpendTotals([failedRerun, rerun, first, other]);
    expect(out.counted.map((a) => a.id).sort()).toEqual(["o", "r2"]);
    expect(out.knownMonthlyCents).toBe(12_000 + 10_000);
  });

  it("keeps each uploaded snapshot, which has no connection to be a rerun of", () => {
    const out = orgSpendTotals([
      summary({ id: "b1", connectionId: null }),
      summary({ id: "b2", connectionId: null }),
    ]);
    expect(out.counted).toHaveLength(2);
    expect(orgSpendTotals([]).counted).toEqual([]);
  });
});
