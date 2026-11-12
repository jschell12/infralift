"use client";

import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import {
  Card,
  CardTitle,
  H1,
  NUM,
  StatCard,
  TableHead,
  TableRow,
  TableScroll,
} from "../../components/ui";

interface AnalyticsData {
  days: { date: string; views: number; visitors: number }[];
  channels: { channel: string; views: number; visitors: number }[];
  paths: { path: string; views: number }[];
}

const DAYS = 30;
const CHANNEL_COLS = "grid-cols-[1fr_100px_100px]";
const PATH_COLS = "grid-cols-[1fr_100px]";

/** Hand-rolled daily views bar chart — flex columns, no chart dep. */
function DailyChart({ days }: { days: AnalyticsData["days"] }) {
  if (days.length === 0) {
    return <p className="text-sm text-muted">No daily data yet.</p>;
  }
  const max = Math.max(...days.map((d) => d.views), 1);
  return (
    <div>
      <div className="flex h-[160px] items-end gap-[3px]">
        {days.map((d) => (
          <div
            key={d.date}
            className="group relative flex-1 rounded-t-sm bg-muted/60 hover:bg-muted"
            style={{ height: `${Math.max((d.views / max) * 100, 2)}%` }}
            title={`${d.date}: ${d.views} views, ${d.visitors} visitors`}
          />
        ))}
      </div>
      <div className="mt-1.5 flex justify-between text-xs text-faint">
        <span>{days[0].date}</span>
        <span>{days[days.length - 1].date}</span>
      </div>
    </div>
  );
}

export default function AnalyticsPage() {
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<AnalyticsData>(`/analytics?days=${DAYS}`)
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const totalViews = data?.days.reduce((a, d) => a + d.views, 0) ?? 0;
  const totalVisitors = data?.days.reduce((a, d) => a + d.visitors, 0) ?? 0;
  const topChannel = data?.channels[0]?.channel ?? "—";

  return (
    <>
      <h1 className={H1}>Analytics</h1>
      <p className="mb-6 max-w-[660px] text-muted">
        First-party traffic on infralift.dev over the last {DAYS} days. Rolled
        up nightly from Workers Analytics Engine — no cookies, no third-party
        scripts.
      </p>

      {error && <div className="mb-4 text-sm text-danger">{error}</div>}
      {!data && !error && <p className="text-sm text-muted">Loading…</p>}

      {data && (
        <>
          <div className="mb-5 grid grid-cols-3 gap-3 sm:gap-4">
            <StatCard label="page views" value={totalViews} center />
            <StatCard label="visitors" value={totalVisitors} center />
            <StatCard label="top channel" value={topChannel} center />
          </div>

          <Card className="mb-5">
            <CardTitle>Daily views</CardTitle>
            <DailyChart days={data.days} />
          </Card>

          <div className="grid gap-5 lg:grid-cols-2">
            <Card>
              <CardTitle>Channels</CardTitle>
              {data.channels.length === 0 ? (
                <p className="text-sm text-muted">No channel data yet.</p>
              ) : (
                <TableScroll min="min-w-[320px]">
                  <TableHead cols={CHANNEL_COLS}>
                    <span>Channel</span>
                    <span className="text-right">Views</span>
                    <span className="text-right">Visitors</span>
                  </TableHead>
                  {data.channels.map((c) => (
                    <TableRow key={c.channel} cols={CHANNEL_COLS}>
                      <span className="text-text">{c.channel}</span>
                      <span className={`text-right text-muted ${NUM}`}>
                        {c.views}
                      </span>
                      <span className={`text-right text-muted ${NUM}`}>
                        {c.visitors}
                      </span>
                    </TableRow>
                  ))}
                </TableScroll>
              )}
            </Card>

            <Card>
              <CardTitle>Top pages</CardTitle>
              {data.paths.length === 0 ? (
                <p className="text-sm text-muted">No page data yet.</p>
              ) : (
                <TableScroll min="min-w-[320px]">
                  <TableHead cols={PATH_COLS}>
                    <span>Path</span>
                    <span className="text-right">Views</span>
                  </TableHead>
                  {data.paths.map((p) => (
                    <TableRow key={p.path} cols={PATH_COLS}>
                      <span className="truncate font-mono text-xs text-text">
                        {p.path}
                      </span>
                      <span className={`text-right text-muted ${NUM}`}>
                        {p.views}
                      </span>
                    </TableRow>
                  ))}
                </TableScroll>
              )}
            </Card>
          </div>
        </>
      )}
    </>
  );
}
