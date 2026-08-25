// Shared types for infralift — used by api, dashboard, and web.

export const PROVIDERS = [
  "vercel",
  "cloudflare",
  "heroku",
  "aws",
  "firebase",
  "github",
] as const;
export type Provider = (typeof PROVIDERS)[number];

export const PROVIDER_LABELS: Record<Provider, string> = {
  vercel: "Vercel",
  cloudflare: "Cloudflare",
  heroku: "Heroku",
  aws: "AWS",
  firebase: "Firebase / GCP",
  github: "GitHub",
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
