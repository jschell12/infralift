/**
 * Nightly rollup of marketing-site analytics from Workers Analytics Engine
 * into Postgres (AnalyticsDaily).
 *
 * The Worker at apps/web/worker/index.ts writes one data point per page
 * view to the WAE dataset `marketing_analytics` with this blob layout:
 *   index1 site, blob1 site, blob2 path, blob3 referrer host,
 *   blob4 utm_source, blob5 utm_medium, blob6 utm_campaign,
 *   blob7 country, blob8 daily visitor hash.
 *
 * WAE keeps raw events for ~90 days, so we periodically roll complete UTC
 * days up into AnalyticsDaily rows (dimension total/channel/path). A day is
 * considered done once its (date, "total", "") row exists.
 */
import { prisma } from "../lib/db.js";
import { channelFor } from "./channels.js";
import { HTTP_TIMEOUTS_MS, httpFetch } from "../lib/http.js";

const SITE = "infralift";
const DATASET = "marketing_analytics";
const INTERVAL_MS = 60 * 60 * 1000; // hourly; each pass backfills up to 7 days
const LOOKBACK_DAYS = 7;

interface GroupRow {
  path: string;
  ref: string;
  utm_source: string;
  views: string | number;
  visitors: string | number;
}

interface TotalRow {
  views: string | number;
  visitors: string | number;
}

async function waeQuery<T>(sql: string): Promise<T[]> {
  const accountId = process.env.CF_ACCOUNT_ID;
  const token = process.env.CF_ANALYTICS_TOKEN;
  const res = await httpFetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: sql,
    },
    { timeoutMs: HTTP_TIMEOUTS_MS.analyticsSql }
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`WAE SQL API ${res.status}: ${text.slice(0, 300)}`);
  }
  const json = (await res.json()) as { data?: T[] };
  return json.data ?? [];
}

function utcDayString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Roll up a single complete UTC day (YYYY-MM-DD) into AnalyticsDaily. */
export async function rollupDay(day: string): Promise<void> {
  const next = new Date(`${day}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  const nextDay = utcDayString(next);
  const range = `timestamp >= toDateTime('${day} 00:00:00') AND timestamp < toDateTime('${nextDay} 00:00:00')`;

  const [groups, totals] = await Promise.all([
    waeQuery<GroupRow>(
      `SELECT blob2 AS path, blob3 AS ref, blob4 AS utm_source,
              SUM(_sample_interval) AS views, COUNT(DISTINCT blob8) AS visitors
       FROM ${DATASET}
       WHERE index1 = '${SITE}' AND ${range}
       GROUP BY path, ref, utm_source
       FORMAT JSON`
    ),
    waeQuery<TotalRow>(
      `SELECT SUM(_sample_interval) AS views, COUNT(DISTINCT blob8) AS visitors
       FROM ${DATASET}
       WHERE index1 = '${SITE}' AND ${range}
       FORMAT JSON`
    ),
  ]);

  const date = new Date(`${day}T00:00:00Z`);

  // Per-channel aggregates. Visitors per channel is a sum of per-group
  // distinct counts, so it can overcount a visitor arriving via several
  // referrers — acceptable for channel-level comparison.
  const channels = new Map<string, { views: number; visitors: number }>();
  const paths = new Map<string, number>();
  for (const row of groups) {
    const views = Number(row.views) || 0;
    const visitors = Number(row.visitors) || 0;
    const ch = channelFor(row.ref, row.utm_source);
    const c = channels.get(ch) ?? { views: 0, visitors: 0 };
    c.views += views;
    c.visitors += visitors;
    channels.set(ch, c);
    paths.set(row.path, (paths.get(row.path) ?? 0) + views);
  }

  const upserts = [];
  for (const [channel, c] of channels) {
    upserts.push(
      prisma.analyticsDaily.upsert({
        where: {
          date_dimension_key: { date, dimension: "channel", key: channel },
        },
        create: {
          date,
          dimension: "channel",
          key: channel,
          views: c.views,
          visitors: c.visitors,
        },
        update: { views: c.views, visitors: c.visitors },
      })
    );
  }
  for (const [path, views] of paths) {
    upserts.push(
      prisma.analyticsDaily.upsert({
        where: { date_dimension_key: { date, dimension: "path", key: path } },
        create: { date, dimension: "path", key: path, views, visitors: 0 },
        update: { views, visitors: 0 },
      })
    );
  }
  await Promise.all(upserts);

  // Total row last — writing it marks the day as done, so it must only
  // land after the channel/path rows committed. Always written (even 0s)
  // so zero-traffic days don't get re-queried forever.
  const total = totals[0] ?? { views: 0, visitors: 0 };
  await prisma.analyticsDaily.upsert({
    where: { date_dimension_key: { date, dimension: "total", key: "" } },
    create: {
      date,
      dimension: "total",
      key: "",
      views: Number(total.views) || 0,
      visitors: Number(total.visitors) || 0,
    },
    update: {
      views: Number(total.views) || 0,
      visitors: Number(total.visitors) || 0,
    },
  });
}

async function pass(): Promise<void> {
  // Last LOOKBACK_DAYS complete UTC days, excluding today (still filling).
  const days: string[] = [];
  const now = new Date();
  for (let i = 1; i <= LOOKBACK_DAYS; i++) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    days.push(utcDayString(d));
  }

  const done = await prisma.analyticsDaily.findMany({
    where: {
      dimension: "total",
      key: "",
      date: { in: days.map((d) => new Date(`${d}T00:00:00Z`)) },
    },
    select: { date: true },
  });
  const doneSet = new Set(done.map((r) => utcDayString(r.date)));

  for (const day of days) {
    if (doneSet.has(day)) continue;
    try {
      await rollupDay(day);
      console.log(`[analytics] rolled up ${day}`);
    } catch (e) {
      console.error(
        `[analytics] rollup failed for ${day}:`,
        e instanceof Error ? e.message : e
      );
    }
  }
}

/** Start the hourly analytics rollup loop. Call once after listen(). */
export function startAnalyticsRollup(): void {
  if (!process.env.CF_ACCOUNT_ID || !process.env.CF_ANALYTICS_TOKEN) {
    console.log(
      "[analytics] rollup disabled (CF_ACCOUNT_ID / CF_ANALYTICS_TOKEN not set)"
    );
    return;
  }
  const run = () => void pass().catch((e) => console.error("[analytics]", e));
  run();
  setInterval(run, INTERVAL_MS).unref();
}
