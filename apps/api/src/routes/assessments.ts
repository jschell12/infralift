import { Router } from "express";
import { z } from "zod";
import type {
  AssessmentCostProjectionRow,
  AssessmentRecommendation,
  AssessmentStatus,
  AssessmentSummary,
  MigrationPlan,
  FindingSeverity,
  Provider,
} from "@infralift/shared";
import { PROVIDERS } from "@infralift/shared";
import { prisma } from "../lib/db.js";
import { decryptToken } from "../lib/crypto.js";
import { getConnector } from "../connectors/index.js";
import type { ConnectorAssessment } from "../connectors/types.js";
import {
  parseBundle,
  analyzeBundle,
  bundleAgeDays,
  BundleError,
} from "../connectors/bundle.js";
import { buildMigrationOptions } from "../lib/options.js";
import { buildReportExtras } from "../lib/report-extras.js";
import { buildMigrationPlan } from "../lib/migration-plan.js";
import { InvalidInput, NotFound, Upstream, handle, parseBody } from "../lib/errors.js";
import { assessmentSavings, setReportedSpend } from "../services/assessments.js";

export const assessmentsRouter = Router();

const runSchema = z.object({
  connectionId: z.string().min(1),
});

// The customer's monthly bill in dollars, as read off an invoice; null clears
// it. Capped like the public estimator's field, so a stray keystroke cannot
// store a number no comparison should be made against. Zero is refused: no
// account that was worth assessing bills nothing, and a $0 bill turned every
// target into a loss and the report into "stay put". Clearing is null. The
// floor is a cent rather than "positive" because the service rounds to cents,
// and $0.004 would round back to the zero this exists to keep out.
const spendSchema = z.object({
  monthlyUsd: z.number().min(0.01).max(10_000_000).nullable(),
});

async function summarize(assessmentId: string): Promise<AssessmentSummary | null> {
  const a = await prisma.assessment.findUnique({
    where: { id: assessmentId },
    include: { findings: { select: { severity: true } } },
  });
  if (!a) return null;
  const findingCounts: Record<FindingSeverity, number> = {
    info: 0,
    low: 0,
    medium: 0,
    high: 0,
  };
  for (const f of a.findings) {
    findingCounts[f.severity as FindingSeverity] =
      (findingCounts[f.severity as FindingSeverity] ?? 0) + 1;
  }
  return {
    id: a.id,
    provider: a.provider as Provider,
    status: a.status as AssessmentStatus,
    startedAt: a.startedAt?.toISOString() ?? null,
    completedAt: a.completedAt?.toISOString() ?? null,
    resourceCount: a.resourceCount,
    estimatedMonthlyCostCents: a.estimatedMonthlyCostCents,
    ...(await assessmentSavings(a)),
    findingCounts,
    connectionId: a.connectionId,
  };
}

/** Write inventory, findings and the completed status in one transaction.
 * Shared by the token path and the bundle path so the two cannot persist the
 * same assessment differently. */
async function persistAssessmentResult(
  assessmentId: string,
  result: ConnectorAssessment
) {
  await prisma.$transaction([
    prisma.inventoryItem.createMany({
      data: result.inventory.map((item) => ({
        assessmentId,
        provider: item.provider,
        type: item.type,
        externalId: item.externalId,
        name: item.name,
        region: item.region ?? null,
        monthlyCostCents: item.monthlyCostCents ?? null,
        metadata: item.metadata as object | undefined,
      })),
    }),
    prisma.finding.createMany({
      data: result.findings.map((f) => ({
        assessmentId,
        category: f.category,
        severity: f.severity,
        title: f.title,
        detail: f.detail,
        monthlySavingsCents: f.monthlySavingsCents ?? null,
        resourceRef: f.resourceRef ?? null,
      })),
    }),
    prisma.assessment.update({
      where: { id: assessmentId },
      data: {
        status: "completed",
        completedAt: new Date(),
        resourceCount: result.inventory.length,
        estimatedMonthlyCostCents: result.estimatedMonthlyCostCents,
      },
    }),
  ]);
}

// List assessments for the authenticated user's org.
assessmentsRouter.get("/", handle(async (req, res) => {
  const { orgId } = req.user!;
  const assessments = await prisma.assessment.findMany({
    where: { orgId },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  const summaries = await Promise.all(assessments.map((a) => summarize(a.id)));
  res.json(summaries.filter(Boolean));
}));

// Run an assessment against a connection. Synchronous for now — connector
// calls are read-only and complete in seconds for small accounts.
assessmentsRouter.post("/run", handle(async (req, res) => {
  const parsed = runSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new InvalidInput("Invalid request", { detail: parsed.error.message });
  }

  const connection = await prisma.providerConnection.findFirst({
    where: { id: parsed.data.connectionId, orgId: req.user!.orgId },
  });
  if (!connection) throw new NotFound("Connection not found");
  // Connections also hold destinations that are not assessment sources, such
  // as a customer's Terraform Cloud org ("tfc"), which has no connector.
  if (!(PROVIDERS as readonly string[]).includes(connection.provider)) {
    throw new InvalidInput(`${connection.provider} connections cannot be assessed`);
  }

  const assessment = await prisma.assessment.create({
    data: {
      orgId: connection.orgId,
      connectionId: connection.id,
      provider: connection.provider,
      status: "running",
      startedAt: new Date(),
    },
  });

  try {
    const connector = getConnector(connection.provider as Provider);
    const result = await connector.assess(
      decryptToken(connection.encryptedToken)
    );

    await persistAssessmentResult(assessment.id, result);
  } catch (err) {
    await prisma.assessment.update({
      where: { id: assessment.id },
      data: {
        status: "failed",
        completedAt: new Date(),
        error: err instanceof Error ? err.message : String(err),
      },
    });
    throw new Upstream("Assessment failed", { detail: err instanceof Error ? err.message : String(err), assessmentId: assessment.id });
  }

  res.status(201).json(await summarize(assessment.id));
}));

/**
 * Assess from a snapshot the customer collected themselves.
 *
 * The token path above needs a ProviderConnection, which needs a provider
 * token, which is the thing a security review will not always approve. This
 * path takes the JSON that packages/collectors writes instead. Same analyzers,
 * same tables, no credential ever held.
 */
assessmentsRouter.post("/from-bundle", handle(async (req, res) => {
  const { orgId } = req.user!;

  let parsedBundle;
  try {
    parsedBundle = parseBundle(req.body?.snapshot ?? req.body);
  } catch (err) {
    if (err instanceof BundleError) {
      throw new InvalidInput(err.message, { detail: err.detail });
    }
    throw err;
  }

  const assessment = await prisma.assessment.create({
    data: {
      orgId,
      // No connection: that is the point of this path.
      connectionId: null,
      provider: parsedBundle.provider,
      source: "bundle",
      collectorVersion: parsedBundle.collectorVersion,
      collectedAt: parsedBundle.collectedAt,
      status: "running",
      startedAt: new Date(),
    },
  });

  try {
    // Analysis is pure, so the only way this throws is a bug in our own
    // analyzer — the bundle was already validated above.
    const result = analyzeBundle(parsedBundle);
    await persistAssessmentResult(assessment.id, result);
  } catch (err) {
    await prisma.assessment.update({
      where: { id: assessment.id },
      data: {
        status: "failed",
        completedAt: new Date(),
        error: err instanceof Error ? err.message : String(err),
      },
    });
    // Sent by hand on purpose: a failed bundle assessment is our fault (500),
    // and the body carries the assessment id the dashboard links to.
    return res.status(500).json({
      error: "Could not read that snapshot",
      detail: err instanceof Error ? err.message : String(err),
      assessmentId: assessment.id,
    });
  }

  res.status(201).json({
    ...(await summarize(assessment.id)),
    source: "bundle",
    collectedAt: parsedBundle.collectedAt.toISOString(),
    ageDays: bundleAgeDays(parsedBundle),
  });
}));

// Migration options: rank target providers against the assessed workload.
assessmentsRouter.get("/:id/options", handle(async (req, res) => {
  const assessment = await prisma.assessment.findFirst({
    where: { id: req.params.id, orgId: req.user!.orgId },
    include: { inventory: true },
  });
  if (!assessment) throw new NotFound("Not found");
  if (assessment.status !== "completed") {
    throw new InvalidInput("Assessment not completed");
  }

  const report = await buildMigrationOptions({
    id: assessment.id,
    provider: assessment.provider,
    estimatedMonthlyCostCents: assessment.estimatedMonthlyCostCents,
    reportedMonthlySpendCents: assessment.reportedMonthlySpendCents,
    inventory: assessment.inventory.map((i) => ({
      provider: i.provider as Provider,
      type: i.type,
      externalId: i.externalId,
      name: i.name,
      region: i.region ?? undefined,
      monthlyCostCents: i.monthlyCostCents ?? undefined,
      metadata: (i.metadata as Record<string, unknown> | null) ?? undefined,
    })),
  });
  res.json(report);
}));

// The customer's own monthly bill, which the comparison uses in place of the
// inventory priced at list rates.
assessmentsRouter.patch("/:id/spend", handle(async (req, res) => {
  const { monthlyUsd } = parseBody(spendSchema, req.body);
  res.json(await setReportedSpend(req.user!.orgId, req.params.id, monthlyUsd));
}));

// Full report: summary + inventory + findings.
assessmentsRouter.get("/:id", handle(async (req, res) => {
  // Ownership first. summarize() looks the assessment up by id alone, which
  // was safe while Cloudflare Access admitted exactly one email address and
  // stopped being safe the moment signup opened to any Google or GitHub
  // account: an id out of a shared dashboard URL would otherwise hand a
  // stranger another org's inventory, findings and costs. 404 rather than 403,
  // matching /:id/options, so the response does not confirm the id exists.
  const owned = await prisma.assessment.findFirst({
    where: { id: req.params.id, orgId: req.user!.orgId },
    select: { id: true, reportedMonthlySpendCents: true },
  });
  if (!owned) throw new NotFound("Not found");

  const summary = await summarize(req.params.id);
  if (!summary) throw new NotFound("Not found");

  const [inventory, findings] = await Promise.all([
    prisma.inventoryItem.findMany({ where: { assessmentId: req.params.id } }),
    prisma.finding.findMany({ where: { assessmentId: req.params.id } }),
  ]);

  // The cost projection and recommendation are advertised as part of the
  // report and used to live only on the options page. They are derived from
  // the same buildMigrationOptions() call, so the two pages cannot disagree.
  // A failure here must not take down the report: the inventory and findings
  // are the part a customer paid nothing for and still expects to see.
  let extras: {
    costProjection?: AssessmentCostProjectionRow[];
    recommendation?: AssessmentRecommendation;
    migrationPlan?: MigrationPlan;
  } = {};
  if (summary.status === "completed") {
    try {
      const options = await buildMigrationOptions({
        id: summary.id,
        provider: summary.provider,
        estimatedMonthlyCostCents: summary.estimatedMonthlyCostCents,
        reportedMonthlySpendCents: owned.reportedMonthlySpendCents,
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
      const built = buildReportExtras(options);

      // The plan for the work the codegen does not do: data sync, DNS,
      // secrets, CI/CD, rollback, verification. Built against the recommended
      // target so its steps are concrete, and shipped with the free report
      // rather than gated — a buyer deciding whether a migration is worth
      // doing needs to see what it involves, and that is also the honest
      // answer to "you only automated the easy part".
      const planTargetName =
        built.recommendation?.target ?? options.options[0]?.name ?? "the target";

      extras = {
        costProjection: built.costProjection,
        ...(built.recommendation ? { recommendation: built.recommendation } : {}),
        migrationPlan: buildMigrationPlan({
          provider: summary.provider,
          target: planTargetName,
          inventory: inventory.map((i) => ({
            provider: i.provider as Provider,
            type: i.type,
            externalId: i.externalId,
            name: i.name,
            region: i.region ?? undefined,
            monthlyCostCents: i.monthlyCostCents ?? undefined,
            metadata: (i.metadata as Record<string, unknown> | null) ?? undefined,
          })),
        }),
      };
    } catch (err) {
      console.error(`report extras failed for assessment ${summary.id}:`, err);
    }
  }

  res.json({
    ...summary,
    ...extras,
    inventory: inventory.map((i) => ({
      provider: i.provider,
      type: i.type,
      externalId: i.externalId,
      name: i.name,
      region: i.region ?? undefined,
      monthlyCostCents: i.monthlyCostCents ?? undefined,
      metadata: (i.metadata as Record<string, unknown> | null) ?? undefined,
    })),
    findings: findings.map((f) => ({
      id: f.id,
      category: f.category,
      severity: f.severity,
      title: f.title,
      detail: f.detail,
      monthlySavingsCents: f.monthlySavingsCents ?? undefined,
      resourceRef: f.resourceRef ?? undefined,
    })),
  });
}));
