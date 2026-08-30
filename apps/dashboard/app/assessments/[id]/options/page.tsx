"use client";

import { use, useEffect, useState } from "react";
import {
  PROVIDER_LABELS,
  type MigrationOption,
  type MigrationOptionsReport,
} from "@infralift/shared";
import { api, formatCents } from "../../../../lib/api";
import {
  Card,
  Chip,
  NUM,
  Note,
  PrimaryButton,
  StatCard,
} from "../../../../components/ui";

const MANAGED_LABEL: Record<number, string> = {
  0: "you run the servers",
  1: "mostly self-managed",
  2: "managed with knobs",
  3: "fully managed",
};

function OptionCard({
  option,
  rank,
  assessmentId,
  currentMonthlyCents,
}: {
  option: MigrationOption;
  rank: number;
  assessmentId: string;
  currentMonthlyCents: number;
}) {
  const companionMonthly = option.companions.reduce(
    (sum, c) => sum + c.monthlyCents,
    0
  );
  // Sized targets own the all-in number; unsized fall back to catalog price
  // plus companions and make no savings claim.
  const allIn = option.sizing
    ? option.sizing.monthlyCents
    : option.pricing.steadyStateMonthlyCents + companionMonthly;
  const saves = option.monthlySavingsCents;

  return (
    <Card className="mb-4">
      <div className="mb-3 flex flex-wrap items-center gap-2.5">
        <span className="text-[13px] text-faint">#{rank}</span>
        <h3 className="text-[17px] font-semibold">{option.name}</h3>
        <Chip size="xs" tone="muted">
          {option.category}
        </Chip>
        <Chip size="xs" tone={option.managedLevel >= 2 ? "accent" : "warn"}>
          {MANAGED_LABEL[option.managedLevel] ?? "unknown ops model"}
        </Chip>
        {saves !== null && saves > 0 && (
          <span className={`ml-auto text-[15px] font-semibold text-accent ${NUM}`}>
            saves {formatCents(saves)}/mo
          </span>
        )}
        {saves !== null && saves <= 0 && currentMonthlyCents > 0 && (
          <span className={`ml-auto text-[15px] font-semibold text-warn ${NUM}`}>
            +{formatCents(-saves)}/mo vs today
          </span>
        )}
        {saves === null && (
          <span className="ml-auto text-[13px] text-faint">
            sized estimate on request
          </span>
        )}
      </div>

      {option.sizing ? (
        <div className="mb-4">
          <div className="mb-2 flex items-baseline gap-2.5">
            <span className={`text-[22px] font-bold tracking-[-0.02em] ${NUM}`}>
              {formatCents(option.sizing.monthlyCents)}/mo
            </span>
            <span className="text-[13px] text-muted">
              all-in, sized to this workload
            </span>
            <Chip size="xs" tone="accent">
              {option.sizing.confidence}
            </Chip>
          </div>
          <div className="mb-1.5 text-[11px] uppercase tracking-[0.06em] text-faint">
            How we sized it
          </div>
          {option.sizing.lineItems.map((li) => (
            <div
              key={li.label}
              className="mb-1.5 flex items-baseline gap-2 rounded-md bg-bg px-2.5 py-2 text-[13px]"
            >
              <span className="font-medium">{li.label}</span>
              <span
                className={`shrink-0 font-semibold ${NUM} ${li.monthlyCents === 0 ? "text-accent" : "text-text"}`}
              >
                {li.monthlyCents === 0 ? "$0" : `${formatCents(li.monthlyCents)}/mo`}
              </span>
              {li.note && <span className="text-faint">{li.note}</span>}
            </div>
          ))}
        </div>
      ) : (
        <div className="mb-4 grid grid-cols-3 gap-3 max-w-[520px]">
          {(
            [
              ["Catalog typical", option.pricing.listMonthlyCents],
              ["Year 1", option.pricing.year1MonthlyCents],
              ["Steady state", option.pricing.steadyStateMonthlyCents],
            ] as const
          ).map(([label, cents]) => (
            <div key={label} className="rounded-lg bg-bg px-3 py-2">
              <div className="text-[10px] uppercase tracking-[0.06em] text-faint">
                {label}
              </div>
              <div className={`text-[15px] font-semibold ${NUM}`}>
                {formatCents(cents)}/mo
              </div>
            </div>
          ))}
        </div>
      )}

      {option.companions.length > 0 && (
        <div className="mb-4">
          <div className="mb-1.5 text-[11px] uppercase tracking-[0.06em] text-faint">
            Pair with
          </div>
          {option.companions.map((c) => (
            <div
              key={c.name}
              className="mb-1.5 flex items-baseline gap-2 rounded-md bg-bg px-2.5 py-2 text-[13px]"
            >
              <span className="font-medium">{c.name}</span>
              <span className={`text-muted ${NUM}`}>
                ~{formatCents(c.monthlyCents)}/mo
              </span>
              <span className="text-faint">{c.note}</span>
            </div>
          ))}
          <div className={`text-[13px] text-muted ${NUM}`}>
            All-in steady state: {formatCents(allIn)}/mo
          </div>
        </div>
      )}

      <div className="mb-4 grid grid-cols-1 gap-3 md:grid-cols-2">
        <div>
          <div className="mb-1 text-[11px] uppercase tracking-[0.06em] text-faint">
            Why it fits
          </div>
          <p className="text-[13px] leading-relaxed text-muted">
            {option.benefits}
          </p>
        </div>
        <div>
          <div className="mb-1 text-[11px] uppercase tracking-[0.06em] text-faint">
            Trade-offs
          </div>
          <p className="text-[13px] leading-relaxed text-muted">
            {option.drawbacks}
          </p>
        </div>
      </div>

      {option.codegenTarget ? (
        <>
          <PrimaryButton
            href={`/assessments/${assessmentId}?codegen=${option.codegenTarget}#codegen`}
          >
            Preview sample IaC
          </PrimaryButton>
          {option.sizing && (
            <p className="mt-3 text-[13px] leading-relaxed text-muted">
              infralift builds this environment in parallel with your live
              site, then cuts over DNS with instant rollback. No downtime,
              fixed fee.
            </p>
          )}
        </>
      ) : (
        <span className="text-[13px] text-faint">
          Sample IaC generation for {option.name} coming soon
        </span>
      )}
    </Card>
  );
}

export default function MigrationOptionsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const [report, setReport] = useState<MigrationOptionsReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<MigrationOptionsReport>(`/assessments/${id}/options`)
      .then(setReport)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [id]);

  if (error) return <div className="mt-2 text-sm text-danger">{error}</div>;
  if (!report) return <p className="text-muted">Loading options...</p>;

  // Prefer the best sized option for the headline — it's the one whose
  // number we can defend line by line.
  const best =
    report.options
      .filter((o) => o.sizing && o.monthlySavingsCents !== null)
      .sort((a, b) => (b.monthlySavingsCents ?? 0) - (a.monthlySavingsCents ?? 0))[0] ??
    report.options[0];
  // Only sized targets make a savings claim.
  const bestSavings = Math.max(
    0,
    ...report.options
      .map((o) => o.monthlySavingsCents)
      .filter((s): s is number => s !== null)
  );

  return (
    <>
      <div className="mb-2.5 text-[13px] text-muted">
        <a href="/assessments">Assessments</a> /{" "}
        <a href={`/assessments/${report.assessmentId}`}>
          {PROVIDER_LABELS[report.provider]}
        </a>{" "}
        / Migration options
      </div>
      <h1 className="mb-1.5 text-[26px] font-bold tracking-[-0.02em]">
        Where this workload could run
      </h1>
      <p className="mb-6 max-w-[640px] text-muted">
        Ranked against what the assessment actually found — not a generic
        provider list. Estimates use published pricing plus the discounts your
        spend level really reaches.
      </p>

      <div className="mb-5 grid grid-cols-1 gap-4 md:grid-cols-3">
        <StatCard
          label={`Current spend on ${PROVIDER_LABELS[report.provider]}`}
          value={`${formatCents(report.currentMonthlyCents)}/mo`}
          tone="danger"
          center
        />
        <StatCard
          label="Best-fit target"
          value={best ? best.name : "—"}
          center
        />
        <StatCard
          label="Best steady-state savings"
          value={`${formatCents(bestSavings)}/mo`}
          center
        />
      </div>

      {report.needs.length > 0 && (
        <Card className="mb-5">
          <div className="mb-2 text-[11px] uppercase tracking-[0.06em] text-faint">
            What your infrastructure needs
          </div>
          <div className="flex flex-wrap gap-2">
            {report.needs.map((n) => (
              <span key={n.key} title={`from: ${n.evidence}`}>
                <Chip tone="info" size="sm">
                  {n.label}
                </Chip>
              </span>
            ))}
          </div>
          <p className="mt-3 text-[13px] text-muted">
            Inferred from the {report.provider} inventory. Every target below
            either covers these directly or is paired with a service that does.
          </p>
        </Card>
      )}

      {report.options.length === 0 ? (
        <Note>
          No targets cleared the workload&apos;s hard requirements. That
          usually means the assessment found capabilities we cannot yet map
          &mdash; reach out and we will size it by hand.
        </Note>
      ) : (
        report.options.map((o, i) => (
          <OptionCard
            key={o.slug}
            option={o}
            rank={i + 1}
            assessmentId={report.assessmentId}
            currentMonthlyCents={report.currentMonthlyCents}
          />
        ))
      )}

      <div className="mt-2">
        <Note>
          Prices are steady-state estimates for comparable capacity, not
          quotes. The fixed-fee migration quote on the assessment report is
          what you actually pay us.
        </Note>
      </div>
    </>
  );
}
