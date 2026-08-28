"use client";

import { useCallback, useEffect, useState } from "react";
import {
  PROVIDER_LABELS,
  type MigrationPhase,
  type MigrationStatus,
  type MigrationSummary,
} from "@infralift/shared";
import { api, formatCents } from "../../lib/api";
import {
  Card,
  Chip,
  Dot,
  H1,
  Note,
  PrimaryButton,
  type Tone,
} from "../../components/ui";

const STATUS_TONE: Record<MigrationStatus, Tone> = {
  completed: "accent",
  in_progress: "warn",
  verifying: "warn",
  approved: "warn",
  proposed: "muted",
  cancelled: "danger",
};

const PHASE_TONE: Record<MigrationPhase["status"], Tone> = {
  completed: "accent",
  in_progress: "warn",
  pending: "muted",
  blocked: "danger",
};

export default function MigrationsPage() {
  const [migrations, setMigrations] = useState<MigrationSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setMigrations(await api<MigrationSummary[]>("/migrations"));
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
      <h1 className={H1}>Migration status</h1>
      <p className="mb-7 max-w-[640px] text-muted">
        Your current stack stays live until cutover; we build the target
        environment in parallel. Read-only on your source provider the whole way.
      </p>

      {error && <div className="mb-4 text-sm text-danger">{error}</div>}

      {migrations.length === 0 ? (
        <Card>
          <h3 className="mb-1.5 text-[15px] font-semibold">No migrations yet</h3>
          <p className="mb-4.5 max-w-[520px] text-sm leading-relaxed text-muted">
            Run an assessment first. Your report includes a fixed-fee migration
            quote, and once you approve it the migration appears here.
          </p>
          <PrimaryButton href="/assessments">Go to assessments</PrimaryButton>
        </Card>
      ) : (
        migrations.map((m) => (
          <Card key={m.id} className="mb-4">
            <div className="mb-1 flex items-center gap-2.5">
              <h3 className="text-base font-semibold">
                {PROVIDER_LABELS[m.sourceProvider]} to{" "}
                {m.targetPlatform === "cloudflare" ? "Cloudflare" : "VPS"}
              </h3>
              <Chip tone={STATUS_TONE[m.status] ?? "muted"}>
                {m.status.replace("_", " ")}
              </Chip>
            </div>
            <p className="mb-2 text-sm text-muted">
              Fixed fee: {formatCents(m.fixedFeeCents)}
              {m.repoUrl && (
                <>
                  {" \u00b7 "}
                  <a href={m.repoUrl}>Terraform repo</a>
                </>
              )}
              {m.tfcOrg && <> &middot; TF Cloud org: {m.tfcOrg}</>}
            </p>
            <div className="flex flex-col">
              {m.phases.map((p) => (
                <div
                  key={p.key}
                  className="flex items-baseline gap-3.5 border-b border-border py-3.5"
                >
                  <Dot tone={PHASE_TONE[p.status]} />
                  <div>
                    <div className="text-sm font-semibold">
                      {p.title}
                      {p.completedAt && (
                        <span className="ml-2 text-[13px] font-normal text-muted">
                          {new Date(p.completedAt).toLocaleDateString()}
                        </span>
                      )}
                      {!p.completedAt && p.status === "in_progress" && (
                        <span className="ml-2 text-[13px] font-normal text-muted">
                          in progress
                        </span>
                      )}
                    </div>
                    {p.notes && (
                      <div className="mt-0.5 text-[13px] leading-relaxed text-muted">
                        {p.notes}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-4.5">
              <Note>
                Cutover is scheduled and reversible: TTLs lowered ahead of time,
                final delta sync, DNS flip, old stack kept warm as instant
                rollback. You execute the write actions.
              </Note>
            </div>
          </Card>
        ))
      )}
    </>
  );
}
