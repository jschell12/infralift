"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AssessmentSummary, ProviderConnectionSummary } from "@infralift/shared";
import { api, formatCents, savingsNote, errorText } from "../lib/api";
import { findUnmanagedHref, latestCompletedAssessment, primaryFindAccount } from "../lib/adopt";
import { isCloudAccount, replaceHref } from "../lib/connections";
import { checkingText, useConnectionChecks } from "../lib/connection-checks";
import { CONNECTION_GRID, ConnectionTile } from "./connection-tile";
import { CARD, NUM, SMALL_BTN, SMALL_BTN_SOLID, SMALL_BTN_STRONG, Skeleton } from "./ui";

// "Adopt from an account" on /projects/new: one tile per connected cloud
// account. The primary action on a valid account is "Find unmanaged
// resources", which goes to that account's own page (/projects/new/adopt,
// ADR 0011's unmanaged view) to pick resources and adopt them. Assessing an
// account (cost and savings) and its full report stay as secondary actions;
// the report still has its own adopt card. ?assess=<connectionId> makes that
// account's "Find" the primary action. The codegen "choose a target" path is
// no longer offered from here (ADR 0010).

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
  // The account being assessed, so its tile shows the progress.
  const [runningConnection, setRunningConnection] = useState<string | null>(null);
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

  // Unverified or day-old accounts are checked when this list shows them, so
  // an account nothing is known to be wrong with is not sent to be fixed.
  const checking = useConnectionChecks(loaded ? connections : null, load);

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
        setRunningConnection(null);
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
    setRunningConnection(connectionId);
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
      setRunningConnection(null);
      setError(errorText(e));
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  const step = Math.min(SCAN_LINES.length - 1, Math.floor(progress / 18));
  // Cloud accounts only: a repository host or a Terraform Cloud organization
  // has nothing to assess (ADR 0010, one project per account). Accounts whose
  // connection is not valid are shown too, so it is clear why they cannot be
  // assessed, with a way to fix them.
  const accounts = connections.filter((c) => isCloudAccount(c.provider));
  const primary = primaryFindAccount(accounts, highlight ?? null);
  const busy = runningId !== null || submitting;

  return (
    <div>
      <p className="text-sm text-muted mb-4 max-w-[640px]">
        Pick an account to see what it runs that no infralift project manages yet, then adopt
        what you choose: a pull request with import blocks, held to a plan that changes nothing.
        Reading the account changes nothing in it. Assess an account instead for what it costs.
      </p>
      <p role="status" className="mb-2 min-h-5 text-sm text-faint">
        {checkingText(checking)}
      </p>
      {error && (
        <div role="alert" className="mb-3 text-sm text-danger">
          {error}
        </div>
      )}

      {!loaded && !error ? (
        <ul role="status" aria-label="Loading connected accounts" className={CONNECTION_GRID}>
          {[0, 1].map((i) => (
            <li key={i} className={`${CARD} p-5`}>
              <Skeleton className="h-4 w-1/2 mb-3" />
              <Skeleton className="h-3 w-2/3 mb-5" />
              <Skeleton className="h-11 w-full" />
            </li>
          ))}
        </ul>
      ) : loaded && accounts.length === 0 ? (
        <div className={CARD}>
          <p className="text-sm text-muted mb-3">
            No connected cloud accounts yet. Connect one, such as AWS or Cloudflare, and it shows up
            here to adopt from.
          </p>
          <a className={SMALL_BTN_STRONG} href="/connections/new">
            Connect a cloud account
          </a>
        </div>
      ) : (
        <ul aria-label="Cloud accounts" className={CONNECTION_GRID}>
          {accounts.map((c) => {
            const latest = latestCompletedAssessment(assessments, c.id);
            const running = runningConnection === c.id;
            return (
              <ConnectionTile
                key={c.id}
                c={c}
                actions={
                  c.status === "invalid" ? (
                    <a className={SMALL_BTN} href={replaceHref(c.id)}>
                      Fix on Connections
                    </a>
                  ) : c.status !== "valid" ? (
                    // Unverified: checked when this page loads (above); the
                    // tile's own line says "Checking..." meanwhile.
                    c.checking ? null : (
                      <a className={SMALL_BTN} href="/connections">
                        Verify on Connections
                      </a>
                    )
                  ) : running ? null : (
                    <div className="flex flex-wrap gap-2">
                      <a
                        className={primary === c.id ? SMALL_BTN_SOLID : SMALL_BTN_STRONG}
                        href={findUnmanagedHref(c.id)}
                      >
                        Find unmanaged resources
                      </a>
                      {latest && (
                        <a className={SMALL_BTN} href={`/assessments/${latest.id}`}>
                          Full report
                        </a>
                      )}
                      <button type="button" onClick={() => void run(c.id)} disabled={busy} className={SMALL_BTN}>
                        {latest ? "Assess again" : "Assess"}
                      </button>
                    </div>
                  )
                }
              >
                {latest && !running && (
                  <div className={`mt-3 border-t border-border pt-3 text-xs text-muted ${NUM}`}>
                    {latest.resourceCount} resources &middot; {formatCents(latest.estimatedMonthlyCostCents)}/mo now
                    &middot; {savingsNote(latest)}
                  </div>
                )}
                {running && (
                  <div role="status" className="mt-3 border-t border-border pt-3">
                    <div className="mb-3 h-1 overflow-hidden rounded-full bg-bg">
                      <div className="h-full bg-muted" style={{ width: `${progress}%` }} />
                    </div>
                    <div className="font-mono text-xs leading-[1.8] text-muted">
                      {SCAN_LINES.slice(0, step + 1).map((line, i) => (
                        <div key={line} className={i === step ? "text-text" : "text-muted"}>
                          {i === step ? "\u00b7 " : "\u2713 "}
                          {line}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </ConnectionTile>
            );
          })}
        </ul>
      )}
    </div>
  );
}
