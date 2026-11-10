// Cost projection and recommendation for the assessment report.
//
// Both of these were advertised on the pricing page and in
// docs/assessment-report.md, and neither reached the report: the dashboard
// carried a TODO saying the API did not return them, so the sections were
// skipped rather than filled with placeholder numbers. The logic existed the
// whole time on the migration options page, one route over.
//
// This is a projection of buildMigrationOptions() into the shapes the report
// page already renders. It deliberately adds no new modelling, so the number a
// customer reads on the report and the number on the options page are the same
// number.

import type {
  AssessmentCostProjectionRow,
  AssessmentRecommendation,
  CurrentSpend,
  MigrationOptionsReport,
  PriceConfidence,
} from "@infralift/shared";

// How many alternatives to show beside the current stack. The report is a
// summary; the options page is where the full ranking lives.
const TARGETS_SHOWN = 3;

const CONFIDENCE_RANK: Record<PriceConfidence, number> = {
  reported: 0,
  list_price: 1,
  corroborated: 2,
  advisor: 3,
  anecdote: 4,
  unverified: 5,
};

/** The current row says where its number came from. It used to say
 * "invoiced" whatever the source, and no connector reads an invoice: the ones
 * that price anything price the inventory at published list rates. */
function currentRow(
  provider: string,
  spend: CurrentSpend
): AssessmentCostProjectionRow {
  const cents = spend.monthlyCents;
  const base = {
    stack: `Current: ${provider}`,
    listCents: cents,
    year1Cents: cents,
    steadyStateCents: cents,
    isCurrent: true,
    source: spend.source,
  };
  switch (spend.source) {
    case "customer_reported":
      return {
        ...base,
        note: "The monthly bill you entered. No discount modelling applies to a bill you already pay.",
        confidence: "reported",
      };
    case "inventory_list_price":
      return {
        ...base,
        note: "The assessed resources at published list prices, not your invoice. Enter your actual bill for a closer comparison.",
        confidence: "list_price",
      };
    case "unknown":
      return {
        ...base,
        note: "This provider does not expose billing to us. Enter your monthly bill to compare.",
        confidence: "unverified",
      };
  }
}

function isConfidence(value: string): value is PriceConfidence {
  return value in CONFIDENCE_RANK;
}

/** A row is only as trustworthy as its weakest input, so take the worst
 * confidence across the discounts applied rather than the best. */
function weakestConfidence(
  applied: { confidence: string }[],
  fallback: PriceConfidence
): PriceConfidence {
  let worst: PriceConfidence = fallback;
  for (const a of applied) {
    if (isConfidence(a.confidence) && CONFIDENCE_RANK[a.confidence] > CONFIDENCE_RANK[worst]) {
      worst = a.confidence;
    }
  }
  return worst;
}

function dollars(cents: number): string {
  return "$" + Math.round(cents / 100).toLocaleString("en-US");
}

/** The one savings figure an assessment is summarized by: the top option's
 * net monthly saving after the ops line. Options arrive ranked with sized
 * targets first by net saving, so this is the best sized target, and it is
 * null when the bill is unknown or the top option is unsized. The dashboard
 * home, the projects list and the report's recommendation all read this, so
 * none of them can quote a different number from the options page. */
export function headlineNetSavings(
  report: MigrationOptionsReport
): number | null {
  return report.options[0]?.netMonthlySavingsCents ?? null;
}

export function buildReportExtras(report: MigrationOptionsReport): {
  costProjection: AssessmentCostProjectionRow[];
  recommendation: AssessmentRecommendation | null;
} {
  const rows: AssessmentCostProjectionRow[] = [
    currentRow(report.provider, report.currentSpend),
  ];

  // Sized targets lead, because their number is defensible line by line. This
  // is the same ordering buildMigrationOptions already applied.
  for (const option of report.options.slice(0, TARGETS_SHOWN)) {
    const sized = option.sizing;
    rows.push({
      stack: option.name,
      note: sized
        ? `Sized from your workload: ${sized.lineItems.length} line items, all-in.`
        : "Catalog pricing for a comparable tier. Ask for a sized estimate before comparing directly.",
      // A sized target owns its own number; the catalog price is a list price
      // that has not met this workload.
      listCents: sized ? sized.monthlyCents : option.pricing.listMonthlyCents,
      year1Cents: sized ? sized.monthlyCents : option.pricing.year1MonthlyCents,
      steadyStateCents: sized
        ? sized.monthlyCents
        : option.pricing.steadyStateMonthlyCents,
      confidence: weakestConfidence(
        option.pricing.applied,
        sized && isConfidence(sized.confidence) ? sized.confidence : "advisor"
      ),
    });
  }

  const best = report.options[0];
  if (!best) return { costProjection: rows, recommendation: null };

  // Net of the ops line, the same figure the options page and /estimate show.
  const savings = headlineNetSavings(report);
  const spendKnown = report.currentSpend.monthlyCents !== null;
  const opsNote = best.ops
    ? ` after ${dollars(best.ops.monthlyCents)}/mo of operations work`
    : "";
  // An unknown bill is not a zero bill. Comparing against zero made every
  // target look more expensive and told people to stay put on no evidence.
  const sizedAt = best.sizing
    ? `is sized at ${dollars(best.sizing.monthlyCents)}/mo for this workload${best.ops ? `, plus ${dollars(best.ops.monthlyCents)}/mo of operations work` : ""}`
    : "is the closest fit for this workload";
  const summary = !spendKnown
    ? `Enter your monthly bill to compare. ${best.name} ${sizedAt}, but without your current bill there is no savings figure worth quoting.`
    : savings === null
      ? `${best.name} is the closest fit for this workload. We have not sized it against your usage yet, so there is no savings figure here worth quoting.`
      : savings > 0
        ? `${best.name} fits the workload and costs ${dollars(savings)}/mo less than the current stack${opsNote}, sized from what the assessment actually found.`
        : `Staying put is the better call. ${best.name} is the closest alternative and, once its operations work is counted, it does not beat what you are paying now, so a migration would not pay for itself on cost.`;

  const recRows: { label: string; value: string }[] = [
    { label: "Runtime", value: report.profile.runtime.replace(/_/g, " ") },
    {
      label: "Requirements",
      value:
        report.needs.map((n) => n.label).join(", ") || "none inferred",
    },
  ];

  if (!spendKnown) {
    recRows.push({ label: "Current bill", value: "not known yet" });
  }
  if (best.sizing) {
    recRows.push({
      label: "Sized cost",
      value: `${dollars(best.sizing.monthlyCents)}/mo all-in`,
    });
  }
  if (best.ops) {
    recRows.push({
      label: "Operations work",
      value: `${dollars(best.ops.monthlyCents)}/mo (${best.ops.hoursPerMonth} hr at $${best.ops.hourlyRateUsd}/hr)`,
    });
  }
  if (savings !== null) {
    recRows.push({
      label: "Monthly change",
      value:
        savings > 0
          ? `${dollars(savings)} saved`
          : `${dollars(Math.abs(savings))} more`,
    });
  }
  if (best.breakEvenMonths !== null) {
    recRows.push({
      label: "Break-even",
      value:
        best.breakEvenMonths === 0
          ? "immediately, no exit toll"
          : `${best.breakEvenMonths} months`,
    });
  }
  if (report.exitToll.confidence !== "none") {
    recRows.push({
      label: "One-time exit toll",
      value: report.exitToll.waiverAvailable
        ? `${dollars(report.exitToll.cents)}, waived on request`
        : dollars(report.exitToll.cents),
    });
  }
  if (best.gaps.length > 0) {
    recRows.push({ label: "Gaps to cover", value: best.gaps.join(", ") });
  }

  return {
    costProjection: rows,
    recommendation: {
      target: best.name,
      summary,
      rows: recRows,
      netMonthlySavingsCents: savings,
    },
  };
}
