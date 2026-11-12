"use client";

import {
  PROVIDER_LABELS,
  type MigrationPhase,
  type MigrationStatus,
  type MigrationSummary,
} from "@infralift/shared";
import { formatCents } from "../lib/api";
import { Card, Chip, Dot, type Tone } from "./ui";

// A done-for-you migration: infralift does the work in phases for a fixed
// fee. Shown on Projects beside the self-serve projects, since both are "an
// app and where it runs".

const STATUS_TONE: Record<MigrationStatus, Tone> = {
  completed: "ok",
  in_progress: "warn",
  verifying: "warn",
  approved: "warn",
  proposed: "muted",
  cancelled: "danger",
};

const PHASE_TONE: Record<MigrationPhase["status"], Tone> = {
  completed: "ok",
  in_progress: "warn",
  pending: "muted",
  blocked: "danger",
};

export function MigrationCard({ m }: { m: MigrationSummary }) {
  return (
    <Card className="mb-4">
      <div className="mb-1 flex items-center gap-2.5">
        <h3 className="text-base font-semibold">
          {PROVIDER_LABELS[m.sourceProvider]} to{" "}
          {m.targetPlatform === "cloudflare" ? "Cloudflare" : "VPS"}
        </h3>
        <Chip tone="muted">Done for you</Chip>
        <Chip tone={STATUS_TONE[m.status] ?? "muted"}>{m.status.replace("_", " ")}</Chip>
      </div>
      <p className="mb-2 text-sm text-muted">
        Fixed fee: {formatCents(m.fixedFeeCents)}
        {m.repoUrl && (
          <>
            {" · "}
            <a href={m.repoUrl}>Terraform repo</a>
          </>
        )}
        {m.tfcOrg && <> &middot; TF Cloud org: {m.tfcOrg}</>}
      </p>
      <div className="flex flex-col">
        {m.phases.map((p) => (
          <div key={p.key} className="flex items-baseline gap-3.5 border-b border-border py-3.5">
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
                  <span className="ml-2 text-[13px] font-normal text-muted">in progress</span>
                )}
              </div>
              {p.notes && (
                <div className="mt-0.5 text-[13px] leading-relaxed text-muted">{p.notes}</div>
              )}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
