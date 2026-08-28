"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  PROVIDER_LABELS,
  type AssessmentSummary,
  type ProviderConnectionSummary,
} from "@infralift/shared";
import { api, formatCents } from "../../lib/api";
import { Card, Dot, H1, NUM } from "../../components/ui";

/** Log lines revealed while an assessment runs. The API reports status only, so
 *  these are staged locally against elapsed progress — the point is to show the
 *  user what the connector is doing, not to mirror server events 1:1. */
const SCAN_LINES = [
  "connecting provider api · verifying token scope",
  "enumerating projects, services and databases",
  "reading usage: transfer, requests, invocations",
  "applying published pricing and overage rates",
  "scoring candidate targets",
  "report ready · quote generated",
];

const POLL_MS = 2000;

export default function AssessmentsPage() {
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

  // poll while anything is running; creep the bar so the log advances
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

  return (
    <>
      <h1 className={H1}>Assessments</h1>
      <p className="mb-7 max-w-[620px] text-muted">
        Free, read-only, and the report is yours to keep whether or not you hire
        us. Minutes for the inventory; cost modeling and the quote land the same
        day.
      </p>

      {error && <div className="mb-4 text-sm text-danger">{error}</div>}

      <Card>
        {connections.filter((c) => c.status === "valid").length === 0 ? (
          <p className="text-sm text-muted">
            No valid connections yet.{" "}
            <a href="/connections">Connect a provider</a> to run an assessment.
          </p>
        ) : (
          connections
            .filter((c) => c.status === "valid")
            .map((c) => {
              const done = completed.find((a) => a.provider === c.provider);
              return (
                <div
                  key={c.id}
                  className="flex items-center gap-3 border-b border-border py-3.5"
                >
                  <Dot tone="accent" />
                  <div className="min-w-0">
                    <div className="text-[15px] font-medium">
                      {PROVIDER_LABELS[c.provider]}
                    </div>
                    <div className="text-[13px] text-muted">
                      {c.label} &middot; credential {c.status}
                    </div>
                  </div>
                  <div className="ml-auto">
                    {runningId ? (
                      <span className="text-[13px] text-muted">
                        assessing&hellip;
                      </span>
                    ) : done ? (
                      <span className="text-[13px] text-accent">assessed</span>
                    ) : (
                      <button
                        onClick={() => run(c.id)}
                        className="cursor-pointer rounded-md border-0 bg-accent px-4 py-2 text-[13px] font-semibold text-bg hover:bg-accent/90"
                      >
                        Run assessment
                      </button>
                    )}
                  </div>
                </div>
              );
            })
        )}

        {runningId && (
          <div className="mt-5">
            <div className="mb-3.5 h-1 overflow-hidden rounded-full bg-bg">
              <div
                className="h-full bg-accent"
                style={{ width: `${progress}%` }}
              />
            </div>
            <div className="font-mono text-xs leading-[1.8] text-muted">
              {SCAN_LINES.slice(0, step + 1).map((line, i) => (
                <div
                  key={line}
                  className={i === step ? "text-muted" : "text-accent"}
                >
                  {i === step ? "\u00b7 " : "\u2713 "}
                  {line}
                </div>
              ))}
            </div>
          </div>
        )}

        {completed.map((a) => (
          <a
            key={a.id}
            href={`/assessments/${a.id}`}
            className="mt-5 flex items-center gap-3.5 rounded-lg border border-border bg-bg p-4 hover:border-accent"
          >
            <div>
              <div className="mb-0.5 text-[15px] font-semibold capitalize">
                {a.provider} assessment &middot; {a.status}
              </div>
              <div className={`text-[13px] text-muted ${NUM}`}>
                {a.resourceCount} resources &middot;{" "}
                {formatCents(a.estimatedMonthlyCostCents)}/mo current &middot;{" "}
                {formatCents(a.estimatedMonthlySavingsCents)}/mo identified
                savings
              </div>
            </div>
            <span className="ml-auto text-sm font-medium text-accent">
              Open report &rarr;
            </span>
          </a>
        ))}
      </Card>
    </>
  );
}
