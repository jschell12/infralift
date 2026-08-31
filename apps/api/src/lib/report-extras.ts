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
  MigrationOptionsReport,
  PriceConfidence,
} from "@infralift/shared";

// How many alternatives to show beside the current stack. The report is a
// summary; the options page is where the full ranking lives.
const TARGETS_SHOWN = 3;

const CONFIDENCE_RANK: Record<PriceConfidence, number> = {
  invoiced: 0,
  corroborated: 1,
  advisor: 2,
  anecdote: 3,
  unverified: 4,
};

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

export function buildReportExtras(report: MigrationOptionsReport): {
  costProjection: AssessmentCostProjectionRow[];
  recommendation: AssessmentRecommendation | null;
} {
  const rows: AssessmentCostProjectionRow[] = [];

  // The current stack, from the assessment's own inventory pricing. There is
  // no discount modelling to apply to a bill the customer is already paying.
  rows.push({
    stack: `Current: ${report.provider}`,
    note: "What the assessed resources cost today at the rates on your account.",
    listCents: report.currentMonthlyCents,
    year1Cents: report.currentMonthlyCents,
    steadyStateCents: report.currentMonthlyCents,
    confidence: "invoiced",
    isCurrent: true,
  });

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

  const savings = best.monthlySavingsCents;
  const summary =
    savings === null
      ? `${best.name} is the closest fit for this workload. We have not sized it against your usage yet, so there is no savings figure here worth quoting.`
      : savings > 0
        ? `${best.name} fits the workload and costs ${dollars(savings)}/mo less than the current stack, sized from what the assessment actually found.`
        : `Staying put is the better call. ${best.name} is the closest alternative and it does not beat what you are paying now, so a migration would not pay for itself on cost.`;

  const recRows: { label: string; value: string }[] = [
    { label: "Runtime", value: report.profile.runtime.replace(/_/g, " ") },
    {
      label: "Requirements",
      value:
        report.needs.map((n) => n.label).join(", ") || "none inferred",
    },
  ];

  if (best.sizing) {
    recRows.push({
      label: "Sized cost",
      value: `${dollars(best.sizing.monthlyCents)}/mo all-in`,
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
    recommendation: { target: best.name, summary, rows: recRows },
  };
}
