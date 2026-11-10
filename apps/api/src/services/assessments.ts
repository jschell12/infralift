import type { CurrentSpend, Provider } from "@infralift/shared";
import { prisma } from "../lib/db.js";
import { NotFound } from "../lib/errors.js";
import { buildMigrationOptions, resolveCurrentSpend } from "../lib/options.js";
import { headlineNetSavings } from "../lib/report-extras.js";

/** Record the monthly bill the customer read off their invoice, or clear it
 *  with null. It overrides the inventory priced at list rates on the options
 *  page and the report. Another org's assessment is NotFound, not Forbidden,
 *  so the response does not confirm the id exists. */
export async function setReportedSpend(
  orgId: string,
  assessmentId: string,
  monthlyUsd: number | null
): Promise<{ id: string; reportedMonthlySpendCents: number | null }> {
  const owned = await prisma.assessment.findFirst({
    where: { id: assessmentId, orgId },
    select: { id: true },
  });
  if (!owned) throw new NotFound("Not found");

  return prisma.assessment.update({
    where: { id: owned.id },
    data: {
      reportedMonthlySpendCents:
        monthlyUsd === null ? null : Math.round(monthlyUsd * 100),
    },
    select: { id: true, reportedMonthlySpendCents: true },
  });
}

/** What an assessment summary says it would save, and the bill that saving is
 *  measured against.
 *
 *  Connectors used to store a flat "move it to a $20 VPS" figure at
 *  completion, which the dashboard home and the projects list showed while
 *  the options page showed a sized, net-of-ops number for the same account.
 *  This computes the summary figure on read from the same
 *  buildMigrationOptions() call the options page makes, rather than storing
 *  it: the figure depends on the reported bill, the price tables and the
 *  provider catalog, and a stored copy goes stale whenever any of them
 *  changes, including on a deploy that touches none of the assessment's
 *  rows.
 *
 *  An unknown bill skips the comparison: compareTarget returns null for every
 *  target when current spend is null, so there is nothing to rank. A
 *  comparison that throws is logged and summarized as no figure, so one bad
 *  assessment cannot take down the list. */
export async function assessmentSavings(a: {
  id: string;
  provider: string;
  status: string;
  estimatedMonthlyCostCents: number | null;
  reportedMonthlySpendCents: number | null;
}): Promise<{ currentSpend: CurrentSpend; netMonthlySavingsCents: number | null }> {
  const currentSpend = resolveCurrentSpend(
    a.reportedMonthlySpendCents,
    a.estimatedMonthlyCostCents
  );
  if (a.status !== "completed" || currentSpend.monthlyCents === null) {
    return { currentSpend, netMonthlySavingsCents: null };
  }

  try {
    const inventory = await prisma.inventoryItem.findMany({
      where: { assessmentId: a.id },
    });
    const report = await buildMigrationOptions({
      id: a.id,
      provider: a.provider,
      estimatedMonthlyCostCents: a.estimatedMonthlyCostCents,
      reportedMonthlySpendCents: a.reportedMonthlySpendCents,
      inventory: inventory.map((i) => ({
        provider: i.provider as Provider,
        type: i.type,
        externalId: i.externalId,
        name: i.name,
        region: i.region ?? undefined,
        monthlyCostCents: i.monthlyCostCents ?? undefined,
        metadata: (i.metadata as Record<string, unknown> | null) ?? undefined,
      })),
    });
    return { currentSpend, netMonthlySavingsCents: headlineNetSavings(report) };
  } catch (err) {
    console.error(`savings comparison failed for assessment ${a.id}:`, err);
    return { currentSpend, netMonthlySavingsCents: null };
  }
}
