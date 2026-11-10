import { describe, expect, it } from "vitest";
import type {
  CurrentSpend,
  MigrationOption,
  MigrationOptionsReport,
} from "@infralift/shared";
import { compareTarget } from "./compare.js";
import { buildDemoHerokuAssessment } from "./demo-fixture.js";
import { DEFAULT_HOURLY_RATE_USD, opsBurden } from "./estimate.js";
import { PRICES_VERIFIED_AT } from "./pricing.js";
import { buildReportExtras, headlineNetSavings } from "./report-extras.js";
import { computeFootprint, sizeTarget } from "./sizing.js";

// The Hetzner option is built the way buildMigrationOptions builds it, from
// the demo Heroku account: sized at $422/mo, three hours of ops at $150, and
// compared through compareTarget. Only the current bill varies per test.
const heroku = buildDemoHerokuAssessment();
const footprint = computeFootprint(heroku.inventory);
const sizing = sizeTarget("hetzner", footprint)!;
const ops = opsBurden("hetzner", footprint, DEFAULT_HOURLY_RATE_USD);

function hetznerOption(spend: CurrentSpend, exitTollCents: number): MigrationOption {
  const c = compareTarget({
    currentMonthlyCents: spend.monthlyCents,
    targetMonthlyCents: sizing.monthlyCents,
    ops,
    exitTollCents,
  });
  return {
    slug: "hetzner",
    name: "Hetzner",
    category: "vps",
    score: 0.8,
    pricing: {
      listMonthlyCents: 1200,
      year1MonthlyCents: 720,
      steadyStateMonthlyCents: 720,
      applied: [
        { name: "Serverbörse (server auction)", kind: "auction", confidence: "corroborated", detail: "" },
      ],
    },
    sizing,
    monthlySavingsCents: c.grossMonthlySavingsCents,
    ops,
    netMonthlySavingsCents: c.netMonthlySavingsCents,
    breakEvenMonths: c.breakEvenMonths,
    firstYearNetCents: c.firstYearNetCents,
    benefits: "cheap",
    drawbacks: "you run it",
    managedLevel: 0,
    companions: [],
    gaps: [],
    codegenTarget: "hetzner",
  };
}

const LIST_PRICE: CurrentSpend = {
  monthlyCents: heroku.estimatedMonthlyCostCents,
  source: "inventory_list_price",
};
const UNKNOWN: CurrentSpend = { monthlyCents: null, source: "unknown" };

function report(
  spend: CurrentSpend = LIST_PRICE,
  over: Partial<MigrationOptionsReport> = {},
  exitTollCents = 0
): MigrationOptionsReport {
  return {
    assessmentId: "a1",
    provider: "heroku",
    currentSpend: spend,
    needs: [
      { key: "managed_postgres", label: "Managed Postgres", evidence: "pg" },
      { key: "background_workers", label: "Background workers", evidence: "w" },
    ],
    profile: {
      runtime: "node_server",
      requiredCapabilities: ["background_workers"],
      budgetMonthlyCents: 322900,
      trafficGbMonth: 50,
    },
    exitToll: {
      cents: exitTollCents,
      centsAfterWaiver: exitTollCents,
      totalGb: 64,
      components: [],
      waiverAvailable: false,
      waiverNote: null,
      confidence: "estimated",
      notes: [],
    },
    options: [hetznerOption(spend, exitTollCents)],
    pricesVerifiedAt: PRICES_VERIFIED_AT,
    ...over,
  };
}

describe("assessment report extras: the current row", () => {
  it("says list price, not invoiced, when the connector priced the inventory", () => {
    const { costProjection } = buildReportExtras(report());

    expect(costProjection[0].isCurrent).toBe(true);
    expect(costProjection[0].source).toBe("inventory_list_price");
    expect(costProjection[0].confidence).toBe("list_price");
    expect(costProjection[0].note).toMatch(/not your invoice/);
    // A bill the customer already pays gets no discount modelling applied.
    expect(costProjection[0].listCents).toBe(322900);
    expect(costProjection[0].year1Cents).toBe(322900);
    expect(costProjection[0].steadyStateCents).toBe(322900);
  });

  it("marks a bill the customer entered as reported", () => {
    const { costProjection } = buildReportExtras(
      report({ monthlyCents: 250000, source: "customer_reported" })
    );
    expect(costProjection[0].source).toBe("customer_reported");
    expect(costProjection[0].confidence).toBe("reported");
    expect(costProjection[0].listCents).toBe(250000);
  });

  it("leaves an unknown bill empty rather than writing $0", () => {
    const { costProjection } = buildReportExtras(report(UNKNOWN));
    expect(costProjection[0].source).toBe("unknown");
    expect(costProjection[0].listCents).toBeNull();
    expect(costProjection[0].steadyStateCents).toBeNull();
    expect(costProjection[0].note).toMatch(/enter your monthly bill/i);
  });
});

describe("assessment report extras: target rows", () => {
  it("quotes a sized target's own number across all three columns", () => {
    const { costProjection } = buildReportExtras(report());
    const hetzner = costProjection.find((r) => r.stack === "Hetzner")!;

    // The sized estimate is the defensible number; the catalog list price is a
    // price that never met this workload, so it must not appear here.
    expect(hetzner.listCents).toBe(sizing.monthlyCents);
    expect(hetzner.year1Cents).toBe(sizing.monthlyCents);
    expect(hetzner.steadyStateCents).toBe(sizing.monthlyCents);
    expect(hetzner.listCents).not.toBe(1200);
  });

  it("falls back to catalog pricing for an unsized target, and says so", () => {
    const r = report();
    r.options[0].sizing = null;
    r.options[0].monthlySavingsCents = null;

    const { costProjection } = buildReportExtras(r);
    const row = costProjection.find((x) => x.stack === "Hetzner")!;

    expect(row.listCents).toBe(1200);
    expect(row.note).toMatch(/sized estimate/i);
  });

  it("takes the weakest confidence, not the best", () => {
    const r = report();
    r.options[0].sizing = null;
    r.options[0].pricing.applied = [
      { name: "a", kind: "k", confidence: "corroborated", detail: "" },
      { name: "b", kind: "k", confidence: "anecdote", detail: "" },
    ];

    const { costProjection } = buildReportExtras(r);
    // A row is only as trustworthy as its shakiest input.
    expect(costProjection.find((x) => x.stack === "Hetzner")!.confidence).toBe(
      "anecdote"
    );
  });
});

describe("assessment report extras: the recommendation", () => {
  it("quotes the saving net of the ops line, the same figure /estimate shows", () => {
    const { recommendation } = buildReportExtras(report());
    const net = 322900 - sizing.monthlyCents - ops.monthlyCents;

    expect(recommendation!.target).toBe("Hetzner");
    expect(recommendation!.netMonthlySavingsCents).toBe(net);
    expect(recommendation!.summary).toContain("$2,207");
    // The gross figure the options page used to quote must not leak back in.
    expect(recommendation!.summary).not.toContain("$2,807");
    const labels = recommendation!.rows.map((r) => r.label);
    expect(labels).toContain("Sized cost");
    expect(labels).toContain("Operations work");
    expect(labels).toContain("Monthly change");
  });

  it("says stay put when the best option does not beat the current bill", () => {
    const { recommendation } = buildReportExtras(
      report({ monthlyCents: 30000, source: "customer_reported" })
    );

    // Telling someone not to migrate is the whole credibility of the report.
    expect(recommendation!.netMonthlySavingsCents).toBeLessThan(0);
    expect(recommendation!.summary).toMatch(/staying put/i);
    expect(recommendation!.summary).not.toMatch(/less than the current stack/);
    expect(recommendation!.rows.map((r) => r.label)).not.toContain("Break-even");
  });

  it("asks for the bill instead of saying stay put when spend is unknown", () => {
    const { recommendation } = buildReportExtras(report(UNKNOWN));

    expect(recommendation!.summary).toMatch(/enter your monthly bill/i);
    expect(recommendation!.summary).not.toMatch(/staying put/i);
    expect(recommendation!.netMonthlySavingsCents).toBeNull();
    const labels = recommendation!.rows.map((r) => r.label);
    expect(labels).toContain("Current bill");
    expect(labels).not.toContain("Monthly change");
    expect(labels).not.toContain("Break-even");
    // The target's own cost is still knowable and still worth stating.
    expect(recommendation!.summary).toContain("$422");
  });

  it("asks for the bill for an unsized top option too", () => {
    const r = report(UNKNOWN);
    r.options[0].sizing = null;
    r.options[0].ops = null;

    const { recommendation } = buildReportExtras(r);
    expect(recommendation!.summary).toMatch(/enter your monthly bill/i);
    expect(recommendation!.summary).not.toMatch(/staying put/i);
  });

  it("makes no savings claim for an unsized top option", () => {
    const r = report();
    r.options[0].sizing = null;
    r.options[0].ops = null;
    r.options[0].monthlySavingsCents = null;
    r.options[0].netMonthlySavingsCents = null;
    r.options[0].breakEvenMonths = null;

    const { recommendation } = buildReportExtras(r);

    expect(recommendation!.summary).toMatch(/not sized it/i);
    expect(recommendation!.rows.map((x) => x.label)).not.toContain("Monthly change");
  });

  it("states break-even against the exit toll", () => {
    const { recommendation } = buildReportExtras(report(LIST_PRICE, {}, 7500));
    const row = recommendation!.rows.find((r) => r.label === "Break-even");
    // 7500 / 220700 = 0.034 months, rounded up to a tenth.
    expect(row?.value).toBe("0.1 months");

    const free = buildReportExtras(report());
    expect(free.recommendation!.rows.find((r) => r.label === "Break-even")?.value).toMatch(
      /immediately/
    );
  });

  it("surfaces the exit toll only when there is one to report", () => {
    const withToll = report();
    withToll.exitToll = {
      ...withToll.exitToll,
      cents: 7500,
      centsAfterWaiver: 7500,
      confidence: "measured",
    };
    expect(
      buildReportExtras(withToll).recommendation!.rows.map((r) => r.label)
    ).toContain("One-time exit toll");

    const noToll = report();
    noToll.exitToll = { ...noToll.exitToll, confidence: "none" };
    expect(
      buildReportExtras(noToll).recommendation!.rows.map((r) => r.label)
    ).not.toContain("One-time exit toll");
  });

  it("returns no recommendation when nothing cleared the requirements", () => {
    const { costProjection, recommendation } = buildReportExtras(
      report(LIST_PRICE, { options: [] })
    );

    expect(recommendation).toBeNull();
    // The current stack still gets a row; there is just nothing to compare to.
    expect(costProjection).toHaveLength(1);
  });
});

describe("headlineNetSavings", () => {
  it("is the recommendation's figure, which is the top option's net", () => {
    const r = report();
    expect(headlineNetSavings(r)).toBe(r.options[0].netMonthlySavingsCents);
    expect(headlineNetSavings(r)).toBe(
      buildReportExtras(r).recommendation!.netMonthlySavingsCents
    );
  });

  it("is null for an unknown bill, an unsized top option, and no options", () => {
    expect(headlineNetSavings(report(UNKNOWN))).toBeNull();

    const unsized = report();
    unsized.options[0].sizing = null;
    unsized.options[0].netMonthlySavingsCents = null;
    expect(headlineNetSavings(unsized)).toBeNull();

    expect(headlineNetSavings(report(LIST_PRICE, { options: [] }))).toBeNull();
  });
});
