"use client";

import { use, useEffect, useState } from "react";
import {
  PROVIDER_LABELS,
  type AssessmentCostProjectionRow,
  type AssessmentRecommendation,
  type AssessmentReport,
  type FindingCategory,
  type FindingSeverity,
  type PriceConfidence,
} from "@infralift/shared";
import { api, formatCents } from "../../../lib/api";
import {
  Card,
  CardTitle,
  Chip,
  NUM,
  Note,
  PrimaryButton,
  StatCard,
  TableHead,
  TableRow,
  type Tone,
} from "../../../components/ui";

/* The cost projection and recommendation now come from the API, derived from
 * the same options engine the migration options page uses, so the two pages
 * cannot disagree.
 *
 * The quote does not. Nothing generates a fixed fee: it is set by a human and
 * lives on the Migration record. This section stays skipped rather than
 * inventing a number, which is the same reason the other two were skipped
 * before they were wired up. */

/** /tf/codegen returns the whole configuration to an org cleared for
 * delivery, and a readable sample plus a manifest of what is withheld to
 * everyone else. */
interface CodegenLock {
  withheld: { fileName: string; lineCount: number }[];
  message: string;
}

interface CodegenResponse {
  locked?: boolean;
  files: { fileName: string; content: string }[];
  withheld?: { fileName: string; lineCount: number }[];
  message?: string;
}

interface ReportExtras {
  costProjection?: AssessmentCostProjectionRow[];
  recommendation?: AssessmentRecommendation;
  quote?: {
    fixedFeeCents: number;
    paybackMonths: number | null;
    lines: { phase: string; effort: string }[];
  };
}

const SEVERITY_TONE: Record<FindingSeverity, Tone> = {
  high: "danger",
  medium: "warn",
  low: "muted",
  info: "muted",
};

const CATEGORY_LABEL: Record<FindingCategory, string> = {
  inventory: "inventory",
  cost: "cost driver",
  risk: "lock-in / risk",
  iac_standard: "IaC standard",
  recommendation: "recommendation",
};

const CONFIDENCE_TONE: Record<PriceConfidence, Tone> = {
  invoiced: "muted",
  corroborated: "accent",
  advisor: "warn",
  anecdote: "muted",
  unverified: "faint",
};

const PROJ_COLS = "grid-cols-[2fr_1fr_1fr_1fr_130px]";
const FIND_COLS = "grid-cols-[90px_130px_1fr]";
const INV_COLS = "grid-cols-[160px_1fr_130px_110px]";

export default function AssessmentReportPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const [report, setReport] = useState<(AssessmentReport & ReportExtras) | null>(
    null
  );
  const [error, setError] = useState<string | null>(null);
  const [approving, setApproving] = useState(false);
  const [approved, setApproved] = useState(false);
  const [codegenTarget, setCodegenTarget] = useState<"cloudflare" | "hetzner">("cloudflare");
  const [codegenBackend, setCodegenBackend] = useState<"local" | "tfc" | "s3">("local");
  const [codegenFiles, setCodegenFiles] = useState<{ fileName: string; content: string }[] | null>(null);
  // Set when the org has not been cleared for delivery: `files` then holds a
  // sample rather than the configuration, and saying so is better than
  // rendering three files and letting someone think that is all there is.
  const [codegenLocked, setCodegenLocked] = useState<CodegenLock | null>(null);
  const [codegenBusy, setCodegenBusy] = useState(false);

  useEffect(() => {
    api<AssessmentReport & ReportExtras>(`/assessments/${id}`)
      .then(setReport)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    // Deep link from the options page: /assessments/:id?codegen=hetzner#codegen
    const target = new URLSearchParams(window.location.search).get("codegen");
    if (target === "cloudflare" || target === "hetzner") {
      setCodegenTarget(target);
    }
  }, [id]);

  async function approve() {
    if (!report) return;
    setApproving(true);
    try {
      await api("/migrations", {
        method: "POST",
        body: JSON.stringify({ assessmentId: report.id }),
      });
      setApproved(true);
      window.location.href = "/migrations";
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setApproving(false);
    }
  }

  async function runCodegen() {
    if (!report) return;
    setCodegenBusy(true);
    setCodegenFiles(null);
    setCodegenLocked(null);
    try {
      const result = await api<CodegenResponse>(
        "/tf/codegen",
        {
          method: "POST",
          body: JSON.stringify({
            assessmentId: report.id,
            backend: codegenBackend,
            migrationTarget: codegenTarget,
          }),
        }
      );
      setCodegenFiles(result.files);
      setCodegenLocked(
        result.locked
          ? { withheld: result.withheld ?? [], message: result.message ?? "" }
          : null
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCodegenBusy(false);
    }
  }

  if (error) return <div className="mt-2 text-sm text-danger">{error}</div>;
  if (!report) return <p className="text-muted">Loading report...</p>;

  const projection = report.costProjection ?? [];
  const inventory = report.inventory.slice(0, 8);
  const savings = report.estimatedMonthlySavingsCents ?? 0;
  const fee = report.quote?.fixedFeeCents ?? null;

  return (
    <>
      <div className="mb-2.5 text-[13px] text-muted">
        <a href="/assessments">Assessments</a> / {PROVIDER_LABELS[report.provider]}
      </div>
      <h1 className="mb-1.5 text-[26px] font-bold tracking-[-0.02em]">
        {PROVIDER_LABELS[report.provider]} assessment
      </h1>
      <p className="mb-6 text-muted">
        {report.completedAt
          ? `Completed ${new Date(report.completedAt).toLocaleString()}`
          : `Status: ${report.status}`}
      </p>

      <div className="mb-5 grid grid-cols-1 gap-4 md:grid-cols-3">
        <StatCard
          label="Resources inventoried"
          value={report.resourceCount}
          center
        />
        <StatCard
          label="Estimated monthly cost"
          value={formatCents(report.estimatedMonthlyCostCents)}
          tone="danger"
          center
        />
        <StatCard
          label="Estimated monthly savings"
          value={formatCents(report.estimatedMonthlySavingsCents)}
          center
        />
      </div>

      <div className="mb-5 flex items-center gap-4 rounded-xl border border-accent/20 bg-accent-dim/40 px-5 py-4">
        <div className="min-w-0">
          <div className="text-[15px] font-semibold">
            Where could this run instead?
          </div>
          <div className="text-[13px] text-muted">
            Ranked migration targets with estimated costs, sized from this
            inventory.
          </div>
        </div>
        <div className="ml-auto shrink-0">
          <PrimaryButton href={`/assessments/${report.id}/options`}>
            View migration options
          </PrimaryButton>
        </div>
      </div>

      {projection.length > 0 && (
        <Card className="mb-5">
          <CardTitle>Cost projection at three prices</CardTitle>
          <p className="mb-4 max-w-[640px] text-[13px] leading-relaxed text-muted">
            List is published pricing. Year-1 effective subtracts startup credits
            you actually qualify for, modeled with expiry windows and monthly
            caps. Steady state applies the best committed-spend discount your
            annual spend really reaches.
          </p>
          <TableHead cols={PROJ_COLS}>
            <span>Stack</span>
            <span>List</span>
            <span>Year-1 effective</span>
            <span>Steady state</span>
            <span>Confidence</span>
          </TableHead>
          {projection.map((r) => (
            <TableRow key={r.stack} cols={PROJ_COLS}>
              <div className="min-w-0">
                <div className="text-sm font-medium">{r.stack}</div>
                <div className="text-xs text-faint">{r.note}</div>
              </div>
              <span
                className={`text-[15px] font-semibold ${NUM} ${r.isCurrent ? "text-danger" : "text-text"}`}
              >
                {formatCents(r.listCents)}
              </span>
              <span className={`text-[15px] ${NUM}`}>
                {formatCents(r.year1Cents)}
              </span>
              <span className={`text-[15px] ${NUM}`}>
                {formatCents(r.steadyStateCents)}
              </span>
              <Chip tone={CONFIDENCE_TONE[r.confidence]} size="xs">
                {r.confidence}
              </Chip>
            </TableRow>
          ))}
          <div className="mt-4">
            <Note>
              Below roughly $1M/year of spend, enterprise discounts are not
              realistically negotiable. At your scale, changing architecture is
              the only discount that exists &mdash; which is usually why the
              migration pays for itself.
            </Note>
          </div>
        </Card>
      )}

      <Card className="mb-5">
        <CardTitle>Findings ({report.findings.length})</CardTitle>
        {report.findings.length === 0 ? (
          <p className="text-sm text-muted">No findings.</p>
        ) : (
          <>
            <TableHead cols={FIND_COLS}>
              <span>Severity</span>
              <span>Category</span>
              <span>Finding</span>
            </TableHead>
            {report.findings.map((f) => (
              <TableRow key={f.id} cols={FIND_COLS} align="start">
                <Chip tone={SEVERITY_TONE[f.severity]} size="xs">
                  {f.severity}
                </Chip>
                <span className="text-[13px] text-muted">
                  {CATEGORY_LABEL[f.category] ?? f.category}
                </span>
                <div>
                  <div className="mb-0.5 text-sm font-semibold">{f.title}</div>
                  <div className="text-[13px] leading-relaxed text-muted">
                    {f.detail}
                  </div>
                </div>
              </TableRow>
            ))}
          </>
        )}
      </Card>

      <Card className="mb-5">
        <CardTitle
          aside={
            report.inventory.length > inventory.length ? (
              <span className="text-xs text-faint">
                showing {inventory.length}
              </span>
            ) : null
          }
        >
          Inventory ({report.inventory.length})
        </CardTitle>
        {report.inventory.length === 0 ? (
          <p className="text-sm text-muted">No resources found.</p>
        ) : (
          <>
            <TableHead cols={INV_COLS}>
              <span>Type</span>
              <span>Name</span>
              <span>Region</span>
              <span>Monthly</span>
            </TableHead>
            {inventory.map((i, idx) => (
              <TableRow key={`${i.externalId}-${idx}`} cols={INV_COLS}>
                <span className="font-mono text-xs text-muted">{i.type}</span>
                <span>{i.name}</span>
                <span className="text-muted">{i.region ?? "\u2014"}</span>
                <span className={NUM}>{formatCents(i.monthlyCostCents)}</span>
              </TableRow>
            ))}
          </>
        )}
      </Card>

      <div id="codegen" />
      <Card className="mb-5">
        <CardTitle>Generate infrastructure as code</CardTitle>
        <p className="mb-4 text-[13px] leading-relaxed text-muted">
          Produce Terraform/OpenTofu configs that reproduce the discovered
          resources and include import blocks for adopting them into state.
          Optionally generates a migration target alongside the source.
        </p>

        <div className="mb-4 flex flex-wrap items-center gap-3">
          <div>
            <label className="block text-[11px] uppercase tracking-[0.06em] text-faint mb-1">
              Migration target
            </label>
            <select
              value={codegenTarget}
              onChange={(e) => setCodegenTarget(e.target.value as "cloudflare" | "hetzner")}
              className="bg-bg border border-border rounded-lg px-2.5 py-2 text-sm text-text focus:outline-none focus:border-accent"
            >
              <option value="cloudflare">Cloudflare Workers + Neon</option>
              <option value="hetzner">Hetzner VPS + Docker + Neon</option>
            </select>
          </div>
          <div>
            <label className="block text-[11px] uppercase tracking-[0.06em] text-faint mb-1">
              State backend
            </label>
            <select
              value={codegenBackend}
              onChange={(e) => setCodegenBackend(e.target.value as "local" | "tfc" | "s3")}
              className="bg-bg border border-border rounded-lg px-2.5 py-2 text-sm text-text focus:outline-none focus:border-accent"
            >
              <option value="local">Local state</option>
              <option value="tfc">Terraform Cloud</option>
              <option value="s3">S3 / Cloudflare R2</option>
            </select>
          </div>
          <div className="self-end">
            <PrimaryButton onClick={runCodegen} disabled={codegenBusy}>
              {codegenBusy ? "Generating..." : "Generate HCL"}
            </PrimaryButton>
          </div>
        </div>

        {codegenFiles && (
          <div className="space-y-3">
            <div className="text-[13px] text-muted">
              {codegenLocked
                ? codegenLocked.message
                : `${codegenFiles.length} files generated.`}{" "}
              Works with both{" "}
              <code className="rounded bg-bg px-1.5 py-0.5 text-xs">terraform</code> and{" "}
              <code className="rounded bg-bg px-1.5 py-0.5 text-xs">tofu</code>.
            </div>
            {codegenFiles.filter(f => f.fileName !== "README.md").map((f) => (
              <details key={f.fileName} className="rounded-lg border border-border bg-bg">
                <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-text hover:text-accent">
                  {f.fileName}
                </summary>
                <pre className="overflow-x-auto border-t border-border p-3 text-xs leading-relaxed text-muted">
                  {f.content}
                </pre>
              </details>
            ))}
            {codegenLocked && codegenLocked.withheld.length > 0 && (
              <div className="rounded-lg border border-border bg-bg p-3">
                <div className="mb-2 text-[13px] font-semibold text-text">
                  Included in the migration
                </div>
                <div className="space-y-1">
                  {codegenLocked.withheld.map((w) => (
                    <div
                      key={w.fileName}
                      className="flex items-center justify-between text-xs text-faint"
                    >
                      <code>{w.fileName}</code>
                      <span>{w.lineCount} lines</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </Card>

      {(report.recommendation || report.quote) && (
        <div className="grid grid-cols-1 items-start gap-5 md:grid-cols-2">
          {report.recommendation && (
            <Card>
              <CardTitle>Recommendation</CardTitle>
              <p className="mb-3.5 text-sm leading-relaxed text-muted">
                {report.recommendation.summary}
              </p>
              <div className="flex flex-col gap-2">
                {report.recommendation.rows.map((r) => (
                  <div
                    key={r.label}
                    className="flex items-center gap-2 rounded-md bg-bg px-2.5 py-2 text-[13px]"
                  >
                    <span className="text-muted">{r.label}</span>
                    <span className="ml-auto text-text">{r.value}</span>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {report.quote && fee !== null && (
            <div className="rounded-xl border border-accent/20 bg-accent-dim/40 p-6">
              <h3 className="mb-2.5 text-[15px] font-semibold">
                Fixed-fee quote
              </h3>
              <div
                className={`mb-0.5 text-[38px] font-bold tracking-[-0.02em] ${NUM}`}
              >
                {formatCents(fee)}
              </div>
              <div className="mb-4 text-[13px] text-muted">
                fixed
                {report.quote.paybackMonths != null && savings > 0 && (
                  <>
                    {" "}
                    &middot; payback in {report.quote.paybackMonths} months on{" "}
                    {formatCents(savings)}/mo saved
                  </>
                )}
              </div>
              <div className="mb-4.5 flex flex-col">
                {report.quote.lines.map((q) => (
                  <div
                    key={q.phase}
                    className="flex border-t border-accent/15 py-2 text-[13px] text-muted"
                  >
                    <span>{q.phase}</span>
                    <span className={`ml-auto text-text ${NUM}`}>
                      {q.effort}
                    </span>
                  </div>
                ))}
              </div>
              <PrimaryButton onClick={approve} disabled={approving} full>
                {approved
                  ? "Quote approved \u2014 view migration"
                  : approving
                    ? "Approving\u2026"
                    : `Approve ${formatCents(fee)} fixed fee`}
              </PrimaryButton>
              <p className="mt-3 text-xs leading-relaxed text-muted">
                The price in the report is the price you pay. No hourly billing,
                no scope creep.
              </p>
            </div>
          )}
        </div>
      )}
    </>
  );
}
