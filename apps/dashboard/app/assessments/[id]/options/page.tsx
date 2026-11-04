"use client";

import { use, useEffect, useState } from "react";
import {
  PROVIDER_LABELS,
  type ExitTollEstimate,
  type MigrationOption,
  type MigrationOptionsReport,
  type Provider,
} from "@infralift/shared";
import { api, formatCents } from "../../../../lib/api";
import {
  Card,
  Chip,
  Drawer,
  INPUT,
  LABEL,
  NUM,
  Note,
  PrimaryButton,
  StatCard,
} from "../../../../components/ui";

interface ApproveResult {
  project: { id: string; name: string; destRepo: string; destPath: string };
  job: { id: string; stage: string; status: string };
}

const MANAGED_LABEL: Record<number, string> = {
  0: "you run the servers",
  1: "mostly self-managed",
  2: "managed with knobs",
  3: "fully managed",
};

// The one-time cost of getting data out. Buyers conflate this with the
// monthly egress line, so it is stated as its own number with the volume it
// was computed from rather than folded into any target's estimate.
function ExitTollCard({
  toll,
  provider,
}: {
  toll: ExitTollEstimate;
  provider: Provider;
}) {
  if (!toll) return null;

  const headline =
    toll.confidence === "none"
      ? "Nothing to move"
      : toll.waiverAvailable
        ? `${formatCents(toll.cents)} once, waived`
        : `${formatCents(toll.cents)} once`;

  return (
    <Card className="mb-5">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <div className="text-[11px] uppercase tracking-[0.06em] text-faint">
          One-time cost to leave {PROVIDER_LABELS[provider]}
        </div>
        {toll.confidence !== "none" && (
          <Chip tone={toll.confidence === "measured" ? "info" : "muted"} size="sm">
            {toll.confidence === "measured" ? "measured" : "estimated"}
          </Chip>
        )}
      </div>

      <div className={`${NUM} text-[22px]`}>{headline}</div>
      {toll.confidence !== "none" && (
        <div className="mt-0.5 text-[13px] text-muted">
          {toll.totalGb}GB of stored data leaving, once. Separate from the
          monthly bandwidth bill, which stops at cutover.
        </div>
      )}

      {toll.components.length > 0 && (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-[13px]">
            <tbody>
              {toll.components.map((c) => (
                <tr key={c.label} className="align-top">
                  <td className="py-1 pr-3">{c.label}</td>
                  <td className={`${NUM} py-1 pr-3 text-right whitespace-nowrap`}>
                    {c.gb}GB
                  </td>
                  <td className={`${NUM} py-1 text-right whitespace-nowrap`}>
                    {formatCents(c.cents)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {toll.notes.map((n) => (
        <p key={n} className="mt-2 text-[13px] text-muted">
          {n}
        </p>
      ))}
    </Card>
  );
}

function OptionCard({
  option,
  rank,
  assessmentId,
  currentMonthlyCents,
  onApprove,
}: {
  onApprove: (target: "cloudflare" | "hetzner") => void;
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
          <div className="flex flex-wrap items-center gap-2.5">
            <PrimaryButton
              href={`/assessments/${assessmentId}?codegen=${option.codegenTarget}#codegen`}
            >
              Preview sample IaC
            </PrimaryButton>
            <button
              type="button"
              onClick={() => onApprove(option.codegenTarget!)}
              className="rounded-lg border border-accent/40 px-3.5 py-2 text-[13px] font-semibold text-accent hover:bg-accent-dim/40"
            >
              Approve and build it
            </button>
          </div>
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

  // Approval drawer
  const [approving, setApproving] = useState<"cloudflare" | "hetzner" | null>(
    null
  );
  const [repo, setRepo] = useState("");
  const [destPath, setDestPath] = useState("infrastructure");
  const [busy, setBusy] = useState(false);
  const [approveError, setApproveError] = useState<string | null>(null);
  const [approved, setApproved] = useState<ApproveResult | null>(null);

  useEffect(() => {
    api<MigrationOptionsReport>(`/assessments/${id}/options`)
      .then(setReport)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [id]);

  async function submitApproval() {
    if (!approving) return;
    setBusy(true);
    setApproveError(null);
    try {
      const result = await api<ApproveResult>("/tf/approve", {
        method: "POST",
        body: JSON.stringify({
          assessmentId: id,
          migrationTarget: approving,
          repo: repo.trim(),
          destPath: destPath.trim(),
        }),
      });
      setApproved(result);
      setApproving(null);
    } catch (e) {
      setApproveError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

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
        <a href="/projects">Projects</a> /{" "}
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

      <ExitTollCard toll={report.exitToll} provider={report.provider} />

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
            onApprove={(target) => {
              setApproved(null);
              setApproveError(null);
              setRepo((r) => r || `your-org/${report.provider}-migration`);
              setApproving(target);
            }}
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

      {approving && (
        <Drawer
          title={`Build the ${approving} environment`}
          subtitle="infralift creates the repository, commits the Terraform, and provisions a workspace. Nothing is applied until you review the plan."
          onClose={() => setApproving(null)}
        >
          <label className={LABEL}>GitHub repository</label>
          <input
            className={INPUT}
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
            placeholder="your-org/infrastructure"
          />
          <p className="mt-1.5 mb-4 text-[13px] text-muted">
            Created as a private repo if it does not exist. Needs a GitHub
            connection on this organization.
          </p>

          <label className={LABEL}>Directory in the repo</label>
          <input
            className={INPUT}
            value={destPath}
            onChange={(e) => setDestPath(e.target.value)}
            placeholder="infrastructure"
          />
          <p className="mt-1.5 mb-5 text-[13px] text-muted">
            Leave blank to write at the repository root.
          </p>

          {approveError && (
            <div className="mb-3 text-sm text-danger">{approveError}</div>
          )}

          <PrimaryButton
            onClick={submitApproval}
            disabled={busy || repo.trim().length === 0}
          >
            {busy ? "Building..." : "Create repo and commit"}
          </PrimaryButton>
        </Drawer>
      )}

      {approved && (
        <div className="mt-4">
          <Note tone="accent">
            Building <strong>{approved.project.name}</strong> into{" "}
            <a
              href={`https://github.com/${approved.project.destRepo}`}
              target="_blank"
              rel="noreferrer"
            >
              {approved.project.destRepo}
            </a>
            . Track it under <a href="/projects">Projects</a> (job{" "}
            {approved.job.id.slice(-8)} is {approved.job.status}).
          </Note>
        </div>
      )}
    </>
  );
}
