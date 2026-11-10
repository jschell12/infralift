// One target against what the customer pays today: the arithmetic every
// savings number in the product goes through.
//
// The options page, the assessment report and the public estimator each used
// to do this subtraction themselves, and they disagreed. The estimator netted
// out the operations work a target adds; the options page did not, so the same
// workload saved $600/mo more on the dashboard than on /estimate. Both now
// call compareTarget(), so a change to how savings are counted lands in every
// place at once.
//
// The rule that shapes it: an unknown bill is not a zero bill. When current
// spend is null nothing here is computed against it, and every savings field
// comes back null rather than a large negative number that reads as "stay
// where you are".

import type { OpsBurden } from "@infralift/shared";

export interface CompareInput {
  /** What the customer pays today, or null when nobody knows. */
  currentMonthlyCents: number | null;
  /** The target's sized infrastructure cost, before the ops line. */
  targetMonthlyCents: number;
  ops: OpsBurden;
  /** One-off cost to get stored data out, after any waiver. The estimator has
   * no inventory to measure it from and passes 0. */
  exitTollCents: number;
}

export interface Comparison {
  /** Bill today minus infrastructure. */
  grossMonthlySavingsCents: number | null;
  /** Gross minus the ops line. */
  netMonthlySavingsCents: number | null;
  netAnnualSavingsCents: number | null;
  /** Months of net savings it takes to repay the exit toll. */
  breakEvenMonths: number | null;
  /** Twelve months of net savings minus the exit toll. */
  firstYearNetCents: number | null;
}

/** Break-even is rounded up to a tenth of a month, so it never claims the toll
 * is repaid sooner than the arithmetic supports. A move that saves nothing
 * never breaks even, and that is null rather than Infinity so it serializes. */
export function breakEvenMonths(
  exitTollCents: number,
  netMonthlySavingsCents: number | null
): number | null {
  if (netMonthlySavingsCents === null || netMonthlySavingsCents <= 0) {
    return null;
  }
  if (exitTollCents <= 0) return 0;
  return Math.ceil((exitTollCents / netMonthlySavingsCents) * 10) / 10;
}

export function compareTarget(input: CompareInput): Comparison {
  const { currentMonthlyCents, targetMonthlyCents, ops, exitTollCents } = input;

  if (currentMonthlyCents === null) {
    return {
      grossMonthlySavingsCents: null,
      netMonthlySavingsCents: null,
      netAnnualSavingsCents: null,
      breakEvenMonths: null,
      firstYearNetCents: null,
    };
  }

  const gross = currentMonthlyCents - targetMonthlyCents;
  const net = gross - ops.monthlyCents;

  return {
    grossMonthlySavingsCents: gross,
    netMonthlySavingsCents: net,
    netAnnualSavingsCents: net * 12,
    breakEvenMonths: breakEvenMonths(exitTollCents, net),
    firstYearNetCents: net * 12 - exitTollCents,
  };
}
