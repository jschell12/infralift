import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import type {
  AssessmentCostProjectionRow,
  AssessmentRecommendation,
  MigrationPlan,
  Provider,
} from "@infralift/shared";
import { PROVIDERS } from "@infralift/shared";
import { prisma } from "../lib/db.js";
import { decryptToken } from "../lib/crypto.js";
import { getConnector } from "../connectors/index.js";
import { connectionSecret } from "../services/aws-access.js";
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
import {
  ASSESSMENT_PAGE_SIZE,
  listAssessmentSummaries,
  refuseConcurrentRun,
  setReportedSpend,
  summarizeAssessment as summarize,
} from "../services/assessments.js";
import { toInventoryItem } from "../lib/inventory.js";
import { intQuery } from "../lib/query.js";
import { markInvalidOnAuthFailure } from "../services/connections.js";

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

// The org's assessments, newest first, one page at a time. The body stays a
// plain array, as the dashboard reads it; the first page is the latest 50.
// The next page's cursor travels in the X-Next-Cursor header, absent on the
// last page: GET /assessments?cursor=<that id>.
assessmentsRouter.get("/", handle(async (req, res) => {
  const limit = intQuery(req.query.limit, { name: "limit", fallback: ASSESSMENT_PAGE_SIZE, min: 1, max: ASSESSMENT_PAGE_SIZE });
  const cursor = typeof req.query.cursor === "string" && req.query.cursor ? req.query.cursor : undefined;
  const { summaries, nextCursor } = await listAssessmentSummaries(req.user!.orgId, { limit, cursor });
  if (nextCursor) res.setHeader("X-Next-Cursor", nextCursor);
  res.json(summaries);
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
  // 409 while this connection already has a run going.
  await refuseConcurrentRun(connection.orgId, connection.id);
  // AWS: always the caller's org's external ID; 422 when AWS is off here.
  const secret = await connectionSecret(connection.orgId, connection.provider, decryptToken(connection.encryptedToken));

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
    const result = await connector.assess(secret);

    await persistAssessmentResult(assessment.id, result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.assessment.update({
      where: { id: assessment.id },
      data: { status: "failed", completedAt: new Date(), error: message },
    });
    // A 401/403 means the stored credential no longer works; say so on the
    // connection, where the customer can replace it. A 5xx does not.
    await markInvalidOnAuthFailure(connection, err, "connector", "an assessment");
    // The provider's own message goes to the log, never the response: it can
    // quote a response body, and the dashboard shows a sentence instead. The
    // request id ties the two together when a customer reports it.
    const requestId = randomUUID();
    console.error(
      `assessment ${assessment.id} failed (${connection.provider}) [request ${requestId}]: ${message}`
    );
    throw new Upstream("Assessment failed", { assessmentId: assessment.id, requestId });
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
    const message = err instanceof Error ? err.message : String(err);
    await prisma.assessment.update({
      where: { id: assessment.id },
      data: { status: "failed", completedAt: new Date(), error: message },
    });
    // Sent by hand on purpose: a failed bundle assessment is our fault (500),
    // and the body carries the assessment id the dashboard links to. The
    // analyzer's message is logged under a request id, not sent.
    const requestId = randomUUID();
    console.error(
      `bundle assessment ${assessment.id} failed [request ${requestId}]: ${message}`
    );
    return res.status(500).json({
      error: "Could not read that snapshot",
      assessmentId: assessment.id,
      requestId,
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
    inventory: assessment.inventory.map(toInventoryItem),
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
  const inventoryItems = inventory.map(toInventoryItem);

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
        inventory: inventoryItems,
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
          inventory: inventoryItems,
        }),
      };
    } catch (err) {
      console.error(`report extras failed for assessment ${summary.id}:`, err);
    }
  }

  res.json({
    ...summary,
    ...extras,
    inventory: inventoryItems,
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
