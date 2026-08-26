"use client";

import { use, useEffect, useState } from "react";
import {
  PROVIDER_LABELS,
  type AssessmentReport,
} from "@infralift/shared";
import { api, formatCents } from "../../../lib/api";

const SEVERITY_BADGE: Record<string, string> = {
  high: "inline-block px-2.5 py-0.5 rounded-full text-xs font-semibold bg-danger/20 text-danger",
  medium: "inline-block px-2.5 py-0.5 rounded-full text-xs font-semibold bg-warn/20 text-warn",
  low: "inline-block px-2.5 py-0.5 rounded-full text-xs font-semibold bg-border text-muted",
  info: "inline-block px-2.5 py-0.5 rounded-full text-xs font-semibold bg-border text-muted",
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

  if (error) return <div className="text-danger text-sm mt-2">{error}</div>;
  if (!report) return <p className="text-muted mb-8">Loading report...</p>;

  return (
    <>
      <h1 className="text-3xl font-bold tracking-tight mb-2">
        {PROVIDER_LABELS[report.provider]} assessment
      </h1>
      <p className="text-muted mb-8">
        {report.completedAt
          ? `Completed ${new Date(report.completedAt).toLocaleString()}`
          : `Status: ${report.status}`}
      </p>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
        <div className="bg-surface border border-border rounded-xl p-6 text-center">
          <div className="text-4xl font-bold text-accent tracking-tight mb-1">
            {report.resourceCount}
            <small className="block text-sm text-muted font-normal">resources inventoried</small>
          </div>
        </div>
        <div className="bg-surface border border-border rounded-xl p-6 text-center">
          <div className="text-4xl font-bold text-accent tracking-tight mb-1">
            {formatCents(report.estimatedMonthlyCostCents)}
            <small className="block text-sm text-muted font-normal">estimated monthly cost</small>
          </div>
        </div>
        <div className="bg-surface border border-border rounded-xl p-6 text-center">
          <div className="text-4xl font-bold text-accent tracking-tight mb-1">
            {formatCents(report.estimatedMonthlySavingsCents)}
            <small className="block text-sm text-muted font-normal">estimated monthly savings</small>
          </div>
        </div>
      </div>

      <div className="bg-surface border border-border rounded-xl p-6 mb-4 mt-5">
        <h3 className="text-base font-semibold mb-1.5">Findings ({report.findings.length})</h3>
        {report.findings.length === 0 ? (
          <p className="text-muted text-sm">No findings.</p>
        ) : (
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr>
                <th className="text-left p-3 border-b border-border text-muted font-medium text-xs">Severity</th>
                <th className="text-left p-3 border-b border-border text-muted font-medium text-xs">Category</th>
                <th className="text-left p-3 border-b border-border text-muted font-medium text-xs">Finding</th>
              </tr>
            </thead>
            <tbody>
              {report.findings.map((f) => (
                <tr key={f.id}>
                  <td className="p-3 border-b border-border">
                    <span className={SEVERITY_BADGE[f.severity]}>
                      {f.severity}
                    </span>
                  </td>
                  <td className="p-3 border-b border-border">{f.category.replace("_", " ")}</td>
                  <td className="p-3 border-b border-border">
                    <strong>{f.title}</strong>
                    <p className="text-muted text-sm">{f.detail}</p>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="bg-surface border border-border rounded-xl p-6 mb-4">
        <h3 className="text-base font-semibold mb-1.5">Inventory ({report.inventory.length})</h3>
        {report.inventory.length === 0 ? (
          <p className="text-muted text-sm">No resources found.</p>
        ) : (
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr>
                <th className="text-left p-3 border-b border-border text-muted font-medium text-xs">Type</th>
                <th className="text-left p-3 border-b border-border text-muted font-medium text-xs">Name</th>
                <th className="text-left p-3 border-b border-border text-muted font-medium text-xs">Region</th>
                <th className="text-left p-3 border-b border-border text-muted font-medium text-xs">Monthly cost</th>
              </tr>
            </thead>
            <tbody>
              {report.inventory.map((i, idx) => (
                <tr key={`${i.externalId}-${idx}`}>
                  <td className="p-3 border-b border-border">{i.type}</td>
                  <td className="p-3 border-b border-border">{i.name}</td>
                  <td className="p-3 border-b border-border">{i.region ?? "—"}</td>
                  <td className="p-3 border-b border-border">{formatCents(i.monthlyCostCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
