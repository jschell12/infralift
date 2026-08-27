import { Router } from "express";
import { prisma } from "../lib/db.js";

export const leadsRouter = Router();

const VALID_STATUSES = ["new", "contacted", "dismissed", "converted"] as const;

// List classified community leads with filtering.
leadsRouter.get("/", async (req, res) => {
  const classification = req.query.classification
    ? String(req.query.classification)
    : undefined;
  const platform = req.query.platform
    ? String(req.query.platform)
    : undefined;
  const status = req.query.status
    ? String(req.query.status)
    : undefined;
  const days = req.query.days ? Number(req.query.days) : 7;
  const limit = req.query.limit ? Math.min(Number(req.query.limit), 500) : 100;

  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const leads = await prisma.communityLead.findMany({
    where: {
      ...(classification && { classification }),
      ...(platform && { platform }),
      ...(status && { status }),
      scrapedAt: { gte: since },
    },
    include: {
      community: { select: { name: true, slug: true, platform: true } },
    },
    orderBy: [{ engagementScore: "desc" }, { scrapedAt: "desc" }],
    take: limit,
  });

  res.json(leads);
});

// Summary counts by classification and status.
leadsRouter.get("/summary", async (req, res) => {
  const days = req.query.days ? Number(req.query.days) : 7;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const [classificationCounts, statusCounts] = await Promise.all([
    prisma.communityLead.groupBy({
      by: ["classification"],
      where: { scrapedAt: { gte: since } },
      _count: true,
    }),
    prisma.communityLead.groupBy({
      by: ["status"],
      where: { scrapedAt: { gte: since } },
      _count: true,
    }),
  ]);

  const summary: Record<string, number> = {};
  for (const row of classificationCounts) {
    summary[row.classification] = row._count;
  }
  summary.total = Object.values(summary).reduce((a, b) => a + b, 0);

  const byStatus: Record<string, number> = {};
  for (const row of statusCounts) {
    byStatus[row.status] = row._count;
  }

  res.json({ ...summary, byStatus });
});

// Scanner health status.
leadsRouter.get("/scanner-status", async (req, res) => {
  const now = Date.now();
  const since24h = new Date(now - 24 * 60 * 60 * 1000);
  const since7d = new Date(now - 7 * 24 * 60 * 60 * 1000);
  const since30d = new Date(now - 30 * 24 * 60 * 60 * 1000);

  const [
    totalLeads,
    byPlatform,
    last24h,
    last7d,
    last30d,
    mostRecent,
  ] = await Promise.all([
    prisma.communityLead.count(),
    prisma.communityLead.groupBy({
      by: ["platform"],
      _count: true,
    }),
    prisma.communityLead.count({ where: { scrapedAt: { gte: since24h } } }),
    prisma.communityLead.count({ where: { scrapedAt: { gte: since7d } } }),
    prisma.communityLead.count({ where: { scrapedAt: { gte: since30d } } }),
    prisma.communityLead.findFirst({
      orderBy: { scrapedAt: "desc" },
      select: { scrapedAt: true },
    }),
  ]);

  const platformBreakdown: Record<string, number> = {};
  for (const row of byPlatform) {
    platformBreakdown[row.platform] = row._count;
  }

  res.json({
    totalLeads,
    byPlatform: platformBreakdown,
    last24h,
    last7d,
    last30d,
    lastScanTime: mostRecent?.scrapedAt ?? null,
  });
});

// Full report data for admin dashboard.
leadsRouter.get("/report", async (req, res) => {
  const [
    total,
    byClassification,
    byStatus,
    topLeads,
  ] = await Promise.all([
    prisma.communityLead.count(),
    prisma.communityLead.groupBy({
      by: ["classification"],
      _count: true,
    }),
    prisma.communityLead.groupBy({
      by: ["status"],
      _count: true,
    }),
    prisma.communityLead.findMany({
      orderBy: { engagementScore: "desc" },
      take: 20,
      include: {
        community: { select: { name: true, slug: true, platform: true } },
      },
    }),
  ]);

  // Raw SQL for provider breakdown and cross-tab (Prisma can't unnest arrays)
  const byProvider: { provider: string; n: string }[] = await prisma.$queryRaw`
    SELECT unnest(providers) as provider, count(*)::text as n
    FROM "CommunityLead"
    GROUP BY provider ORDER BY count(*) DESC`;

  const crossTab: { provider: string; classification: string; n: string }[] = await prisma.$queryRaw`
    SELECT unnest(providers) as provider, classification, count(*)::text as n
    FROM "CommunityLead"
    GROUP BY provider, classification ORDER BY provider, count(*) DESC`;

  const byPlatform = await prisma.communityLead.groupBy({
    by: ["platform"],
    _count: true,
  });

  res.json({
    total,
    byClassification: Object.fromEntries(byClassification.map((r) => [r.classification, r._count])),
    byStatus: Object.fromEntries(byStatus.map((r) => [r.status, r._count])),
    byProvider: byProvider.map((r) => ({ provider: r.provider, count: Number(r.n) })),
    byPlatform: Object.fromEntries(byPlatform.map((r) => [r.platform, r._count])),
    crossTab: crossTab.map((r) => ({ provider: r.provider, classification: r.classification, count: Number(r.n) })),
    topLeads,
  });
});

// PATCH /leads/:id - update lead status
leadsRouter.patch("/:id", async (req, res) => {
  const { id } = req.params;
  const { status, notes } = req.body;

  if (status && !VALID_STATUSES.includes(status)) {
    res.status(400).json({
      error: `Invalid status. Must be one of: ${VALID_STATUSES.join(", ")}`,
    });
    return;
  }

  const data: Record<string, string> = {};
  if (status) data.status = status;
  if (notes !== undefined) data.notes = notes;

  if (Object.keys(data).length === 0) {
    res.status(400).json({ error: "No fields to update" });
    return;
  }

  try {
    const updated = await prisma.communityLead.update({
      where: { id },
      data,
      include: {
        community: { select: { name: true, slug: true, platform: true } },
      },
    });
    res.json(updated);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    if (message.includes("Record to update not found")) {
      res.status(404).json({ error: "Lead not found" });
      return;
    }
    throw e;
  }
});
