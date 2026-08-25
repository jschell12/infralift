"use client";

import { useCallback, useEffect, useState } from "react";
import {
  PROVIDER_LABELS,
  type MigrationSummary,
} from "@infralift/shared";
import { api, DEV_ORG_ID, formatCents } from "../../lib/api";

const STATUS_BADGE: Record<string, string> = {
  completed: "badge badge-ok",
  in_progress: "badge badge-warn",
  verifying: "badge badge-warn",
  approved: "badge badge-warn",
  proposed: "badge badge-muted",
  cancelled: "badge badge-bad",
};

export default function MigrationsPage() {
  const [migrations, setMigrations] = useState<MigrationSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setMigrations(
        await api<MigrationSummary[]>(`/migrations?orgId=${DEV_ORG_ID}`)
      );
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <h1>Migration status</h1>
      <p className="lead">
        Each migration runs through six phases. Your current stack stays live
        until cutover; we build the target environment in parallel.
      </p>

      {error && <div className="error">{error}</div>}

      {migrations.length === 0 ? (
        <div className="card">
          <h3>No migrations yet</h3>
          <p>
            Run an assessment first. Your report includes a fixed-fee
            migration quote, and once you approve it the migration appears
            here.
          </p>
          <a className="btn btn-primary" href="/assessments">
            Go to assessments
          </a>
        </div>
      ) : (
        migrations.map((m) => (
          <div className="card" key={m.id}>
            <h3>
              {PROVIDER_LABELS[m.sourceProvider]} to{" "}
              {m.targetPlatform === "cloudflare" ? "Cloudflare" : "VPS"}{" "}
              <span className={STATUS_BADGE[m.status] ?? "badge badge-muted"}>
                {m.status.replace("_", " ")}
              </span>
            </h3>
            <p>
              Fixed fee: {formatCents(m.fixedFeeCents)}
              {m.repoUrl && (
                <>
                  {" · "}
                  <a href={m.repoUrl}>Terraform repo</a>
                </>
              )}
              {m.tfcOrg && <> · TF Cloud org: {m.tfcOrg}</>}
            </p>
            <ul className="timeline">
              {m.phases.map((p) => (
                <li key={p.key}>
                  <span
                    className={`dot ${
                      p.status === "completed"
                        ? "done"
                        : p.status === "in_progress"
                          ? "active"
                          : ""
                    }`}
                  />
                  <div>
                    <strong>{p.title}</strong>
                    {p.completedAt && (
                      <span style={{ color: "var(--muted)", marginLeft: 8 }}>
                        {new Date(p.completedAt).toLocaleDateString()}
                      </span>
                    )}
                    {p.notes && <p>{p.notes}</p>}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
    </>
  );
}
