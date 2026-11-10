"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  PROVIDER_LABELS,
  type AssessmentSummary,
  type ProviderConnectionSummary,
} from "@infralift/shared";
import { api, formatCents, savingsNote } from "../lib/api";
import { Dot, NUM } from "./ui";

// "From existing infrastructure": assess a connected account, then pick a
// target on the assessment's options page, which opens the project. Lives in
// the Projects drawer; Connections links here with ?assess=<connectionId>.

/** Log lines revealed while an assessment runs. The API reports status only, so
 *  these are staged locally against elapsed progress: the point is to show the
 *  user what the connector is doing, not to mirror server events 1:1. */
const SCAN_LINES = [
  "connecting provider api · verifying token scope",
  "enumerating projects, services and databases",
  "reading usage: transfer, requests, invocations",
  "applying published pricing and overage rates",
  "scoring candidate targets",
  "report ready",
];

const POLL_MS = 2000;

export function AssessPanel({ highlight }: { highlight?: string | null }) {
  const [assessments, setAssessments] = useState<AssessmentSummary[]>([]);
  const [connections, setConnections] = useState<ProviderConnectionSummary[]>([]);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      const [a, c] = await Promise.all([
        api<AssessmentSummary[]>("/assessments"),
        api<ProviderConnectionSummary[]>("/connections"),
      ]);
      setAssessments(a);
      setConnections(c);
      setError(null);
      return a;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return [];
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Poll while one is running; creep the bar so the log advances.
  useEffect(() => {
    if (!runningId) return;
    timer.current = setInterval(async () => {
      setProgress((p) => Math.min(94, p + 6));
      const fresh = await load();
      const mine = fresh.find((a) => a.id === runningId);
      if (mine && mine.status !== "running" && mine.status !== "pending") {
        setProgress(100);
        setRunningId(null);
      }
    }, POLL_MS);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [runningId, load]);

  async function run(connectionId: string) {
    setProgress(6);
    setError(null);
    try {
      const created = await api<AssessmentSummary>("/assessments/run", {
        method: "POST",
        body: JSON.stringify({ connectionId }),
      });
      setRunningId(created.id);
      await load();
    } catch (e) {
      setProgress(0);
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const step = Math.min(SCAN_LINES.length - 1, Math.floor(progress / 18));
  const completed = assessments.filter((a) => a.status === "completed");
  const valid = connections.filter((c) => c.status === "valid" && c.provider !== "github");

  return (
    <div>
      <p className="text-sm text-muted mb-4">
        Read-only. infralift inventories what the account runs and what it costs, then ranks
        where it could run instead. Picking a target opens a pull request with the code for it.
      </p>
      {error && <div className="mb-3 text-sm text-danger">{error}</div>}

      {valid.length === 0 ? (
        <p className="text-sm text-muted">
          No connected accounts yet. <a href="/connections">Connect one</a> first.
        </p>
      ) : (
        valid.map((c) => (
          <div
            key={c.id}
            className={`flex items-center gap-3 border-b border-border py-3 ${highlight === c.id ? "bg-accent-dim/20 -mx-2 px-2 rounded" : ""}`}
          >
            <Dot tone="accent" />
            <div className="min-w-0">
              <div className="text-[14px] font-medium">{PROVIDER_LABELS[c.provider]}</div>
              <div className="text-[12px] text-muted">{c.label}</div>
            </div>
            <div className="ml-auto">
              {runningId ? (
                <span className="text-[13px] text-muted">assessing&hellip;</span>
              ) : (
                <button
                  onClick={() => run(c.id)}
                  className="cursor-pointer rounded-md border-0 bg-accent px-3 py-1.5 text-[13px] font-semibold text-bg hover:bg-accent/90"
                >
                  {completed.some((a) => a.provider === c.provider) ? "Assess again" : "Assess"}
                </button>
              )}
            </div>
          </div>
        ))
      )}

      {runningId && (
        <div className="mt-4">
          <div className="mb-3 h-1 overflow-hidden rounded-full bg-bg">
            <div className="h-full bg-accent" style={{ width: `${progress}%` }} />
          </div>
          <div className="font-mono text-xs leading-[1.8] text-muted">
            {SCAN_LINES.slice(0, step + 1).map((line, i) => (
              <div key={line} className={i === step ? "text-muted" : "text-accent"}>
                {i === step ? "· " : "✓ "}
                {line}
              </div>
            ))}
          </div>
        </div>
      )}

      {completed.length > 0 && (
        <div className="mt-5">
          <div className="text-[13px] font-semibold text-muted mb-2">Assessed</div>
          {completed.map((a) => (
            <div key={a.id} className="mb-2 rounded-lg border border-border bg-bg p-3">
              <div className="text-[14px] font-semibold">{PROVIDER_LABELS[a.provider]}</div>
              <div className={`text-[12px] text-muted ${NUM}`}>
                {a.resourceCount} resources &middot; {formatCents(a.estimatedMonthlyCostCents)}/mo now
                &middot; {savingsNote(a)}
              </div>
              <div className="mt-2 flex gap-3 text-[13px] font-semibold">
                <a href={`/assessments/${a.id}/options`} className="text-accent">
                  Choose a target
                </a>
                <a href={`/assessments/${a.id}`} className="text-muted">
                  Full report
                </a>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
