import { Router } from "express";
import { z } from "zod";
import type { FindingSeverity, Provider } from "@infralift/shared";
import { prisma } from "../lib/db.js";
import { decryptToken } from "../lib/crypto.js";
import { getConnector } from "../connectors/index.js";
import { buildMigrationOptions } from "../lib/options.js";

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

    await prisma.$transaction([
      prisma.inventoryItem.createMany({
        data: result.inventory.map((item) => ({
          assessmentId: assessment.id,
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
          assessmentId: assessment.id,
          category: f.category,
          severity: f.severity,
          title: f.title,
          detail: f.detail,
          monthlySavingsCents: f.monthlySavingsCents ?? null,
          resourceRef: f.resourceRef ?? null,
        })),
      }),
      prisma.assessment.update({
        where: { id: assessment.id },
        data: {
          status: "completed",
          completedAt: new Date(),
          resourceCount: result.inventory.length,
          estimatedMonthlyCostCents: result.estimatedMonthlyCostCents,
          estimatedMonthlySavingsCents: result.estimatedMonthlySavingsCents,
        },
      }),
    ]);
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
  const summary = await summarize(req.params.id);
  if (!summary) return res.status(404).json({ error: "Not found" });

  const [inventory, findings] = await Promise.all([
    prisma.inventoryItem.findMany({ where: { assessmentId: req.params.id } }),
    prisma.finding.findMany({ where: { assessmentId: req.params.id } }),
  ]);

  res.json({
    ...summary,
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
