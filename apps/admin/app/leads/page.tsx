"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/api";

interface Lead {
  id: string;
  sourceUrl: string;
  sourceId: string;
  platform: string;
  title: string;
  body: string;
  authorName: string | null;
  classification: string;
  confidence: string;
  engagementScore: number | null;
  status: string;
  notes: string | null;
  postedAt: string | null;
  scrapedAt: string;
  community: { name: string; slug: string; platform: string };
}

interface Summary {
  billing_pain?: number;
  migration_interest?: number;
  platform_complaint?: number;
  total?: number;
  byStatus?: Record<string, number>;
}

const CLASS_BADGE: Record<string, string> = {
  billing_pain: "inline-block px-2.5 py-0.5 rounded-full text-xs font-semibold bg-danger/20 text-danger",
  migration_interest: "inline-block px-2.5 py-0.5 rounded-full text-xs font-semibold bg-warn/20 text-warn",
  platform_complaint: "inline-block px-2.5 py-0.5 rounded-full text-xs font-semibold bg-border text-muted",
};

const CLASS_LABEL: Record<string, string> = {
  billing_pain: "billing pain",
  migration_interest: "migration interest",
  platform_complaint: "platform complaint",
};

const STATUS_BADGE: Record<string, string> = {
  new: "inline-block px-2 py-0.5 rounded-full text-xs font-semibold bg-accent/20 text-accent",
  contacted: "inline-block px-2 py-0.5 rounded-full text-xs font-semibold bg-blue-500/20 text-blue-400",
  dismissed: "inline-block px-2 py-0.5 rounded-full text-xs font-semibold bg-border text-muted",
  converted: "inline-block px-2 py-0.5 rounded-full text-xs font-semibold bg-green-500/20 text-green-400",
};

export default function LeadsPage() {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [summary, setSummary] = useState<Summary>({});
  const [classification, setClassification] = useState("");
  const [platform, setPlatform] = useState("");
  const [status, setStatus] = useState("");
  const [days, setDays] = useState(30);
  const [error, setError] = useState<string | null>(null);
  const [updating, setUpdating] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (classification) params.set("classification", classification);
      if (platform) params.set("platform", platform);
      if (status) params.set("status", status);
      params.set("days", String(days));
      params.set("limit", "200");

      const [leadsData, summaryData] = await Promise.all([
        api<Lead[]>(`/leads?${params}`),
        api<Summary>(`/leads/summary?days=${days}`),
      ]);
      setLeads(leadsData);
      setSummary(summaryData);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [classification, platform, status, days]);

  useEffect(() => {
    void load();
  }, [load]);

  const updateStatus = async (id: string, newStatus: string) => {
    setUpdating(id);
    try {
      const updated = await api<Lead>(`/leads/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: newStatus }),
      });
      setLeads((prev) =>
        prev.map((l) => (l.id === id ? { ...l, ...updated } : l))
      );
      // Refresh summary counts
      const summaryData = await api<Summary>(`/leads/summary?days=${days}`);
      setSummary(summaryData);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setUpdating(null);
    }
  };

  return (
    <>
      <h1 className="text-3xl font-bold tracking-tight mb-2">Community leads</h1>
      <p className="text-muted mb-8">
        Posts from developer communities classified as billing pain, migration
        interest, or platform complaints. Updated every 4 hours.
      </p>

      {error && <div className="text-danger text-sm mt-2">{error}</div>}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
        <div className="bg-surface border border-border rounded-xl p-6 text-center">
          <div className="text-4xl font-bold text-accent tracking-tight mb-1">{summary.billing_pain ?? 0}</div>
          <p className="text-muted text-sm">billing pain</p>
        </div>
        <div className="bg-surface border border-border rounded-xl p-6 text-center">
          <div className="text-4xl font-bold text-accent tracking-tight mb-1">{summary.migration_interest ?? 0}</div>
          <p className="text-muted text-sm">migration interest</p>
        </div>
        <div className="bg-surface border border-border rounded-xl p-6 text-center">
          <div className="text-4xl font-bold text-accent tracking-tight mb-1">{summary.platform_complaint ?? 0}</div>
          <p className="text-muted text-sm">platform complaints</p>
        </div>
      </div>

      <div className="bg-surface border border-border rounded-xl p-6 mt-5">
        <div className="flex gap-3 flex-wrap mb-4">
          <div>
            <label className="block text-sm font-semibold text-muted mt-3.5 mb-1">Classification</label>
            <select
              className="w-full bg-bg border border-border rounded-lg px-3 py-2 text-text text-sm mb-4 focus:outline-none focus:border-accent"
              value={classification}
              onChange={(e) => setClassification(e.target.value)}
            >
              <option value="">All</option>
              <option value="billing_pain">Billing pain</option>
              <option value="migration_interest">Migration interest</option>
              <option value="platform_complaint">Platform complaint</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-semibold text-muted mt-3.5 mb-1">Platform</label>
            <select
              className="w-full bg-bg border border-border rounded-lg px-3 py-2 text-text text-sm mb-4 focus:outline-none focus:border-accent"
              value={platform}
              onChange={(e) => setPlatform(e.target.value)}
            >
              <option value="">All</option>
              <option value="hackernews">Hacker News</option>
              <option value="reddit">Reddit</option>
              <option value="dev-to">DEV.to</option>
              <option value="stackexchange">Stack Exchange</option>
              <option value="lobsters">Lobsters</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-semibold text-muted mt-3.5 mb-1">Status</label>
            <select
              className="w-full bg-bg border border-border rounded-lg px-3 py-2 text-text text-sm mb-4 focus:outline-none focus:border-accent"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
            >
              <option value="">All</option>
              <option value="new">New</option>
              <option value="contacted">Contacted</option>
              <option value="dismissed">Dismissed</option>
              <option value="converted">Converted</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-semibold text-muted mt-3.5 mb-1">Days</label>
            <select
              className="w-full bg-bg border border-border rounded-lg px-3 py-2 text-text text-sm mb-4 focus:outline-none focus:border-accent"
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
            >
              <option value="7">7 days</option>
              <option value="30">30 days</option>
              <option value="90">90 days</option>
              <option value="365">All time</option>
            </select>
          </div>
        </div>

        <p className="text-muted mb-3">
          {leads.length} leads ({summary.total ?? 0} total in {days} days)
        </p>

        {leads.length === 0 ? (
          <p className="text-muted text-sm">No leads found for this filter.</p>
        ) : (
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr>
                <th className="text-left p-3 border-b border-border text-muted font-medium text-xs">Classification</th>
                <th className="text-left p-3 border-b border-border text-muted font-medium text-xs">Status</th>
                <th className="text-left p-3 border-b border-border text-muted font-medium text-xs">Source</th>
                <th className="text-left p-3 border-b border-border text-muted font-medium text-xs">Title</th>
                <th className="text-left p-3 border-b border-border text-muted font-medium text-xs">Engagement</th>
                <th className="text-left p-3 border-b border-border text-muted font-medium text-xs">Date</th>
                <th className="text-left p-3 border-b border-border text-muted font-medium text-xs">Actions</th>
              </tr>
            </thead>
            <tbody>
              {leads.map((l) => (
                <tr key={l.id}>
                  <td className="p-3 border-b border-border">
                    <span className={CLASS_BADGE[l.classification] ?? "inline-block px-2.5 py-0.5 rounded-full text-xs font-semibold"}>
                      {CLASS_LABEL[l.classification] ?? l.classification}
                    </span>
                  </td>
                  <td className="p-3 border-b border-border">
                    <span className={STATUS_BADGE[l.status] ?? STATUS_BADGE.new}>
                      {l.status}
                    </span>
                  </td>
                  <td className="p-3 border-b border-border">{l.community?.name ?? l.platform}</td>
                  <td className="p-3 border-b border-border">
                    <a
                      href={l.sourceUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {l.title.length > 80
                        ? l.title.slice(0, 80) + "..."
                        : l.title}
                    </a>
                    {l.authorName && (
                      <span className="text-muted text-xs ml-2">
                        by {l.authorName}
                      </span>
                    )}
                  </td>
                  <td className="p-3 border-b border-border">{l.engagementScore ?? 0}</td>
                  <td className="p-3 border-b border-border">
                    {l.postedAt
                      ? new Date(l.postedAt).toLocaleDateString()
                      : ""}
                  </td>
                  <td className="p-3 border-b border-border">
                    <div className="flex gap-1.5">
                      {l.status !== "contacted" && (
                        <button
                          className="px-2.5 py-1 text-xs rounded-lg bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 disabled:opacity-50"
                          disabled={updating === l.id}
                          onClick={() => updateStatus(l.id, "contacted")}
                        >
                          Contact
                        </button>
                      )}
                      {l.status !== "dismissed" && (
                        <button
                          className="px-2.5 py-1 text-xs rounded-lg bg-border text-muted hover:bg-border/80 disabled:opacity-50"
                          disabled={updating === l.id}
                          onClick={() => updateStatus(l.id, "dismissed")}
                        >
                          Dismiss
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
