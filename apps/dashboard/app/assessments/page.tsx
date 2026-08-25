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
      <h1>Assessments</h1>
      <p className="lead">
        Run a read-only assessment against a connected provider to inventory
        resources and project costs.
      </p>

      <div className="card">
        <h3>Run a new assessment</h3>
        <label>Connection</label>
        <select
          value={connectionId}
          onChange={(e) => setConnectionId(e.target.value)}
        >
          <option value="">Select a connection…</option>
          {connections
            .filter((c) => c.status === "valid")
            .map((c) => (
              <option key={c.id} value={c.id}>
                {PROVIDER_LABELS[c.provider]}: {c.label}
              </option>
            ))}
        </select>
        <button
          className="btn btn-primary"
          onClick={run}
          disabled={busy || !connectionId}
        >
          {busy ? "Running…" : "Run assessment"}
        </button>
        {error && <div className="error">{error}</div>}
      </div>

      <div className="card">
        <h3>History</h3>
        {assessments.length === 0 ? (
          <p>No assessments yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Provider</th>
                <th>Status</th>
                <th>Resources</th>
                <th>Est. monthly cost</th>
                <th>Est. savings</th>
                <th>Report</th>
              </tr>
            </thead>
            <tbody>
              {assessments.map((a) => (
                <tr key={a.id}>
                  <td>{PROVIDER_LABELS[a.provider]}</td>
                  <td>
                    <span
                      className={
                        a.status === "completed"
                          ? "badge badge-ok"
                          : a.status === "failed"
                            ? "badge badge-bad"
                            : "badge badge-warn"
                      }
                    >
                      {a.status}
                    </span>
                  </td>
                  <td>{a.resourceCount}</td>
                  <td>{formatCents(a.estimatedMonthlyCostCents)}</td>
                  <td>{formatCents(a.estimatedMonthlySavingsCents)}</td>
                  <td>
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
