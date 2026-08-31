// Shared types for infralift — used by api, dashboard, and web.

export const PROVIDERS = [
  "vercel",
  "cloudflare",
  "heroku",
  "aws",
  "firebase",
  "github",
  "netlify",
  "render",
  "railway",
  "flyio",
  "digitalocean",
  "gcp",
  "azure",
] as const;
export type Provider = (typeof PROVIDERS)[number];

export const PROVIDER_LABELS: Record<Provider, string> = {
  vercel: "Vercel",
  cloudflare: "Cloudflare",
  heroku: "Heroku",
  aws: "AWS",
  firebase: "Firebase / GCP",
  github: "GitHub",
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
  estimatedMonthlyCostCents: number | null;
  estimatedMonthlySavingsCents: number | null;
  findingCounts: Record<FindingSeverity, number>;
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

export interface MigrationOption {
  slug: string;
  name: string;
  category: string;
  score: number;
  pricing: OptionPricing;
  /** workload-sized estimate; null when this target has no sizing model */
  sizing: OptionSizing | null;
  /** steady-state savings vs assessed spend; null when the target is unsized
   *  (no claim beats an absurd claim) */
  monthlySavingsCents: number | null;
  benefits: string;
  drawbacks: string;
  managedLevel: number;
  companions: CompanionSuggestion[];
  /** capability keys the workload needs that this target covers weakly */
  gaps: string[];
  /** value for POST /tf/codegen migrationTarget, when supported */
  codegenTarget: "cloudflare" | "hetzner" | null;
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
  currentMonthlyCents: number;
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
