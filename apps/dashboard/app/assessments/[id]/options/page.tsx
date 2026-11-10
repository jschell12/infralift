"use client";

import { use, useEffect, useState } from "react";
import {
  PROVIDER_LABELS,
  type CurrentSpendSource,
  type ExitTollEstimate,
  type MigrationOption,
  type MigrationOptionsReport,
  type Provider,
} from "@infralift/shared";
import { api, formatCents } from "../../../../lib/api";
import {
  Card,
  CardTitle,
  Chip,
  Drawer,
  INPUT,
  LABEL,
  NUM,
  Note,
  PrimaryButton,
  StatCard,
  TableHead,
  TableRow,
  type Tone,
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

const SOURCE_LABEL: Record<CurrentSpendSource, string> = {
  customer_reported: "your bill",
  inventory_list_price: "list price",
  unknown: "unknown",
};
const SOURCE_TONE: Record<CurrentSpendSource, Tone> = {
  customer_reported: "accent",
  inventory_list_price: "warn",
  unknown: "faint",
};
const SOURCE_DETAIL: Record<CurrentSpendSource, string> = {
  customer_reported: "the monthly bill you entered",
  inventory_list_price:
    "the assessed resources at published list prices, not your invoice",
  unknown: "this provider does not expose billing to us",
};

const BTN_OUTLINE =
  "rounded-lg border border-accent/40 px-3.5 py-2 text-[13px] font-semibold text-accent hover:bg-accent-dim/40 disabled:opacity-50";

function breakEvenLabel(option: MigrationOption, spendKnown: boolean): string {
  if (!spendKnown) return "\u2014";
  if (option.breakEvenMonths === null) return "never";
  if (option.breakEvenMonths === 0) return "immediately";
  return `${option.breakEvenMonths} mo`;
}

// One field, inline: the comparison is meaningless without it, so it sits
// where the missing number would be rather than behind a drawer.
function SpendForm({
  assessmentId,
  initialCents,
  canClear,
  onSaved,
  onCancel,
}: {
  assessmentId: string;
  initialCents: number | null;
  canClear: boolean;
  onSaved: () => void;
  onCancel?: () => void;
}) {
  const [value, setValue] = useState(
    initialCents !== null ? String(initialCents / 100) : ""
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parsed = Number(value.replace(/[$,\s]/g, ""));
  const valid = value.trim() !== "" && Number.isFinite(parsed) && parsed >= 0;

  async function save(monthlyUsd: number | null) {
    setBusy(true);
    setError(null);
    try {
      await api(`/assessments/${assessmentId}/spend`, {
        method: "PATCH",
        body: JSON.stringify({ monthlyUsd }),
      });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) save(parsed);
      }}
      className="border-b border-border py-3"
    >
      <label className={LABEL} htmlFor="monthly-bill">
        What&apos;s your monthly bill?
      </label>
      <div className="flex flex-wrap items-center gap-2.5">
        <div className="w-[180px]">
          <input
            id="monthly-bill"
            className={INPUT}
            inputMode="decimal"
            placeholder="USD, e.g. 750"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        </div>
        <button type="submit" className={BTN_OUTLINE} disabled={busy || !valid}>
          {busy ? "Saving..." : "Compare"}
        </button>
        {canClear && (
          <button
            type="button"
            className="text-[13px] text-muted hover:text-text"
            disabled={busy}
            onClick={() => save(null)}
          >
            Clear
          </button>
        )}
        {onCancel && (
          <button
            type="button"
            className="text-[13px] text-muted hover:text-text"
            onClick={onCancel}
          >
            Cancel
          </button>
        )}
      </div>
      <p className="mt-1.5 text-[12px] text-faint">
        The all-in total from your last invoice. Saved on this assessment and
        used instead of list prices.
      </p>
      {error && <div className="mt-1.5 text-sm text-danger">{error}</div>}
    </form>
  );
}

const CMP_COLS = "grid-cols-[1.8fr_1fr_1fr_1fr_1fr_1fr]";

// Today against every target on the same five numbers. Sized targets carry
// the full comparison; unsized ones are listed so nothing is hidden, but they
// make no claim.
function ComparisonTable({
  report,
  onSpendSaved,
}: {
  report: MigrationOptionsReport;
  onSpendSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const spend = report.currentSpend;
  const known = spend.monthlyCents !== null;
  const toll = report.exitToll;
  const sized = report.options.filter((o) => o.sizing);
  const unsized = report.options.filter((o) => !o.sizing);
  const rate = sized.find((o) => o.ops)?.ops?.hourlyRateUsd;

  return (
    <Card className="mb-5">
      <CardTitle>Side by side</CardTitle>
      <p className="mb-4 max-w-[680px] text-[13px] leading-relaxed text-muted">
        Infra is what the provider bills. Ops is the operations work a target
        adds that you do not do today
        {rate !== undefined ? `, priced at $${rate}/hour` : ""}. Net is what
        you keep each month after both. The exit toll is paid once, and
        break-even is how long the net saving takes to repay it.
      </p>
      <div className="overflow-x-auto">
        <div className="min-w-[680px]">
          <TableHead cols={CMP_COLS}>
            <span>Stack</span>
            <span>Infra/mo</span>
            <span>Ops/mo</span>
            <span>Net/mo</span>
            <span>Exit toll</span>
            <span>Break-even</span>
          </TableHead>

          <TableRow cols={CMP_COLS}>
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="text-sm font-medium">
                Today on {PROVIDER_LABELS[report.provider]}
              </span>
              <Chip size="xs" tone={SOURCE_TONE[spend.source]}>
                {SOURCE_LABEL[spend.source]}
              </Chip>
            </div>
            <span className={`text-[15px] font-semibold ${NUM}`}>
              {known ? formatCents(spend.monthlyCents) : "unknown"}
              {known && !editing && (
                <button
                  type="button"
                  className="ml-2 text-[12px] font-normal text-muted hover:text-text"
                  onClick={() => setEditing(true)}
                >
                  {spend.source === "customer_reported" ? "edit" : "use your bill"}
                </button>
              )}
            </span>
            <span className="text-faint">{"\u2014"}</span>
            <span className="text-faint">{"\u2014"}</span>
            <span className="text-faint">{"\u2014"}</span>
            <span className="text-faint">{"\u2014"}</span>
          </TableRow>

          {(!known || editing) && (
            <SpendForm
              assessmentId={report.assessmentId}
              initialCents={
                spend.source === "customer_reported" ? spend.monthlyCents : null
              }
              canClear={spend.source === "customer_reported"}
              onSaved={() => {
                setEditing(false);
                onSpendSaved();
              }}
              onCancel={known ? () => setEditing(false) : undefined}
            />
          )}

          {sized.map((o) => {
            const net = o.netMonthlySavingsCents;
            return (
              <TableRow key={o.slug} cols={CMP_COLS}>
                <span className="text-sm font-medium">{o.name}</span>
                <span className={NUM}>{formatCents(o.sizing!.monthlyCents)}</span>
                <span className={NUM}>
                  {formatCents(o.ops?.monthlyCents)}
                  {o.ops && (
                    <span className="block text-[11px] text-faint">
                      {o.ops.hoursPerMonth} hr
                    </span>
                  )}
                </span>
                <span
                  className={`font-semibold ${NUM} ${net === null ? "text-faint" : net > 0 ? "text-accent" : "text-danger"}`}
                >
                  {net === null
                    ? "\u2014"
                    : `${net > 0 ? "+" : "-"}${formatCents(Math.abs(net))}`}
                </span>
                <span className={NUM}>
                  {formatCents(toll.centsAfterWaiver)}
                  {toll.waiverAvailable && toll.cents > 0 && (
                    <span className="block text-[11px] text-faint">
                      {formatCents(toll.cents)} waived
                    </span>
                  )}
                </span>
                <span className={NUM}>{breakEvenLabel(o, known)}</span>
              </TableRow>
            );
          })}

          {unsized.map((o) => (
            <TableRow key={o.slug} cols={CMP_COLS}>
              <span className="text-sm text-faint">{o.name}</span>
              <span className="col-span-5 text-[13px] text-faint">
                not sized &middot; catalog{" "}
                {formatCents(o.pricing.steadyStateMonthlyCents)}/mo, no comparison
                made
              </span>
            </TableRow>
          ))}
        </div>
      </div>
      {toll.waiverAvailable && toll.cents > 0 && (
        <p className="mt-3 text-[12px] text-faint">
          Break-even assumes you request the egress waiver your provider
          offers for migrations.
        </p>
      )}
    </Card>
  );
}

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
  spendKnown,
  onApprove,
}: {
  onApprove: (target: "cloudflare" | "hetzner") => void;
  option: MigrationOption;
  rank: number;
  assessmentId: string;
  spendKnown: boolean;
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
  // Net of the ops line, the same figure the comparison table and /estimate
  // show.
  const saves = option.netMonthlySavingsCents;

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
            saves {formatCents(saves)}/mo net
          </span>
        )}
        {saves !== null && saves <= 0 && (
          <span className={`ml-auto text-[15px] font-semibold text-warn ${NUM}`}>
            +{formatCents(-saves)}/mo vs today
          </span>
        )}
        {saves === null && option.sizing && !spendKnown && (
          <span className="ml-auto text-[13px] text-faint">
            enter your bill to compare
          </span>
        )}
        {saves === null && !option.sizing && (
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
          {option.ops && (
            <p className={`mb-3 text-[13px] text-muted ${NUM}`}>
              Plus {formatCents(option.ops.monthlyCents)}/mo of operations work
              ({option.ops.hoursPerMonth} hr at ${option.ops.hourlyRateUsd}/hr).{" "}
              {option.ops.note}
            </p>
          )}
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

  function load() {
    api<MigrationOptionsReport>(`/assessments/${id}/options`)
      .then(setReport)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }

  useEffect(load, [id]);

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

  // The API already ranks sized options first by net saving, so the top one
  // is the one whose number we can defend line by line.
  const best = report.options[0];
  const spend = report.currentSpend;
  const spendKnown = spend.monthlyCents !== null;
  // Only sized targets make a savings claim, and only against a known bill.
  const bestSavings = Math.max(
    0,
    ...report.options
      .map((o) => o.netMonthlySavingsCents)
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
          value={spendKnown ? `${formatCents(spend.monthlyCents)}/mo` : "unknown"}
          sub={SOURCE_DETAIL[spend.source]}
          tone={spendKnown ? "danger" : "muted"}
          center
        />
        <StatCard
          label="Best-fit target"
          value={best ? best.name : "—"}
          center
        />
        <StatCard
          label="Best net savings"
          value={spendKnown ? `${formatCents(bestSavings)}/mo` : "\u2014"}
          sub={
            spendKnown
              ? "after operations work"
              : "enter your bill below to compare"
          }
          center
        />
      </div>

      {report.options.length > 0 && (
        <ComparisonTable report={report} onSpendSaved={load} />
      )}

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
            spendKnown={spendKnown}
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
