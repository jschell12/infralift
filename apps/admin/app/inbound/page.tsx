"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/api";

// Inbound leads: people who filled in the form on the marketing site. Kept on
// its own page rather than merged into /leads, because a scraped forum post
// and a person who typed their email have almost no fields in common and
// mixing them makes every count on either page ambiguous.

interface InboundLead {
  id: string;
  email: string;
  name: string | null;
  company: string | null;
  provider: string | null;
  monthlySpend: string | null;
  message: string | null;
  status: string;
  notes: string | null;
  sourcePath: string | null;
  referrer: string | null;
  utmSource: string | null;
  utmCampaign: string | null;
  country: string | null;
  createdAt: string;
}

interface Payload {
  leads: InboundLead[];
  total: number;
  byStatus: Record<string, number>;
}

const STATUSES = ["new", "contacted", "qualified", "dismissed", "converted"];

const STATUS_CLS: Record<string, string> = {
  new: "bg-accent-dim text-accent",
  contacted: "bg-warn-dim text-warn",
  qualified: "bg-accent-dim text-accent",
  dismissed: "bg-surface text-faint",
  converted: "bg-accent-dim text-accent",
};

export default function InboundLeadsPage() {
  const [data, setData] = useState<Payload | null>(null);
  const [filter, setFilter] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    const q = filter ? `?status=${filter}` : "";
    api<Payload>(`/leads/inbound${q}`)
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [filter]);

  useEffect(load, [load]);

  async function setStatus(id: string, status: string) {
    // Optimistic: the list is small and a failed PATCH re-loads the truth.
    setData((d) =>
      d
        ? { ...d, leads: d.leads.map((l) => (l.id === id ? { ...l, status } : l)) }
        : d
    );
    try {
      await api(`/leads/inbound/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      load();
    }
  }

  if (error) return <div className="mt-2 text-sm text-danger">{error}</div>;
  if (!data) return <p className="text-muted">Loading inbound leads...</p>;

  return (
    <>
      <h1 className="mb-1.5 text-[26px] font-bold tracking-[-0.02em]">
        Inbound leads
      </h1>
      <p className="mb-6 max-w-[640px] text-muted">
        People who asked for an assessment through the marketing site. These
        arrive with an email address and no account, so they are worth a reply
        the same day.
      </p>

      <div className="mb-5 flex flex-wrap gap-2">
        <button
          onClick={() => setFilter("")}
          className={`rounded-full px-3.5 py-1.5 text-[13px] font-semibold ${filter === "" ? "bg-accent text-bg" : "border border-border text-muted"}`}
        >
          All
        </button>
        {STATUSES.map((s) => (
          <button
            key={s}
            onClick={() => setFilter(s)}
            className={`rounded-full px-3.5 py-1.5 text-[13px] font-semibold ${filter === s ? "bg-accent text-bg" : "border border-border text-muted"}`}
          >
            {s} {data.byStatus[s] ? `(${data.byStatus[s]})` : ""}
          </button>
        ))}
      </div>

      {data.leads.length === 0 ? (
        <div className="rounded-lg border border-border bg-bg p-4 text-[13px] text-muted">
          Nothing here yet.
        </div>
      ) : (
        <div className="grid gap-3">
          {data.leads.map((l) => (
            <div
              key={l.id}
              className="rounded-xl border border-border bg-surface p-5"
            >
              <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <a
                  href={`mailto:${l.email}`}
                  className="text-[15px] font-semibold"
                >
                  {l.email}
                </a>
                {l.name && <span className="text-[13px] text-muted">{l.name}</span>}
                <span
                  className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${STATUS_CLS[l.status] ?? "bg-surface text-faint"}`}
                >
                  {l.status}
                </span>
                <span className="ml-auto text-xs text-faint">
                  {new Date(l.createdAt).toLocaleString()}
                </span>
              </div>

              <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-muted">
                {l.company && <span>{l.company}</span>}
                {l.provider && <span>on {l.provider}</span>}
                {l.monthlySpend && <span>{l.monthlySpend}</span>}
                {l.country && <span>{l.country}</span>}
              </div>

              {l.message && (
                <p className="mb-3 whitespace-pre-wrap text-[13px] leading-relaxed text-text">
                  {l.message}
                </p>
              )}

              <div className="mb-3 flex flex-wrap gap-x-4 text-xs text-faint">
                {l.sourcePath && <span>from {l.sourcePath}</span>}
                {l.utmSource && <span>utm: {l.utmSource}</span>}
                {l.utmCampaign && <span>campaign: {l.utmCampaign}</span>}
                {l.referrer && <span>ref: {l.referrer}</span>}
              </div>

              <div className="flex flex-wrap gap-2">
                {STATUSES.filter((s) => s !== l.status).map((s) => (
                  <button
                    key={s}
                    onClick={() => setStatus(l.id, s)}
                    className="rounded-lg border border-border px-3 py-1.5 text-[13px] text-muted hover:text-text"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
