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
  TableScroll,
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

function byline(l: Lead): string {
  const parts = [];
  if (l.authorName) parts.push(`by ${l.authorName}`);
  if (l.postedAt) parts.push(new Date(l.postedAt).toLocaleDateString());
  return parts.join(" · ");
}

/** Expanded post body plus the two ways to reach the original. */
function LeadBody({ lead }: { lead: Lead }) {
  return (
    <div className="mt-2 rounded-lg border border-border bg-bg p-3">
      <p className="mb-2 whitespace-pre-wrap text-xs leading-relaxed text-muted">
        {lead.body || "(no body)"}
      </p>
      <div className="flex flex-wrap gap-3 text-[11px]">
        <a
          href={lead.sourceUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-accent hover:underline"
        >
          Open original
        </a>
        <a
          href={`https://web.archive.org/web/${lead.sourceUrl}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-muted hover:text-text"
        >
          Web Archive fallback
        </a>
      </div>
    </div>
  );
}

function LeadActions({
  lead,
  busy,
  onStatus,
}: {
  lead: Lead;
  busy: boolean;
  onStatus: (status: string) => void;
}) {
  return (
    <div className="flex gap-1.5">
      <button
        className="cursor-pointer rounded-md border-0 bg-info/20 px-2.5 py-1 text-xs text-info hover:bg-info/30 disabled:cursor-default disabled:opacity-35"
        disabled={busy || lead.status === "contacted"}
        onClick={() => onStatus("contacted")}
      >
        Contact
      </button>
      <button
        className="cursor-pointer rounded-md border-0 bg-border px-2.5 py-1 text-xs text-muted hover:text-text disabled:cursor-default disabled:opacity-35"
        disabled={busy || lead.status === "dismissed"}
        onClick={() => onStatus("dismissed")}
      >
        Dismiss
      </button>
    </div>
  );
}

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

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

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

      <div className="mb-5 grid grid-cols-3 gap-3 sm:gap-4">
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
        <div className="mb-4 flex flex-wrap items-center gap-1.5">
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
          <span className="w-full text-[13px] text-muted sm:ml-auto sm:w-auto">
            {leads.length} of {summary.total ?? leads.length} leads &middot; last{" "}
            {DAYS} days
          </span>
        </div>

        {leads.length === 0 ? (
          <p className="text-sm text-muted">No leads found for this filter.</p>
        ) : (
          <>
            {/* Phones: one stacked card per lead. The six-column grid below
                needs ~760px and is unreadable at phone widths. */}
            <div className="flex flex-col gap-2.5 md:hidden">
              {leads.map((l) => (
                <div
                  key={l.id}
                  className="rounded-lg border border-border bg-bg p-3"
                >
                  <div className="mb-2 flex flex-wrap items-center gap-1.5">
                    <Chip tone={CLASS_TONE[l.classification] ?? "muted"} size="xs">
                      {CLASS_LABEL[l.classification] ?? l.classification}
                    </Chip>
                    <Chip tone={STATUS_TONE[l.status] ?? "accent"} size="xs">
                      {l.status}
                    </Chip>
                    <span className={`ml-auto text-[11px] text-faint ${NUM}`}>
                      {l.engagementScore ?? 0}
                    </span>
                  </div>
                  <button
                    className="block w-full cursor-pointer border-0 bg-transparent p-0 text-left text-sm text-accent"
                    onClick={() => toggle(l.id)}
                  >
                    {l.title}
                  </button>
                  <div className="mt-1 text-[11px] text-faint">
                    {l.community?.name ?? l.platform}
                    {byline(l) ? ` · ${byline(l)}` : ""}
                  </div>
                  {expanded.has(l.id) && <LeadBody lead={l} />}
                  <div className="mt-2.5">
                    <LeadActions
                      lead={l}
                      busy={updating === l.id}
                      onStatus={(s) => updateStatus(l.id, s)}
                    />
                  </div>
                </div>
              ))}
            </div>

            <div className="hidden md:block">
              <TableScroll min="min-w-[760px]">
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
                        onClick={() => toggle(l.id)}
                      >
                        {l.title}
                      </button>
                      <div className="text-[11px] text-faint">{byline(l)}</div>
                      {expanded.has(l.id) && <LeadBody lead={l} />}
                    </div>
                    <span className={`text-muted ${NUM}`}>
                      {l.engagementScore ?? 0}
                    </span>
                    <LeadActions
                      lead={l}
                      busy={updating === l.id}
                      onStatus={(s) => updateStatus(l.id, s)}
                    />
                  </TableRow>
                ))}
              </TableScroll>
            </div>
          </>
        )}
      </Card>
    </>
  );
}
