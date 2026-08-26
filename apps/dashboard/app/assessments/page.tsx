"use client";

import { useCallback, useEffect, useState } from "react";
import {
  PROVIDER_LABELS,
  type AssessmentSummary,
  type ProviderConnectionSummary,
} from "@infralift/shared";
import { api, DEV_ORG_ID, formatCents } from "../../lib/api";

export default function AssessmentsPage() {
  const [assessments, setAssessments] = useState<AssessmentSummary[]>([]);
  const [connections, setConnections] = useState<ProviderConnectionSummary[]>(
    []
  );
  const [connectionId, setConnectionId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [a, c] = await Promise.all([
        api<AssessmentSummary[]>(`/assessments?orgId=${DEV_ORG_ID}`),
        api<ProviderConnectionSummary[]>(
          `/connections?orgId=${DEV_ORG_ID}`
        ),
      ]);
      setAssessments(a);
      setConnections(c);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function run() {
    if (!connectionId) return;
    setBusy(true);
    setError(null);
    try {
      await api("/assessments/run", {
        method: "POST",
        body: JSON.stringify({ connectionId }),
      });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1 className="text-3xl font-bold tracking-tight mb-2">Assessments</h1>
      <p className="text-muted mb-8">
        Run a read-only assessment against a connected provider to inventory
        resources and project costs.
      </p>

      <div className="bg-surface border border-border rounded-xl p-6 mb-4">
        <h3 className="text-base font-semibold mb-1.5">Run a new assessment</h3>
        <label className="block text-sm font-semibold text-muted mt-3.5 mb-1">Connection</label>
        <select
          className="w-full bg-bg border border-border rounded-lg px-3 py-2 text-text text-sm mb-4 focus:outline-none focus:border-accent"
          value={connectionId}
          onChange={(e) => setConnectionId(e.target.value)}
        >
          <option value="">Select a connection...</option>
          {connections
            .filter((c) => c.status === "valid")
            .map((c) => (
              <option key={c.id} value={c.id}>
                {PROVIDER_LABELS[c.provider]}: {c.label}
              </option>
            ))}
        </select>
        <button
          className="inline-block mt-4 px-7 py-3 rounded-lg text-base font-semibold cursor-pointer border border-transparent bg-accent text-bg hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed"
          onClick={run}
          disabled={busy || !connectionId}
        >
          {busy ? "Running..." : "Run assessment"}
        </button>
        {error && <div className="text-danger text-sm mt-2">{error}</div>}
      </div>

      <div className="bg-surface border border-border rounded-xl p-6 mb-4">
        <h3 className="text-base font-semibold mb-1.5">History</h3>
        {assessments.length === 0 ? (
          <p className="text-muted text-sm">No assessments yet.</p>
        ) : (
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr>
                <th className="text-left p-3 border-b border-border text-muted font-medium text-xs">Provider</th>
                <th className="text-left p-3 border-b border-border text-muted font-medium text-xs">Status</th>
                <th className="text-left p-3 border-b border-border text-muted font-medium text-xs">Resources</th>
                <th className="text-left p-3 border-b border-border text-muted font-medium text-xs">Est. monthly cost</th>
                <th className="text-left p-3 border-b border-border text-muted font-medium text-xs">Est. savings</th>
                <th className="text-left p-3 border-b border-border text-muted font-medium text-xs">Report</th>
              </tr>
            </thead>
            <tbody>
              {assessments.map((a) => (
                <tr key={a.id}>
                  <td className="p-3 border-b border-border">{PROVIDER_LABELS[a.provider]}</td>
                  <td className="p-3 border-b border-border">
                    <span
                      className={
                        a.status === "completed"
                          ? "inline-block px-2.5 py-0.5 rounded-full text-xs font-semibold bg-accent-dim text-accent"
                          : a.status === "failed"
                            ? "inline-block px-2.5 py-0.5 rounded-full text-xs font-semibold bg-danger/20 text-danger"
                            : "inline-block px-2.5 py-0.5 rounded-full text-xs font-semibold bg-warn/20 text-warn"
                      }
                    >
                      {a.status}
                    </span>
                  </td>
                  <td className="p-3 border-b border-border">{a.resourceCount}</td>
                  <td className="p-3 border-b border-border">{formatCents(a.estimatedMonthlyCostCents)}</td>
                  <td className="p-3 border-b border-border">{formatCents(a.estimatedMonthlySavingsCents)}</td>
                  <td className="p-3 border-b border-border">
                    <a href={`/assessments/${a.id}`}>View report</a>
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
