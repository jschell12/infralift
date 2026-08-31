import { describe, expect, it } from "vitest";
import type { MigrationOptionsReport } from "@infralift/shared";
import { buildReportExtras } from "./report-extras.js";

function report(over: Partial<MigrationOptionsReport> = {}): MigrationOptionsReport {
  return {
    assessmentId: "a1",
    provider: "heroku",
    currentMonthlyCents: 322900,
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
      cents: 0,
      centsAfterWaiver: 0,
      totalGb: 64,
      components: [],
      waiverAvailable: false,
      waiverNote: null,
      confidence: "estimated",
      notes: [],
    },
    options: [
      {
        slug: "hetzner",
        name: "Hetzner",
        category: "vps",
        score: 0.8,
        pricing: {
          listMonthlyCents: 15000,
          year1MonthlyCents: 15000,
          steadyStateMonthlyCents: 15000,
          applied: [{ name: "auction", kind: "published", confidence: "advisor", detail: "" }],
        },
        sizing: {
          lineItems: [
            { label: "1x CCX43", monthlyCents: 10700 },
            { label: "Neon", monthlyCents: 18000 },
          ],
          monthlyCents: 42200,
          confidence: "corroborated",
        },
        monthlySavingsCents: 280700,
        benefits: "cheap",
        drawbacks: "you run it",
        managedLevel: 0,
        companions: [],
        gaps: [],
        codegenTarget: "hetzner",
      },
    ],
    ...over,
  } as MigrationOptionsReport;
}

describe("assessment report extras", () => {
  it("puts the current stack first and marks it as what is billed today", () => {
    const { costProjection } = buildReportExtras(report());

    expect(costProjection[0].isCurrent).toBe(true);
    expect(costProjection[0].confidence).toBe("invoiced");
    // A bill the customer already pays gets no discount modelling applied.
    expect(costProjection[0].listCents).toBe(322900);
    expect(costProjection[0].year1Cents).toBe(322900);
    expect(costProjection[0].steadyStateCents).toBe(322900);
  });

  it("quotes a sized target's own number across all three columns", () => {
    const { costProjection } = buildReportExtras(report());
    const hetzner = costProjection.find((r) => r.stack === "Hetzner")!;

    // The sized estimate is the defensible number; the catalog list price is a
    // price that never met this workload, so it must not appear here.
    expect(hetzner.listCents).toBe(42200);
    expect(hetzner.year1Cents).toBe(42200);
    expect(hetzner.steadyStateCents).toBe(42200);
    expect(hetzner.listCents).not.toBe(15000);
  });

  it("falls back to catalog pricing for an unsized target, and says so", () => {
    const r = report();
    r.options[0].sizing = null;
    r.options[0].monthlySavingsCents = null;

    const { costProjection } = buildReportExtras(r);
    const row = costProjection.find((x) => x.stack === "Hetzner")!;

    expect(row.listCents).toBe(15000);
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

  it("recommends the top option with the savings it was sized for", () => {
    const { recommendation } = buildReportExtras(report());

    expect(recommendation!.target).toBe("Hetzner");
    expect(recommendation!.summary).toContain("$2,807");
    const labels = recommendation!.rows.map((r) => r.label);
    expect(labels).toContain("Sized cost");
    expect(labels).toContain("Monthly change");
  });

  it("says stay put when the best option does not beat the current bill", () => {
    const r = report({ currentMonthlyCents: 3000 });
    r.options[0].monthlySavingsCents = -39200;

    const { recommendation } = buildReportExtras(r);

    // Telling someone not to migrate is the whole credibility of the report.
    expect(recommendation!.summary).toMatch(/staying put/i);
    expect(recommendation!.summary).not.toMatch(/less than the current stack/);
  });

  it("makes no savings claim for an unsized top option", () => {
    const r = report();
    r.options[0].sizing = null;
    r.options[0].monthlySavingsCents = null;

    const { recommendation } = buildReportExtras(r);

    expect(recommendation!.summary).toMatch(/not sized it/i);
    expect(recommendation!.rows.map((x) => x.label)).not.toContain("Monthly change");
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
      report({ options: [] })
    );

    expect(recommendation).toBeNull();
    // The current stack still gets a row; there is just nothing to compare to.
    expect(costProjection).toHaveLength(1);
  });
});
