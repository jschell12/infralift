import { Router } from "express";
import { z } from "zod";
import type {
  AssessmentCostProjectionRow,
  AssessmentRecommendation,
  FindingSeverity,
  Provider,
} from "@infralift/shared";
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

export const assessmentsRouter = Router();

const runSchema = z.object({
  connectionId: z.string().min(1),
});

async function summarize(assessmentId: string) {
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
    status: a.status,
    startedAt: a.startedAt?.toISOString() ?? null,
    completedAt: a.completedAt?.toISOString() ?? null,
    resourceCount: a.resourceCount,
    estimatedMonthlyCostCents: a.estimatedMonthlyCostCents,
    estimatedMonthlySavingsCents: a.estimatedMonthlySavingsCents,
    findingCounts,
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
        estimatedMonthlySavingsCents: result.estimatedMonthlySavingsCents,
      },
    }),
  ]);
}

// List assessments for the authenticated user's org.
assessmentsRouter.get("/", async (req, res) => {
  const { orgId } = req.user!;
  const assessments = await prisma.assessment.findMany({
    where: { orgId },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  const summaries = await Promise.all(assessments.map((a) => summarize(a.id)));
  res.json(summaries.filter(Boolean));
});

// Run an assessment against a connection. Synchronous for now — connector
// calls are read-only and complete in seconds for small accounts.
assessmentsRouter.post("/run", async (req, res) => {
  const parsed = runSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request", detail: parsed.error.message });
  }

  const connection = await prisma.providerConnection.findUnique({
    where: { id: parsed.data.connectionId },
  });
  if (!connection || connection.orgId !== req.user!.orgId) {
    return res.status(404).json({ error: "Connection not found" });
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
    return res.status(502).json({
      error: "Assessment failed",
      detail: err instanceof Error ? err.message : String(err),
      assessmentId: assessment.id,
    });
  }

  res.status(201).json(await summarize(assessment.id));
});

/**
 * Assess from a snapshot the customer collected themselves.
 *
 * The token path above needs a ProviderConnection, which needs a provider
 * token, which is the thing a security review will not always approve. This
 * path takes the JSON that packages/collectors writes instead. Same analyzers,
 * same tables, no credential ever held.
 */
assessmentsRouter.post("/from-bundle", async (req, res) => {
  const { orgId } = req.user!;

  let parsedBundle;
  try {
    parsedBundle = parseBundle(req.body?.snapshot ?? req.body);
  } catch (err) {
    if (err instanceof BundleError) {
      return res.status(400).json({ error: err.message, detail: err.detail });
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
});

// Migration options: rank target providers against the assessed workload.
assessmentsRouter.get("/:id/options", async (req, res) => {
  const assessment = await prisma.assessment.findUnique({
    where: { id: req.params.id },
    include: { inventory: true },
  });
  if (!assessment || assessment.orgId !== req.user!.orgId) {
    return res.status(404).json({ error: "Not found" });
  }
  if (assessment.status !== "completed") {
    return res.status(400).json({ error: "Assessment not completed" });
  }

  const report = await buildMigrationOptions({
    id: assessment.id,
    provider: assessment.provider,
    estimatedMonthlyCostCents: assessment.estimatedMonthlyCostCents,
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
});

// Full report: summary + inventory + findings.
assessmentsRouter.get("/:id", async (req, res) => {
  // Ownership first. summarize() looks the assessment up by id alone, which
  // was safe while Cloudflare Access admitted exactly one email address and
  // stopped being safe the moment signup opened to any Google or GitHub
  // account: an id out of a shared dashboard URL would otherwise hand a
  // stranger another org's inventory, findings and costs. 404 rather than 403,
  // matching /:id/options, so the response does not confirm the id exists.
  const owned = await prisma.assessment.findFirst({
    where: { id: req.params.id, orgId: req.user!.orgId },
    select: { id: true },
  });
  if (!owned) return res.status(404).json({ error: "Not found" });

  const summary = await summarize(req.params.id);
  if (!summary) return res.status(404).json({ error: "Not found" });

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
  } = {};
  if (summary.status === "completed") {
    try {
      const options = await buildMigrationOptions({
        id: summary.id,
        provider: summary.provider,
        estimatedMonthlyCostCents: summary.estimatedMonthlyCostCents,
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
      extras = {
        costProjection: built.costProjection,
        ...(built.recommendation ? { recommendation: built.recommendation } : {}),
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
});
