"use client";

import { useEffect, useState } from "react";
import { api } from "../../lib/api";

interface ScannerStatus {
  totalLeads: number;
  byPlatform: Record<string, number>;
  last24h: number;
  last7d: number;
  last30d: number;
  lastScanTime: string | null;
}

export default function ScannerPage() {
  const [status, setStatus] = useState<ScannerStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<ScannerStatus>("/leads/scanner-status")
      .then(setStatus)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  if (error) {
    return (
      <>
        <h1 className="text-3xl font-bold tracking-tight mb-2">Scanner status</h1>
        <div className="text-danger text-sm mt-4">{error}</div>
      </>
    );
  }

  if (!status) {
    return (
      <>
        <h1 className="text-3xl font-bold tracking-tight mb-2">Scanner status</h1>
        <p className="text-muted text-sm mt-4">Loading...</p>
      </>
    );
  }

  const platforms = Object.entries(status.byPlatform).sort(
    ([, a], [, b]) => b - a
  );

  const lastScan = status.lastScanTime
    ? new Date(status.lastScanTime)
    : null;
  const lastScanAgo = lastScan
    ? formatTimeAgo(lastScan)
    : "never";

  return (
    <>
      <h1 className="text-3xl font-bold tracking-tight mb-2">Scanner status</h1>
      <p className="text-muted mb-8">
        Health overview of the community lead scanner pipeline.
      </p>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-5 mb-8">
        <div className="bg-surface border border-border rounded-xl p-6 text-center">
          <div className="text-4xl font-bold text-accent tracking-tight mb-1">
            {status.totalLeads}
          </div>
          <p className="text-muted text-sm">total leads</p>
        </div>
        <div className="bg-surface border border-border rounded-xl p-6 text-center">
          <div className="text-4xl font-bold text-accent tracking-tight mb-1">
            {status.last24h}
          </div>
          <p className="text-muted text-sm">last 24h</p>
        </div>
        <div className="bg-surface border border-border rounded-xl p-6 text-center">
          <div className="text-4xl font-bold text-accent tracking-tight mb-1">
            {status.last7d}
          </div>
          <p className="text-muted text-sm">last 7 days</p>
        </div>
        <div className="bg-surface border border-border rounded-xl p-6 text-center">
          <div className="text-4xl font-bold text-accent tracking-tight mb-1">
            {status.last30d}
          </div>
          <p className="text-muted text-sm">last 30 days</p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        <div className="bg-surface border border-border rounded-xl p-6">
          <h2 className="text-lg font-semibold mb-4">Leads by platform</h2>
          {platforms.length === 0 ? (
            <p className="text-muted text-sm">No data yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr>
                  <th className="text-left p-2 border-b border-border text-muted font-medium text-xs">
                    Platform
                  </th>
                  <th className="text-right p-2 border-b border-border text-muted font-medium text-xs">
                    Leads
                  </th>
                </tr>
              </thead>
              <tbody>
                {platforms.map(([name, count]) => (
                  <tr key={name}>
                    <td className="p-2 border-b border-border">{name}</td>
                    <td className="p-2 border-b border-border text-right font-mono">
                      {count}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="bg-surface border border-border rounded-xl p-6">
          <h2 className="text-lg font-semibold mb-4">Last scan</h2>
          <div className="text-2xl font-bold text-accent mb-1">
            {lastScanAgo}
          </div>
          {lastScan && (
            <p className="text-muted text-sm">
              {lastScan.toLocaleString()}
            </p>
          )}
        </div>
      </div>
    </>
  );
}

function formatTimeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
