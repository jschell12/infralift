"use client";

import { useCallback, useEffect, useState } from "react";
import { api, errorText } from "../../lib/api";
import {
  Card,
  CardTitle,
  Chip,
  Dot,
  ErrorState,
  H1,
  NUM,
  StatCard,
  TableHead,
  TableRow,
  type Tone,
} from "../../components/ui";

interface ScannerStatus {
  totalLeads: number;
  byPlatform: Record<string, number>;
  last24h: number;
  last7d: number;
  last30d: number;
  lastScanTime: string | null;
}

/* TODO(api): /leads/pipeline-health doesn't exist yet. Component states are
 * fixtures; the shape is one row per pipeline stage. */
const HEALTH: { name: string; detail: string; state: "ok" | "warn" }[] = [
  { name: "reddit scraper", detail: "ok", state: "ok" },
  { name: "hackernews scraper", detail: "ok", state: "ok" },
  { name: "classifier", detail: "96.2% confident", state: "ok" },
  { name: "discord relay", detail: "degraded \u00b7 2 guilds down", state: "warn" },
  { name: "dedupe index", detail: "ok \u00b7 0 collisions", state: "ok" },
];

const HEALTH_TONE: Record<"ok" | "warn", Tone> = { ok: "ok", warn: "warn" };
const PLATFORM_COLS = "grid-cols-[1fr_90px]";

function formatTimeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export default function ScannerPage() {
  const [status, setStatus] = useState<ScannerStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    api<ScannerStatus>("/leads/scanner-status")
      .then(setStatus)
      .catch((e) => setError(errorText(e)));
  }, []);

  useEffect(load, [load]);

  if (error) {
    return (
      <>
        <h1 className={H1}>Scanner status</h1>
        <ErrorState message={error} onRetry={load} />
      </>
    );
  }

  if (!status) {
    return (
      <>
        <h1 className={H1}>Scanner status</h1>
        <p className="mt-4 text-sm text-muted">Loading...</p>
      </>
    );
  }

  const platforms = Object.entries(status.byPlatform).sort(
    ([, a], [, b]) => b - a
  );
  const lastScan = status.lastScanTime ? new Date(status.lastScanTime) : null;

  return (
    <>
      <h1 className={H1}>Scanner status</h1>
      <p className="mb-7 text-muted">
        Health overview of the community lead scanner pipeline.
      </p>

      <div className="mb-5 grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatCard label="total leads" value={status.totalLeads} center />
        <StatCard label="last 24h" value={status.last24h} center />
        <StatCard label="last 7 days" value={status.last7d} center />
        <StatCard label="last 30 days" value={status.last30d} center />
      </div>

      <div className="grid grid-cols-1 items-start gap-5 md:grid-cols-2">
        <Card>
          <CardTitle
            aside={
              <span className="text-xs text-faint">
                {lastScan ? formatTimeAgo(lastScan) : "never"}
              </span>
            }
          >
            Leads by platform
          </CardTitle>
          {platforms.length === 0 ? (
            <p className="text-sm text-muted">No data yet.</p>
          ) : (
            <>
              <TableHead cols={PLATFORM_COLS}>
                <span>Platform</span>
                <span className="text-right">Leads</span>
              </TableHead>
              {platforms.map(([name, count]) => (
                <TableRow key={name} cols={PLATFORM_COLS}>
                  <span>{name}</span>
                  <span className={`text-right font-mono ${NUM}`}>{count}</span>
                </TableRow>
              ))}
            </>
          )}
        </Card>

        <Card>
          <CardTitle aside={<Chip tone="warn" size="xs">sample data</Chip>}>Pipeline health</CardTitle>
          <p className="mb-3 text-[13px] text-muted">
            Illustrative rows: the pipeline-health endpoint is not built yet, so
            these are not live readings.
          </p>
          <div className="flex flex-col gap-2">
            {HEALTH.map((h) => (
              <div
                key={h.name}
                className="flex flex-wrap items-center gap-x-2.5 gap-y-1 rounded-md bg-bg px-3 py-2.5 text-[13px]"
              >
                <Dot tone={HEALTH_TONE[h.state]} />
                <span>{h.name}</span>
                <span className={`ml-auto text-xs text-muted ${NUM}`}>
                  {h.detail}
                </span>
              </div>
            ))}
          </div>
          <div className="mt-3.5 border-t border-border pt-3 text-xs leading-relaxed text-faint">
            Classifier runs on every scraped post. Low-confidence items are held
            for manual review rather than surfaced as leads.
          </div>
        </Card>
      </div>
    </>
  );
}
