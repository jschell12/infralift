// Shared types for infralift — used by api, dashboard, and web.

export const PROVIDERS = [
  "vercel",
  "cloudflare",
  "heroku",
  "aws",
  "firebase",
  "github",
  "gitlab",
  "netlify",
  "render",
  "railway",
  "flyio",
  "digitalocean",
  "gcp",
  "azure",
] as const;
export type Provider = (typeof PROVIDERS)[number];

/** Providers that host code. They are destinations (infralift creates repos
 *  and opens pull or merge requests there), not assessment sources. */
export const GIT_HOSTS = ["github", "gitlab"] as const;
export type GitHost = (typeof GIT_HOSTS)[number];
export const isGitHost = (p: string): p is GitHost =>
  (GIT_HOSTS as readonly string[]).includes(p);

export const PROVIDER_LABELS: Record<Provider, string> = {
  vercel: "Vercel",
  cloudflare: "Cloudflare",
  heroku: "Heroku",
  aws: "AWS",
  firebase: "Firebase / GCP",
  github: "GitHub",
  gitlab: "GitLab",
  netlify: "Netlify",
  render: "Render",
  railway: "Railway",
  flyio: "Fly.io",
  digitalocean: "DigitalOcean",
  gcp: "Google Cloud",
  azure: "Microsoft Azure",
};

export type AssessmentStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed";

export type MigrationStatus =
  | "proposed"
  | "approved"
  | "in_progress"
  | "verifying"
  | "completed"
  | "cancelled";

export type FindingSeverity = "info" | "low" | "medium" | "high";

export type FindingCategory =
  | "inventory"
  | "cost"
  | "risk"
  | "iac_standard"
  | "recommendation";

export interface ProviderConnectionSummary {
  id: string;
  provider: Provider;
  label: string;
  createdAt: string;
  lastVerifiedAt: string | null;
  status: "unverified" | "valid" | "invalid";
  /** Why the connection is invalid; null when it is not. */
  lastError: string | null;
  /** When the provider says the credential expires; null when unknown. */
  expiresAt: string | null;
}

export interface ResourceInventoryItem {
  provider: Provider;
  /** Provider-specific resource type, e.g. "vercel:project", "heroku:dyno" */
  type: string;
  externalId: string;
  name: string;
  region?: string;
  /** Monthly cost estimate in USD cents, if derivable */
  monthlyCostCents?: number;
  metadata?: Record<string, unknown>;
}

export interface AssessmentFinding {
  id: string;
  category: FindingCategory;
  severity: FindingSeverity;
  title: string;
  detail: string;
  /** Estimated monthly savings in USD cents, when category is "cost" */
  monthlySavingsCents?: number;
  resourceRef?: string;
}

export interface AssessmentSummary {
  id: string;
  provider: Provider;
  status: AssessmentStatus;
  startedAt: string | null;
  completedAt: string | null;
  resourceCount: number;
  /** the inventory at published list prices, as the connector priced it */
  estimatedMonthlyCostCents: number | null;
  /** today's bill as the comparison uses it: the customer's own figure, else
   *  the list-price estimate, else unknown */
  currentSpend: CurrentSpend;
  /** the best sized target's net monthly saving after operations work, from
   *  the same comparison the options page makes. Null when the bill is
   *  unknown or no target is sized; negative when staying put is cheaper */
  netMonthlySavingsCents: number | null;
  findingCounts: Record<FindingSeverity, number>;
  /** the connection it was run against; null for an uploaded snapshot. Reruns
   *  of one connection share it, which is how org totals keep only the latest */
  connectionId: string | null;
}

export interface AssessmentReport extends AssessmentSummary {
  inventory: ResourceInventoryItem[];
  findings: AssessmentFinding[];
}

// -- Migration options (GET /assessments/:id/options) ------------------------

/** One workload trait inferred from the assessment inventory. */
export interface InferredNeed {
  key: string; // capability key, e.g. "managed_postgres"
  label: string; // human label, e.g. "Managed Postgres"
  evidence: string; // which inventory item(s) implied it
}

export interface OptionPricing {
  listMonthlyCents: number;
  year1MonthlyCents: number;
  steadyStateMonthlyCents: number;
  applied: { name: string; kind: string; confidence: string; detail: string }[];
}

/** A companion service that covers a capability the main target lacks. */
export interface CompanionSuggestion {
  name: string;
  covers: string; // capability key it fills
  monthlyCents: number;
  note: string;
}

/** One line of a workload-sized cost estimate. Zero-cost lines are the
 * point — "$0 egress" is the argument for leaving. */
export interface SizingLineItem {
  label: string;
  monthlyCents: number;
  note?: string;
}

export interface OptionSizing {
  lineItems: SizingLineItem[];
  /** all-in sized monthly total (companions folded in) */
  monthlyCents: number;
  /** corroborated | advisor | anecdote — how solid the price table is */
  confidence: string;
}

/** Net-new operations work a target adds each month, priced at an hourly
 * rate. The same shape the public estimator returns, so the two agree. */
export interface OpsBurden {
  hoursPerMonth: number;
  monthlyCents: number;
  hourlyRateUsd: number;
  note: string;
}

/** Where today's monthly figure came from. A number the customer typed from
 * their bill beats one we priced from the inventory at published rates, and
 * either beats a guess; "unknown" means no claim is made against it. */
export type CurrentSpendSource =
  | "customer_reported"
  | "inventory_list_price"
  | "unknown";

export interface CurrentSpend {
  /** null when the provider exposes no billing and the customer has not said */
  monthlyCents: number | null;
  source: CurrentSpendSource;
}

export interface MigrationOption {
  slug: string;
  name: string;
  category: string;
  score: number;
  pricing: OptionPricing;
  /** workload-sized estimate; null when this target has no sizing model */
  sizing: OptionSizing | null;
  /** infrastructure-only savings vs current spend, before the ops line; null
   *  when the target is unsized or current spend is unknown (no claim beats
   *  an absurd claim) */
  monthlySavingsCents: number | null;
  /** operations work the target adds; null for unsized targets */
  ops: OpsBurden | null;
  /** gross savings minus the ops line. The number that means something. */
  netMonthlySavingsCents: number | null;
  /** months for the net savings to repay the one-off exit toll (after any
   *  waiver). 0 when there is no toll; null when nothing is saved or spend
   *  is unknown */
  breakEvenMonths: number | null;
  /** twelve months of net savings minus the exit toll */
  firstYearNetCents: number | null;
  benefits: string;
  drawbacks: string;
  managedLevel: number;
  companions: CompanionSuggestion[];
  /** capability keys the workload needs that this target covers weakly */
  gaps: string[];
  /** value for POST /tf/codegen migrationTarget, when supported */
  codegenTarget: "cloudflare" | "hetzner" | null;
}

/** How much to trust a price. "reported" is the bill the customer entered;
 * "list_price" is the assessed inventory at published rates, which is not the
 * account's invoice. Everything below that is modelled, and the report says
 * which. Nothing here reads a billing API, so nothing claims "invoiced". */
export type PriceConfidence =
  | "reported"
  | "list_price"
  | "corroborated"
  | "advisor"
  | "anecdote"
  | "unverified";

export interface AssessmentCostProjectionRow {
  stack: string;
  note: string;
  listCents: number | null;
  year1Cents: number | null;
  steadyStateCents: number | null;
  confidence: PriceConfidence;
  sourceDate?: string;
  /** the stack being migrated away from */
  isCurrent?: boolean;
  /** on the current row: where its number came from */
  source?: CurrentSpendSource;
}

export interface AssessmentRecommendation {
  target: string;
  summary: string;
  rows: { label: string; value: string }[];
  /** the recommended target's sized net savings (after ops); null when it is
   *  unsized or current spend is unknown */
  netMonthlySavingsCents: number | null;
}

/** Who does a step. A flat fee only survives if this is explicit, and half of
 * these steps genuinely cannot be done by us: nobody hands a vendor their
 * registrar login or their secret values. */
export type MigrationStepOwner = "infralift" | "customer" | "shared";

/** Where a step sits in the sequence. The UI gates on this: nothing in
 * "cutover" is actionable until every "prepare" step is done, which is the
 * whole point of writing the plan down. */
export type MigrationPlanPhase = "prepare" | "cutover" | "verify" | "decommission";

export interface MigrationPlanStep {
  /** Stable across regenerations of the same assessment, so progress through
   * the plan can be recorded against it. */
  id: string;
  title: string;
  detail: string;
  owner: MigrationStepOwner;
  phase: MigrationPlanPhase;
  /** True where we could confirm this ourselves rather than asking the
   * customer to tick a box — DNS propagation, TTL, a response diff against
   * production, certificate validity. Marks the steps worth automating first,
   * and keeps honest the difference between "verified" and "asserted". */
  automatable: boolean;
  /** Which inventory item implied this step, so the plan is auditable rather
   * than a template with the customer's name pasted in. */
  evidence?: string;
}

export type MigrationPlanArea =
  | "data"
  | "dns"
  | "secrets"
  | "cicd"
  | "rollback"
  | "verification";

export interface MigrationPlanSection {
  area: MigrationPlanArea;
  title: string;
  summary: string;
  steps: MigrationPlanStep[];
  /** Expected write freeze or unavailability, where it is derivable from the
   * inventory. Null when nothing in the assessment implies one. Never an
   * estimate of how long the engagement takes. */
  downtime: string | null;
  risks: string[];
}

export interface MigrationPlan {
  target: string;
  /** The moment rollback stops being free, stated once and prominently. */
  pointOfNoReturn: string;
  sections: MigrationPlanSection[];
  /** What this plan does not cover. Present so the plan cannot be read as a
   * complete statement of work. */
  notCovered: string[];
}

export interface ExitTollComponent {
  label: string;
  gb: number;
  centsPerGb: number;
  cents: number;
  /** true when the volume came from the provider's API, not a plan tier */
  measured: boolean;
  note: string;
}

/** One-time cost of moving stored data off the source provider. Distinct from
 * the monthly egress line, which is serving traffic and stops at cutover. */
export interface ExitTollEstimate {
  cents: number;
  centsAfterWaiver: number;
  totalGb: number;
  components: ExitTollComponent[];
  waiverAvailable: boolean;
  waiverNote: string | null;
  confidence: "measured" | "estimated" | "none";
  notes: string[];
}

export interface MigrationOptionsReport {
  assessmentId: string;
  provider: Provider;
  currentSpend: CurrentSpend;
  needs: InferredNeed[];
  profile: {
    runtime: string;
    requiredCapabilities: string[];
    budgetMonthlyCents: number;
    trafficGbMonth: number;
  };
  /** what it costs once to get the data out, before any target is chosen */
  exitToll: ExitTollEstimate;
  options: MigrationOption[];
  /** per-workload costs; empty when the connector models no workloads */
  workloads: WorkloadCost[];
  /** what no single workload owns: shared databases, add-ons, platform fees */
  workloadsShared: WorkloadShared | null;
  /** why the workload rows do not add up to the totals, when they do not */
  workloadsNote: string | null;
  /** ISO date the sizing and exit-toll price tables were last checked */
  pricesVerifiedAt: string;
}

export interface WorkloadTargetCost {
  slug: string;
  monthlyCents: number;
}

/** One app or service as the connector models it, priced on its own. */
export interface WorkloadCost {
  name: string;
  /** e.g. "Heroku app", "Render service" */
  kind: string;
  /** at connector list prices, never the reported bill; null when unpriced */
  currentMonthlyCents: number | null;
  /** each sized target, sized on this workload's footprint alone */
  targets: WorkloadTargetCost[];
}

export interface WorkloadShared {
  /** inventory items no workload owns */
  items: string[];
  /** list-price total minus the workloads; null when the total is unknown */
  currentMonthlyCents: number | null;
  /** the data services the shared items size to on each target */
  targets: WorkloadTargetCost[];
}

/** The org-wide headline: one assessment per connection (the latest completed
 *  rerun), each at its resolved current spend. Unknown bills are counted, not
 *  summed as zero. */
export function orgSpendTotals(assessments: AssessmentSummary[]): {
  counted: AssessmentSummary[];
  knownMonthlyCents: number;
  unknownCount: number;
} {
  const latest = new Map<string, AssessmentSummary>();
  const counted: AssessmentSummary[] = [];
  for (const a of assessments) {
    if (a.status !== "completed") continue;
    // An uploaded snapshot has no connection to be a rerun of.
    if (a.connectionId === null) {
      counted.push(a);
      continue;
    }
    const prev = latest.get(a.connectionId);
    if (!prev || (a.completedAt ?? "") > (prev.completedAt ?? "")) {
      latest.set(a.connectionId, a);
    }
  }
  counted.push(...latest.values());
  counted.sort((x, y) => (y.completedAt ?? "").localeCompare(x.completedAt ?? ""));
  let knownMonthlyCents = 0;
  let unknownCount = 0;
  for (const a of counted) {
    if (a.currentSpend.monthlyCents === null) unknownCount += 1;
    else knownMonthlyCents += a.currentSpend.monthlyCents;
  }
  return { counted, knownMonthlyCents, unknownCount };
}

export interface MigrationPhase {
  key: string;
  title: string;
  status: "pending" | "in_progress" | "completed" | "blocked";
  completedAt: string | null;
  notes?: string;
}

export interface MigrationSummary {
  id: string;
  status: MigrationStatus;
  sourceProvider: Provider;
  targetPlatform: "cloudflare" | "vps";
  fixedFeeCents: number | null;
  repoUrl: string | null;
  tfcOrg: string | null;
  phases: MigrationPhase[];
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  tfcWorkspaceUrl: string | null;
  driftDetected: boolean;
  lastRunStatus: string | null;
  lastRunAt: string | null;
}

export interface IacStandardCheck {
  key: string;
  title: string;
  description: string;
  status: "pass" | "fail" | "warn" | "not_applicable";
  detail?: string;
}

export interface ApiError {
  error: string;
  detail?: string;
}

export * from "./imports.js";
export * from "./projects.js";
