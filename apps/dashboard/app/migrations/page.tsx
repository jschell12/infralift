"use client";

import { useCallback, useEffect, useState } from "react";
import {
  PROVIDER_LABELS,
  type MigrationSummary,
} from "@infralift/shared";
import { api, formatCents } from "../../lib/api";

const STATUS_BADGE: Record<string, string> = {
  completed: "inline-block px-2.5 py-0.5 rounded-full text-xs font-semibold bg-accent-dim text-accent",
  in_progress: "inline-block px-2.5 py-0.5 rounded-full text-xs font-semibold bg-warn/20 text-warn",
  verifying: "inline-block px-2.5 py-0.5 rounded-full text-xs font-semibold bg-warn/20 text-warn",
  approved: "inline-block px-2.5 py-0.5 rounded-full text-xs font-semibold bg-warn/20 text-warn",
  proposed: "inline-block px-2.5 py-0.5 rounded-full text-xs font-semibold bg-border text-muted",
  cancelled: "inline-block px-2.5 py-0.5 rounded-full text-xs font-semibold bg-danger/20 text-danger",
};

export default function MigrationsPage() {
  const [migrations, setMigrations] = useState<MigrationSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setMigrations(
        await api<MigrationSummary[]>(`/migrations`)
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
      <h1 className="text-3xl font-bold tracking-tight mb-2">Migration status</h1>
      <p className="text-muted mb-8">
        Each migration runs through six phases. Your current stack stays live
        until cutover; we build the target environment in parallel.
      </p>

      {error && <div className="text-danger text-sm mt-2">{error}</div>}

      {migrations.length === 0 ? (
        <div className="bg-surface border border-border rounded-xl p-6 mb-4">
          <h3 className="text-base font-semibold mb-1.5">No migrations yet</h3>
          <p className="text-muted text-sm">
            Run an assessment first. Your report includes a fixed-fee
            migration quote, and once you approve it the migration appears
            here.
          </p>
          <a
            className="inline-block mt-4 px-7 py-3 rounded-lg text-base font-semibold cursor-pointer border border-transparent bg-accent text-bg hover:bg-accent/90"
            href="/assessments"
          >
            Go to assessments
          </a>
        </div>
      ) : (
        migrations.map((m) => (
          <div className="bg-surface border border-border rounded-xl p-6 mb-4" key={m.id}>
            <h3 className="text-base font-semibold mb-1.5">
              {PROVIDER_LABELS[m.sourceProvider]} to{" "}
              {m.targetPlatform === "cloudflare" ? "Cloudflare" : "VPS"}{" "}
              <span className={STATUS_BADGE[m.status] ?? "inline-block px-2.5 py-0.5 rounded-full text-xs font-semibold bg-border text-muted"}>
                {m.status.replace("_", " ")}
              </span>
            </h3>
            <p className="text-muted text-sm">
              Fixed fee: {formatCents(m.fixedFeeCents)}
              {m.repoUrl && (
                <>
                  {" · "}
                  <a href={m.repoUrl}>Terraform repo</a>
                </>
              )}
              {m.tfcOrg && <> · TF Cloud org: {m.tfcOrg}</>}
            </p>
            <ul className="list-none space-y-0">
              {m.phases.map((p) => (
                <li
                  key={p.key}
                  className="flex gap-3.5 py-3 border-b border-border items-baseline"
                >
                  <span
                    className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${
                      p.status === "completed"
                        ? "bg-accent"
                        : p.status === "in_progress"
                          ? "bg-warn"
                          : "bg-border"
                    }`}
                  />
                  <div>
                    <strong>{p.title}</strong>
                    {p.completedAt && (
                      <span className="text-muted ml-2">
                        {new Date(p.completedAt).toLocaleDateString()}
                      </span>
                    )}
                    {p.notes && <p className="text-muted text-sm">{p.notes}</p>}
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
