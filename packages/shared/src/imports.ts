// Types for importing existing Terraform: what a repository scan finds in a
// root module, and what the import check said. Produced by the API
// (apps/api/src/lib/import), shown by the dashboard.

export type BackendKind = "s3" | "r2" | "gcs" | "azurerm" | "tfc" | "local" | "other";

export interface Backend {
  kind: BackendKind;
  /** The block's own type: s3, gcs, remote, cloud, ... ; null = none declared. */
  type: string | null;
  /** String settings from the block (bucket, key, region, prefix, ...). */
  settings: Record<string, string>;
  /** Settings come partly from -backend-config at init time. */
  partial: boolean;
  /** Candidate -backend-config files found beside the module. */
  configFiles: string[];
}

export interface ScannedProvider {
  name: string;
  source: string;
  version: string | null;
}

export type Readiness = "ready" | "adopt-tfc" | "blocked";

export interface RootModule {
  path: string;
  backend: Backend;
  providers: ScannedProvider[];
  resources: number;
  dataSources: number;
  moduleCalls: number;
  resourceTypes: Record<string, number>;
  /** Input variables with no default and no value in an auto-loaded tfvars file. */
  requiredVariables: string[];
  /** Environment variables the plan check needs for the backend and providers. */
  credentials: string[];
  tool: "terraform" | "tofu";
  readiness: Readiness;
  notes: string[];
  /** Adopted from a cloud account: the check generates the resource code
   *  (plan -generate-config-out) before holding it to zero changes. */
  generateConfig?: boolean;
}

export type ImportCheckState =
  /** No pull request recorded yet: the import job has not opened it. */
  | "no-pr"
  /** Opened, but no run of the check yet (Actions disabled, or queued behind others). */
  | "waiting"
  | "running"
  /** The plan changed nothing: safe to take over. */
  | "passed"
  /** The plan would change resources. */
  | "changes"
  /** Credentials or variables are not set. */
  | "needs-setup"
  /** The plan errored before it could compare. */
  | "error"
  /** Cancelled, timed out, or failed in a way the check did not explain. */
  | "failed";

export interface ImportCheckResult {
  state: ImportCheckState;
  /** One line for the dashboard, from the check's own annotation when there is one. */
  message: string;
  prUrl: string | null;
  prState: "open" | "closed" | "merged" | null;
  checkUrl: string | null;
  headSha: string | null;
  checkedAt: string;
}

