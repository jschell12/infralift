import { prisma } from "../lib/db.js";
import { NotFound } from "../lib/errors.js";

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
