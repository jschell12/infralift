"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/api";
import {
  Card,
  Chip,
  FilterPill,
  H1,
  NUM,
  StatCard,
  TableHead,
  TableRow,
  type Tone,
} from "../../components/ui";

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
  providers: string[];
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

const CLASS_TONE: Record<string, Tone> = {
  billing_pain: "danger",
  migration_interest: "warn",
  platform_complaint: "muted",
};

const CLASS_LABEL: Record<string, string> = {
  billing_pain: "billing pain",
  migration_interest: "migration interest",
  platform_complaint: "platform complaint",
};

const STATUS_TONE: Record<string, Tone> = {
  new: "accent",
  contacted: "info",
  dismissed: "faint",
  converted: "accent",
};

const FILTERS: { label: string; value: string }[] = [
  { label: "All", value: "" },
  { label: "Billing pain", value: "billing_pain" },
  { label: "Migration interest", value: "migration_interest" },
  { label: "Platform complaint", value: "platform_complaint" },
];

const COLS = "grid-cols-[140px_100px_110px_1fr_80px_150px]";
const DAYS = 30;

export default function LeadsPage() {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [summary, setSummary] = useState<Summary>({});
  const [classification, setClassification] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [updating, setUpdating] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (classification) params.set("classification", classification);
      params.set("days", String(DAYS));
      params.set("limit", "200");

      const [leadsData, summaryData] = await Promise.all([
        api<Lead[]>(`/leads?${params}`),
        api<Summary>(`/leads/summary?days=${DAYS}`),
      ]);
      setLeads(leadsData);
      setSummary(summaryData);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [classification]);

  useEffect(() => {
    void load();
  }, [load]);

  async function updateStatus(id: string, newStatus: string) {
    setUpdating(id);
    // optimistic: the chip flips immediately, reverts if the PATCH fails
    const before = leads;
    setLeads((prev) =>
      prev.map((l) => (l.id === id ? { ...l, status: newStatus } : l))
    );
    try {
      const updated = await api<Lead>(`/leads/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: newStatus }),
      });
      setLeads((prev) => prev.map((l) => (l.id === id ? { ...l, ...updated } : l)));
      setSummary(await api<Summary>(`/leads/summary?days=${DAYS}`));
    } catch (e) {
      setLeads(before);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setUpdating(null);
    }
  }

  return (
    <>
      <h1 className={H1}>Community leads</h1>
      <p className="mb-6 max-w-[660px] text-muted">
        Posts from developer communities classified as billing pain, migration
        interest, or platform complaints. Updated every 4 hours.
      </p>

      {error && <div className="mb-4 text-sm text-danger">{error}</div>}

      <div className="mb-5 grid grid-cols-1 gap-4 md:grid-cols-3">
        <StatCard label="billing pain" value={summary.billing_pain ?? 0} center />
        <StatCard
          label="migration interest"
          value={summary.migration_interest ?? 0}
          center
        />
        <StatCard
          label="platform complaints"
          value={summary.platform_complaint ?? 0}
          center
        />
      </div>

      <Card>
        <div className="mb-4 flex items-center gap-1.5">
          <span className="mr-1 text-[11px] uppercase tracking-[0.06em] text-faint">
            Classification
          </span>
          {FILTERS.map((f) => (
            <FilterPill
              key={f.value}
              active={classification === f.value}
              onClick={() => setClassification(f.value)}
            >
              {f.label}
            </FilterPill>
          ))}
          <span className="ml-auto text-[13px] text-muted">
            {leads.length} of {summary.total ?? leads.length} leads &middot; last{" "}
            {DAYS} days
          </span>
        </div>

        {leads.length === 0 ? (
          <p className="text-sm text-muted">No leads found for this filter.</p>
        ) : (
          <>
            <TableHead cols={COLS}>
              <span>Classification</span>
              <span>Status</span>
              <span>Source</span>
              <span>Title</span>
              <span>Score</span>
              <span>Actions</span>
            </TableHead>
            {leads.map((l) => (
              <TableRow key={l.id} cols={COLS}>
                <Chip tone={CLASS_TONE[l.classification] ?? "muted"} size="xs">
                  {CLASS_LABEL[l.classification] ?? l.classification}
                </Chip>
                <Chip tone={STATUS_TONE[l.status] ?? "accent"} size="xs">
                  {l.status}
                </Chip>
                <span className="text-xs text-muted">
                  {l.community?.name ?? l.platform}
                </span>
                <div className="min-w-0">
                  <button
                    className="block w-full cursor-pointer truncate border-0 bg-transparent p-0 text-left text-accent hover:underline"
                    onClick={() =>
                      setExpanded((prev) => {
                        const next = new Set(prev);
                        next.has(l.id) ? next.delete(l.id) : next.add(l.id);
                        return next;
                      })
                    }
                  >
                    {l.title}
                  </button>
                  <div className="text-[11px] text-faint">
                    {l.authorName ? `by ${l.authorName}` : ""}
                    {l.postedAt
                      ? ` \u00b7 ${new Date(l.postedAt).toLocaleDateString()}`
                      : ""}
                  </div>
                  {expanded.has(l.id) && (
                    <div className="mt-2 rounded-lg border border-border bg-bg p-3">
                      <p className="mb-2 whitespace-pre-wrap text-xs text-muted leading-relaxed">
                        {l.body || "(no body)"}
                      </p>
                      <div className="flex gap-3 text-[11px]">
                        <a
                          href={l.sourceUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-accent hover:underline"
                        >
                          Open original
                        </a>
                        <a
                          href={`https://web.archive.org/web/${l.sourceUrl}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-muted hover:text-text"
                        >
                          Web Archive fallback
                        </a>
                      </div>
                    </div>
                  )}
                </div>
                <span className={`text-muted ${NUM}`}>
                  {l.engagementScore ?? 0}
                </span>
                <div className="flex gap-1.5">
                  <button
                    className="cursor-pointer rounded-md border-0 bg-info/20 px-2.5 py-1 text-xs text-info hover:bg-info/30 disabled:cursor-default disabled:opacity-35"
                    disabled={updating === l.id || l.status === "contacted"}
                    onClick={() => updateStatus(l.id, "contacted")}
                  >
                    Contact
                  </button>
                  <button
                    className="cursor-pointer rounded-md border-0 bg-border px-2.5 py-1 text-xs text-muted hover:text-text disabled:cursor-default disabled:opacity-35"
                    disabled={updating === l.id || l.status === "dismissed"}
                    onClick={() => updateStatus(l.id, "dismissed")}
                  >
                    Dismiss
                  </button>
                </div>
              </TableRow>
            ))}
          </>
        )}
      </Card>
    </>
  );
}
