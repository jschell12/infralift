// Effective-price math: what a workload actually costs on a provider once
// startup credits and committed-spend discounts are applied, vs list price.
//
// Model (mirrors how these programs really combine):
//   - year 1: if startup-credit eligible, credits burn against LIST price
//     (credited usage does not count toward a spend commitment, so credits
//     and enterprise discounts effectively don't stack).
//   - steady state: best committed-spend tier the workload's annual spend
//     qualifies for, or a published mechanism (auction) — applied to list.

/** The day the hardcoded price tables were last checked against published
 * pricing: the target models in sizing.ts (Hetzner, Cloudflare, Neon,
 * Upstash) and the egress rates in exit-toll.ts. Both were recorded only as
 * "August 2026"; the commits that wrote them are dated 2026-08-30 and
 * 2026-08-31, so the first of the month is the date nobody can say is too
 * fresh. Every savings figure is computed from these tables, so the options
 * page and /estimate show this date, and pricing.test.ts fails once it is
 * more than 120 days old. Re-verify the tables, then move it. */
export const PRICES_VERIFIED_AT = "2026-08-01";

export interface DiscountTierData {
  minAnnualCommitUsd: number;
  discountBps: number;
}

export interface DiscountProgramData {
  kind: string; // startup_credit | committed_spend | auction
  name: string;
  creditMaxCents: number | null;
  creditDurationMonths: number | null;
  creditMonthlyCapCents: number | null;
  confidence: string; // corroborated | advisor | anecdote | unverified
  tiers: DiscountTierData[];
}

export interface PricingOptions {
  // Projected all-in annual spend on the target provider, in cents.
  // Defaults to 12x list monthly.
  annualSpendCents?: number;
  startupCreditsEligible?: boolean;
}

export interface AppliedProgram {
  name: string;
  kind: string;
  confidence: string;
  detail: string;
}

export interface EffectivePricing {
  listMonthlyCents: number;
  // Average monthly cost in year 1 (credits applied when eligible)
  year1MonthlyCents: number;
  // Ongoing monthly cost with the best qualifying discount applied
  steadyStateMonthlyCents: number;
  applied: AppliedProgram[];
}

export function computeEffectivePricing(
  listMonthlyCents: number,
  programs: DiscountProgramData[],
  opts: PricingOptions = {}
): EffectivePricing {
  const applied: AppliedProgram[] = [];
  const annualSpendUsd =
    (opts.annualSpendCents ?? listMonthlyCents * 12) / 100;

  // Best ongoing discount: committed-spend tiers the spend qualifies for,
  // plus auction-style published discounts (no commitment required).
  let bestBps = 0;
  let bestProgram: DiscountProgramData | null = null;
  for (const p of programs) {
    if (p.kind !== "committed_spend" && p.kind !== "auction") continue;
    for (const t of p.tiers) {
      const qualifies =
        p.kind === "auction" || annualSpendUsd >= t.minAnnualCommitUsd;
      if (qualifies && t.discountBps > bestBps) {
        bestBps = t.discountBps;
        bestProgram = p;
      }
    }
  }

  const steadyStateMonthlyCents = Math.round(
    listMonthlyCents * (1 - bestBps / 10000)
  );
  if (bestProgram && bestBps > 0) {
    applied.push({
      name: bestProgram.name,
      kind: bestProgram.kind,
      confidence: bestProgram.confidence,
      detail: `${(bestBps / 100).toFixed(1)}% off list at ~$${Math.round(annualSpendUsd).toLocaleString("en-US")}/yr spend`,
    });
  }

  // Year 1: credits offset list price when eligible.
  let year1MonthlyCents = steadyStateMonthlyCents;
  if (opts.startupCreditsEligible) {
    const credit = programs
      .filter((p) => p.kind === "startup_credit" && (p.creditMaxCents ?? 0) > 0)
      .sort((a, b) => (b.creditMaxCents ?? 0) - (a.creditMaxCents ?? 0))[0];
    if (credit) {
      const monthlyBurn = Math.min(
        listMonthlyCents,
        credit.creditMonthlyCapCents ?? Infinity
      );
      const months = Math.min(12, credit.creditDurationMonths ?? 12);
      const covered = Math.min(credit.creditMaxCents ?? 0, monthlyBurn * months);
      const creditYear1 = Math.round(
        Math.max(0, listMonthlyCents * 12 - covered) / 12
      );
      // If credits beat the committed price for year 1, take them (they
      // don't stack with a commitment, so it's one or the other).
      if (creditYear1 < year1MonthlyCents) {
        year1MonthlyCents = creditYear1;
        applied.push({
          name: credit.name,
          kind: credit.kind,
          confidence: credit.confidence,
          detail: `$${Math.round(covered / 100).toLocaleString("en-US")} in credits applied over year 1${credit.creditMonthlyCapCents ? " (monthly use-it-or-lose-it cap)" : ""}`,
        });
      }
    }
  }

  return {
    listMonthlyCents,
    year1MonthlyCents,
    steadyStateMonthlyCents,
    applied,
  };
}
