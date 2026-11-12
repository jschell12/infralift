import type { InventoryItem } from "@prisma/client";
import type { AssessmentStatus, AssessmentSummary, CurrentSpend, FindingSeverity, Provider } from "@infralift/shared";
import { prisma } from "../lib/db.js";
import { toInventoryItem } from "../lib/inventory.js";
import { Conflict, NotFound } from "../lib/errors.js";
import { buildMigrationOptions, resolveCurrentSpend } from "../lib/options.js";
import { headlineNetSavings } from "../lib/report-extras.js";

/** How long an assessment may sit at "running". A token assessment runs
 *  inside its HTTP request, so one still running after this belonged to a
 *  request that died with its process, or to a provider that stalled past
 *  every per-request deadline (lib/http.ts). */
export const ASSESSMENT_TIME_LIMIT_MS = 30 * 60 * 1000;

export const ASSESSMENT_TIMED_OUT =
  "timed out: this assessment did not finish within 30 minutes, possibly because infralift restarted while it ran; run it again";

/** Marks assessments stuck at "running" past the limit as failed, so the
 *  dashboard stops showing a spinner for them. Conditional on the status
 *  (compare-and-set), so one that completes meanwhile is left alone. Called
 *  by the job worker's sweep (lib/jobs/queue.ts). Returns how many. */
export async function failStuckAssessments(now = new Date(), limitMs = ASSESSMENT_TIME_LIMIT_MS): Promise<number> {
  const { count } = await prisma.assessment.updateMany({
    where: { status: "running", startedAt: { lt: new Date(now.getTime() - limitMs) } },
    data: { status: "failed", completedAt: now, error: ASSESSMENT_TIMED_OUT },
  });
  return count;
}

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

/** How long a run may sit in "running" or "pending" before a new run of the
 *  same connection is allowed anyway. Runs are synchronous and finish in
 *  seconds; one older than this was left behind by a process that died
 *  mid-run. failStuckAssessments marks such a run failed, but only after
 *  ASSESSMENT_TIME_LIMIT_MS (30 minutes); this shorter window lets the
 *  customer run it again sooner than that. */
export const RUN_IN_FLIGHT_WINDOW_MS = 15 * 60 * 1000;

/** Refuses a second run of a connection while one is still going: a double
 *  tap, a second tab, or a retry while the first request is still waiting on
 *  the provider. 409 with the running assessment's id.
 *
 *  This is a read before the insert, so two requests arriving within the same
 *  few milliseconds can both pass it. The dashboard disables the button on
 *  the first tap for that case; closing it on the server would need a lock or
 *  a partial unique index, which a stuck run would then hold until
 *  failStuckAssessments fails it 30 minutes later, twice this window. */
export async function refuseConcurrentRun(
  orgId: string,
  connectionId: string,
  now: Date = new Date()
): Promise<void> {
  const running = await prisma.assessment.findFirst({
    where: {
      orgId,
      connectionId,
      status: { in: ["pending", "running"] },
      createdAt: { gte: new Date(now.getTime() - RUN_IN_FLIGHT_WINDOW_MS) },
    },
    select: { id: true },
  });
  if (running) {
    throw new Conflict(
      "An assessment of this account is already running. Wait for it to finish, then try again.",
      { assessmentId: running.id }
    );
  }
}

interface SavingsInput {
  id: string;
  provider: string;
  status: string;
  estimatedMonthlyCostCents: number | null;
  reportedMonthlySpendCents: number | null;
}

/** Whether a savings figure can be computed: a completed assessment with a
 *  known bill. Only these need their inventory loaded. */
function hasSavingsComparison(a: SavingsInput): boolean {
  const spend = resolveCurrentSpend(a.reportedMonthlySpendCents, a.estimatedMonthlyCostCents);
  return a.status === "completed" && spend.monthlyCents !== null;
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
 *  assessment cannot take down the list.
 *
 *  The caller loads the inventory, so a list loads every assessment's in one
 *  query (summarizeRows). */
export async function assessmentSavings(
  a: SavingsInput,
  inventory: InventoryItem[]
): Promise<{ currentSpend: CurrentSpend; netMonthlySavingsCents: number | null }> {
  const currentSpend = resolveCurrentSpend(
    a.reportedMonthlySpendCents,
    a.estimatedMonthlyCostCents
  );
  if (!hasSavingsComparison(a)) {
    return { currentSpend, netMonthlySavingsCents: null };
  }

  try {
    const report = await buildMigrationOptions({
      id: a.id,
      provider: a.provider,
      estimatedMonthlyCostCents: a.estimatedMonthlyCostCents,
      reportedMonthlySpendCents: a.reportedMonthlySpendCents,
      inventory: inventory.map(toInventoryItem),
    });
    return { currentSpend, netMonthlySavingsCents: headlineNetSavings(report) };
  } catch (err) {
    console.error(`savings comparison failed for assessment ${a.id}:`, err);
    return { currentSpend, netMonthlySavingsCents: null };
  }
}

// -- summaries ----------------------------------------------------------------------

/** GET /assessments page size: the default and the most a caller may ask for. */
export const ASSESSMENT_PAGE_SIZE = 50;

const SUMMARY_COLUMNS = {
  id: true,
  provider: true,
  status: true,
  startedAt: true,
  completedAt: true,
  resourceCount: true,
  estimatedMonthlyCostCents: true,
  reportedMonthlySpendCents: true,
  connectionId: true,
} as const;

type SummaryRow = {
  id: string;
  provider: string;
  status: string;
  startedAt: Date | null;
  completedAt: Date | null;
  resourceCount: number;
  estimatedMonthlyCostCents: number | null;
  reportedMonthlySpendCents: number | null;
  connectionId: string | null;
};

/**
 * One page of an org's assessment summaries, newest first. `cursor` is the
 * last id of the previous page; `nextCursor` is null on the last page.
 *
 * The database work is the same four queries whatever the page holds: the
 * page, the finding counts, the inventories (summarizeRows). It used to be
 * three or four queries per assessment. The savings comparison still reads
 * the provider catalog once per completed assessment (buildMigrationOptions),
 * which the page size caps.
 */
export async function listAssessmentSummaries(
  orgId: string,
  page: { limit: number; cursor?: string }
): Promise<{ summaries: AssessmentSummary[]; nextCursor: string | null }> {
  const rows = await prisma.assessment.findMany({
    where: { orgId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    // One extra row says whether there is another page.
    take: page.limit + 1,
    ...(page.cursor ? { cursor: { id: page.cursor }, skip: 1 } : {}),
    select: SUMMARY_COLUMNS,
  });
  const pageRows = rows.slice(0, page.limit);
  const nextCursor = rows.length > page.limit ? pageRows[pageRows.length - 1]!.id : null;
  return { summaries: await summarizeRows(pageRows), nextCursor };
}

/** One assessment's summary, or null. The caller checks the org. */
export async function summarizeAssessment(assessmentId: string): Promise<AssessmentSummary | null> {
  const row = await prisma.assessment.findUnique({ where: { id: assessmentId }, select: SUMMARY_COLUMNS });
  if (!row) return null;
  const [summary] = await summarizeRows([row]);
  return summary ?? null;
}

/** Summaries for these rows, in their order, from two batched queries: the
 *  finding counts by severity, and the inventory of the ones that get a
 *  savings figure. */
async function summarizeRows(rows: SummaryRow[]): Promise<AssessmentSummary[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const comparable = rows.filter(hasSavingsComparison).map((r) => r.id);
  const [severityCounts, inventoryRows] = await Promise.all([
    prisma.finding.groupBy({
      by: ["assessmentId", "severity"],
      where: { assessmentId: { in: ids } },
      _count: { _all: true },
    }),
    comparable.length
      ? prisma.inventoryItem.findMany({ where: { assessmentId: { in: comparable } } })
      : Promise.resolve([] as InventoryItem[]),
  ]);

  const inventoryByAssessment = new Map<string, InventoryItem[]>();
  for (const item of inventoryRows) {
    const list = inventoryByAssessment.get(item.assessmentId) ?? [];
    list.push(item);
    inventoryByAssessment.set(item.assessmentId, list);
  }

  return Promise.all(
    rows.map(async (a) => {
      const findingCounts: Record<FindingSeverity, number> = { info: 0, low: 0, medium: 0, high: 0 };
      for (const c of severityCounts) {
        if (c.assessmentId === a.id) findingCounts[c.severity as FindingSeverity] = c._count._all;
      }
      return {
        id: a.id,
        provider: a.provider as Provider,
        status: a.status as AssessmentStatus,
        startedAt: a.startedAt?.toISOString() ?? null,
        completedAt: a.completedAt?.toISOString() ?? null,
        resourceCount: a.resourceCount,
        estimatedMonthlyCostCents: a.estimatedMonthlyCostCents,
        ...(await assessmentSavings(a, inventoryByAssessment.get(a.id) ?? [])),
        findingCounts,
        connectionId: a.connectionId,
      };
    })
  );
}
