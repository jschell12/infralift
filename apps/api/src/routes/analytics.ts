import { Router } from "express";
import { prisma } from "../lib/db.js";

export const analyticsRouter = Router();

// Marketing-site analytics over the last N days, from the AnalyticsDaily
// rollups (see ../analytics/rollup.ts).
analyticsRouter.get("/", async (req, res) => {
  const days = Math.min(
    Math.max(req.query.days ? Number(req.query.days) : 30, 1) || 30,
    90
  );
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  since.setUTCHours(0, 0, 0, 0);

  const rows = await prisma.analyticsDaily.findMany({
    where: { date: { gte: since } },
    orderBy: { date: "asc" },
  });

  const daily: { date: string; views: number; visitors: number }[] = [];
  const channelTotals = new Map<string, { views: number; visitors: number }>();
  const pathTotals = new Map<string, number>();

  for (const row of rows) {
    if (row.dimension === "total") {
      daily.push({
        date: row.date.toISOString().slice(0, 10),
        views: row.views,
        visitors: row.visitors,
      });
    } else if (row.dimension === "channel") {
      const c = channelTotals.get(row.key) ?? { views: 0, visitors: 0 };
      c.views += row.views;
      c.visitors += row.visitors;
      channelTotals.set(row.key, c);
    } else if (row.dimension === "path") {
      pathTotals.set(row.key, (pathTotals.get(row.key) ?? 0) + row.views);
    }
  }

  const channels = [...channelTotals.entries()]
    .map(([channel, c]) => ({ channel, views: c.views, visitors: c.visitors }))
    .sort((a, b) => b.views - a.views);

  const paths = [...pathTotals.entries()]
    .map(([path, views]) => ({ path, views }))
    .sort((a, b) => b.views - a.views)
    .slice(0, 20);

  res.json({ days: daily, channels, paths });
});
