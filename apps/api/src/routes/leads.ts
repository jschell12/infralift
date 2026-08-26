import { Router } from "express";
import { prisma } from "../lib/db.js";

export const leadsRouter = Router();

// List classified community leads with filtering.
leadsRouter.get("/", async (req, res) => {
  const classification = req.query.classification
    ? String(req.query.classification)
    : undefined;
  const platform = req.query.platform
    ? String(req.query.platform)
    : undefined;
  const days = req.query.days ? Number(req.query.days) : 7;
  const limit = req.query.limit ? Math.min(Number(req.query.limit), 500) : 100;

  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const leads = await prisma.communityLead.findMany({
    where: {
      ...(classification && { classification }),
      ...(platform && { platform }),
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

// Summary counts by classification.
leadsRouter.get("/summary", async (req, res) => {
  const days = req.query.days ? Number(req.query.days) : 7;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const counts = await prisma.communityLead.groupBy({
    by: ["classification"],
    where: { scrapedAt: { gte: since } },
    _count: true,
  });

  const summary: Record<string, number> = {};
  for (const row of counts) {
    summary[row.classification] = row._count;
  }
  summary.total = Object.values(summary).reduce((a, b) => a + b, 0);

  res.json(summary);
});
