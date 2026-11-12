"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  PROVIDER_LABELS,
  type AssessmentSummary,
  type ProviderConnectionSummary,
} from "@infralift/shared";
import { api, formatCents, savingsNote, errorText } from "../lib/api";
import { connectionName, isCloudAccount } from "../lib/connections";
import { Dot, NUM, SMALL_BTN_SOLID, Skeleton } from "./ui";

// "Adopt from an account" on /projects/new: assess a connected cloud account,
// then adopt what it found from the assessment's report (AdoptCard there).
// Connections links here with ?assess=<connectionId>. The codegen "choose a
// target" path is no longer offered from here (ADR 0010); the report and
// options pages still have it for existing assessments.

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
  const [loaded, setLoaded] = useState(false);
  // True from the click until POST /assessments/run answers. The run is
  // synchronous, so runningId stays null for its whole duration and used to
  // leave the Assess buttons live: a second tap started a second run. The ref
  // is read on the click itself, before React re-renders the disabled button.
  const [submitting, setSubmitting] = useState(false);
  const inFlight = useRef(false);
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
      setLoaded(true);
      return a;
    } catch (e) {
      setError(errorText(e));
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
    if (inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
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
      setError(errorText(e));
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  const step = Math.min(SCAN_LINES.length - 1, Math.floor(progress / 18));
  const completed = assessments.filter((a) => a.status === "completed");
  // Cloud accounts only: a repository host or a Terraform Cloud organization
  // has nothing to assess (ADR 0010, one project per account).
  const valid = connections.filter((c) => c.status === "valid" && isCloudAccount(c.provider));

  return (
    <div>
      <p className="text-sm text-muted mb-4">
        Read-only. infralift inventories what the account runs and what it costs. When the
        assessment finishes, adopt what it found from its report: a pull request with import
        blocks, held to a plan that changes nothing.
      </p>
      {error && <div className="mb-3 text-sm text-danger">{error}</div>}

      {!loaded && !error ? (
        <div role="status" aria-label="Loading connected accounts">
          <Skeleton className="h-12 w-full mb-2" />
          <Skeleton className="h-12 w-full" />
        </div>
      ) : valid.length === 0 ? (
        <p className="text-sm text-muted">
          No connected cloud accounts yet. <a href="/connections/new">Connect one</a> first.
        </p>
      ) : (
        valid.map((c) => (
          <div
            key={c.id}
            className={`flex items-center gap-3 border-b border-border py-3 ${highlight === c.id ? "bg-bg -mx-2 px-2 rounded" : ""}`}
          >
            <Dot tone="ok" />
            <div className="min-w-0">
              <div className="text-[14px] font-medium">{connectionName(c.provider)}</div>
              <div className="text-[12px] text-muted">{c.label}</div>
            </div>
            <div className="ml-auto">
              {runningId || submitting ? (
                <span role="status" className="text-[13px] text-muted">assessing&hellip;</span>
              ) : (
                <button
                  type="button"
                  onClick={() => void run(c.id)}
                  disabled={submitting}
                  className={SMALL_BTN_SOLID}
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
            <div className="h-full bg-muted" style={{ width: `${progress}%` }} />
          </div>
          <div className="font-mono text-xs leading-[1.8] text-muted">
            {SCAN_LINES.slice(0, step + 1).map((line, i) => (
              <div key={line} className={i === step ? "text-text" : "text-muted"}>
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
                <a href={`/assessments/${a.id}#adopt`} className="text-text underline">
                  Adopt resources
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
