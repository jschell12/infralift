"use client";

import { use, useEffect, useState } from "react";
import {
  PROVIDER_LABELS,
  type AssessmentReport,
} from "@infralift/shared";
import { api, formatCents } from "../../../lib/api";

const SEVERITY_BADGE: Record<string, string> = {
  high: "badge badge-bad",
  medium: "badge badge-warn",
  low: "badge badge-muted",
  info: "badge badge-muted",
};

export default function AssessmentReportPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const [report, setReport] = useState<AssessmentReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<AssessmentReport>(`/assessments/${id}`)
      .then(setReport)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [id]);

  if (error) return <div className="error">{error}</div>;
  if (!report) return <p className="lead">Loading report…</p>;

  return (
    <>
      <h1>
        {PROVIDER_LABELS[report.provider]} assessment
      </h1>
      <p className="lead">
        {report.completedAt
          ? `Completed ${new Date(report.completedAt).toLocaleString()}`
          : `Status: ${report.status}`}
      </p>

      <div className="grid grid-3">
        <div className="card">
          <div className="stat">
            {report.resourceCount}
            <small>resources inventoried</small>
          </div>
        </div>
        <div className="card">
          <div className="stat">
            {formatCents(report.estimatedMonthlyCostCents)}
            <small>estimated monthly cost</small>
          </div>
        </div>
        <div className="card">
          <div className="stat">
            {formatCents(report.estimatedMonthlySavingsCents)}
            <small>estimated monthly savings</small>
          </div>
        </div>
      </div>

      <div className="card">
        <h3>Findings ({report.findings.length})</h3>
        {report.findings.length === 0 ? (
          <p>No findings.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Severity</th>
                <th>Category</th>
                <th>Finding</th>
              </tr>
            </thead>
            <tbody>
              {report.findings.map((f) => (
                <tr key={f.id}>
                  <td>
                    <span className={SEVERITY_BADGE[f.severity]}>
                      {f.severity}
                    </span>
                  </td>
                  <td>{f.category.replace("_", " ")}</td>
                  <td>
                    <strong>{f.title}</strong>
                    <p>{f.detail}</p>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h3>Inventory ({report.inventory.length})</h3>
        {report.inventory.length === 0 ? (
          <p>No resources found.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Type</th>
                <th>Name</th>
                <th>Region</th>
                <th>Monthly cost</th>
              </tr>
            </thead>
            <tbody>
              {report.inventory.map((i, idx) => (
                <tr key={`${i.externalId}-${idx}`}>
                  <td>{i.type}</td>
                  <td>{i.name}</td>
                  <td>{i.region ?? "—"}</td>
                  <td>{formatCents(i.monthlyCostCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
