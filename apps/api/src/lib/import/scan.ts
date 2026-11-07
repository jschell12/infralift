import { HclParseError, parseHcl, type HclBlock, type HclBody } from "./hcl.js";
import { isSafeEnvName, isSafePath } from "./check.js";

// ---------------------------------------------------------------------------
// Import scan: what a customer's Terraform repository holds, read statically.
//
// For each root module (a directory Terraform is run in, rather than one
// called as a module) it reports where state lives, which providers are used,
// how much it declares, and what the plan check needs to run: the credential
// and variable names the customer sets as CI secrets. infralift reads the
// code only. It never reads the state or holds the credentials.
// ---------------------------------------------------------------------------

export interface RepoFile {
  path: string;
  content: string;
}

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
}

export interface ScanResult {
  roots: RootModule[];
  /** Files that would not parse. Their directory is scanned without them. */
  errors: { path: string; message: string }[];
}

/** Files a scan reads. Everything else in the repository is skipped. */
export function isScanFile(path: string): boolean {
  if (/(^|\/)\.terraform\//.test(path)) return false;
  const base = path.split("/").pop()!;
  return (
    base.endsWith(".tf") ||
    base.endsWith(".tfvars") ||
    base.endsWith(".tfbackend") ||
    base === ".terraform.lock.hcl" ||
    base === ".terraform-version" ||
    base === ".opentofu-version" ||
    /^backend.*\.hcl$/.test(base)
  );
}

const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const baseOf = (p: string) => p.split("/").pop()!;

/** a/b + ../c = a/c. Null when it climbs out of the repository. */
export function joinPath(dir: string, rel: string): string | null {
  const parts = dir ? dir.split("/") : [];
  for (const seg of rel.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join("/");
}

// Environment variables each backend and provider reads its credentials from.
// The plan check passes CI secrets of the same names through.
const BACKEND_ENV: Partial<Record<BackendKind, string[]>> = {
  s3: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"],
  // R2 keys are not AWS keys. The check hands them to init only, so an aws
  // provider in the same module can still use AWS credentials.
  r2: ["R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"],
  gcs: ["GOOGLE_CREDENTIALS"],
  azurerm: ["ARM_CLIENT_ID", "ARM_CLIENT_SECRET", "ARM_TENANT_ID", "ARM_SUBSCRIPTION_ID"],
};

const PROVIDER_ENV: Record<string, string[]> = {
  aws: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"],
  google: ["GOOGLE_CREDENTIALS"],
  "google-beta": ["GOOGLE_CREDENTIALS"],
  azurerm: ["ARM_CLIENT_ID", "ARM_CLIENT_SECRET", "ARM_TENANT_ID", "ARM_SUBSCRIPTION_ID"],
  hcloud: ["HCLOUD_TOKEN"],
  cloudflare: ["CLOUDFLARE_API_TOKEN"],
  digitalocean: ["DIGITALOCEAN_TOKEN"],
  github: ["GITHUB_TOKEN"],
  gitlab: ["GITLAB_TOKEN"],
  tfe: ["TFE_TOKEN"],
  neon: ["NEON_API_KEY"],
  vercel: ["VERCEL_API_TOKEN"],
  datadog: ["DD_API_KEY", "DD_APP_KEY"],
  vault: ["VAULT_ADDR", "VAULT_TOKEN"],
};

// Providers that need nothing from the environment.
const NO_CREDENTIALS = new Set([
  "random", "null", "local", "tls", "time", "archive", "external", "http", "template", "cloudinit",
]);

interface DirInfo {
  files: { path: string; body: HclBody }[];
  tfvars: { path: string; body: HclBody }[];
  other: string[];
}

export function scanRepo(input: RepoFile[]): ScanResult {
  const errors: ScanResult["errors"] = [];
  const dirs = new Map<string, DirInfo>();
  const dir = (d: string) => {
    let info = dirs.get(d);
    if (!info) dirs.set(d, (info = { files: [], tfvars: [], other: [] }));
    return info;
  };
  const byPath = new Map(input.map((f) => [f.path, f.content]));

  for (const f of input) {
    if (!isScanFile(f.path)) continue;
    const d = dirOf(f.path);
    const base = baseOf(f.path);
    if (base.endsWith(".tf") || base.endsWith(".tfvars")) {
      let body: HclBody;
      try {
        body = parseHcl(f.content);
      } catch (err) {
        if (!(err instanceof HclParseError)) throw err;
        errors.push({ path: f.path, message: err.message });
        continue;
      }
      if (base.endsWith(".tf")) dir(d).files.push({ path: f.path, body });
      else dir(d).tfvars.push({ path: f.path, body });
    } else {
      dir(d).other.push(f.path);
    }
  }

  // Directories some other directory calls as a local module are not roots.
  const called = new Set<string>();
  for (const [d, info] of dirs) {
    for (const f of info.files) {
      for (const b of f.body.blocks) {
        const src = b.type === "module" ? b.body.attrs.source?.str : undefined;
        if (src && (src.startsWith("./") || src.startsWith("../"))) {
          const target = joinPath(d, src);
          if (target !== null) called.add(target);
        }
      }
    }
  }

  const roots: RootModule[] = [];
  for (const [d, info] of [...dirs].sort(([a], [b]) => a.localeCompare(b))) {
    if (!info.files.length) continue;
    const blocks = info.files.flatMap((f) => f.body.blocks);
    const terraformBlocks = blocks.filter((b) => b.type === "terraform");
    const backendBlock = terraformBlocks
      .flatMap((t) => t.body.blocks)
      .find((b) => b.type === "backend" || b.type === "cloud");
    const resources = blocks.filter((b) => b.type === "resource");
    const moduleCalls = blocks.filter((b) => b.type === "module").length;
    // A root declares something, and either has a backend or is called by
    // nobody. A backend with nothing under it (a retired workspace, a
    // directory of alternative backend files) has nothing to import.
    if (resources.length === 0 && moduleCalls === 0) continue;
    if (!backendBlock && called.has(d)) continue;
    roots.push(scanRoot(d, info, blocks, terraformBlocks, backendBlock ?? null, byPath, dirs));
  }
  return { roots, errors };
}

function scanRoot(
  path: string,
  info: DirInfo,
  blocks: HclBlock[],
  terraformBlocks: HclBlock[],
  backendBlock: HclBlock | null,
  byPath: Map<string, string>,
  dirs: Map<string, DirInfo>
): RootModule {
  const notes: string[] = [];
  const backend = readBackend(backendBlock, info);
  const inlineSecrets = BACKEND_SECRET_KEYS.filter((k) => backendBlock && k in backendBlock.body.attrs);
  if (inlineSecrets.length) {
    notes.push(
      `The backend block sets ${inlineSecrets.join(", ")} in the code. Move ${inlineSecrets.length > 1 ? "them" : "it"} to CI secrets and rotate ${inlineSecrets.length > 1 ? "them" : "it"}: anything committed is in the repository's history.`
    );
  }

  // Providers: required_providers entries, then any provider block not listed.
  const providers = new Map<string, ScannedProvider>();
  for (const t of terraformBlocks) {
    for (const rp of t.body.blocks.filter((b) => b.type === "required_providers")) {
      for (const [name, attr] of Object.entries(rp.body.attrs)) {
        const source = attr.str ?? /source\s*=\s*"([^"]+)"/.exec(attr.raw)?.[1] ?? `hashicorp/${name}`;
        const version = /version\s*=\s*"([^"]+)"/.exec(attr.raw)?.[1] ?? null;
        providers.set(name, { name, source, version });
      }
    }
  }
  for (const b of blocks) {
    if (b.type === "provider" && b.labels[0] && !providers.has(b.labels[0])) {
      providers.set(b.labels[0], { name: b.labels[0], source: `hashicorp/${b.labels[0]}`, version: null });
    }
  }
  // Resource types imply their provider when nothing declared it. Local
  // modules the root calls count as its own: their resources live in its state.
  const resourceTypes: Record<string, number> = {};
  let resources = 0;
  let dataSources = 0;
  for (const b of [...blocks, ...localModuleBlocks(path, blocks, dirs)]) {
    if (b.type !== "resource" && b.type !== "data") continue;
    if (b.type === "resource") {
      resources++;
      const t = b.labels[0] ?? "unknown";
      resourceTypes[t] = (resourceTypes[t] ?? 0) + 1;
    } else dataSources++;
    const prefix = (b.labels[0] ?? "").split("_")[0];
    if (prefix && prefix !== "terraform" && !providers.has(prefix)) {
      providers.set(prefix, { name: prefix, source: `hashicorp/${prefix}`, version: null });
    }
  }

  // Variables the plan cannot get from the repository itself.
  const assigned = new Set<string>();
  for (const tv of info.tfvars) {
    const base = baseOf(tv.path);
    if (base === "terraform.tfvars" || base.endsWith(".auto.tfvars")) {
      for (const k of Object.keys(tv.body.attrs)) assigned.add(k);
    }
  }
  const requiredVariables = blocks
    .filter((b) => b.type === "variable" && b.labels[0] && !("default" in b.body.attrs))
    .map((b) => b.labels[0])
    .filter((n) => !assigned.has(n))
    .sort();

  // Credentials: the backend's, then each provider's.
  const creds = new Set<string>(BACKEND_ENV[backend.kind] ?? []);
  const unknownProviders: string[] = [];
  for (const p of providers.values()) {
    const env = PROVIDER_ENV[p.source.split("/").pop()!] ?? PROVIDER_ENV[p.name];
    if (env) env.forEach((e) => creds.add(e));
    else if (!NO_CREDENTIALS.has(p.name)) unknownProviders.push(p.name);
  }
  if (unknownProviders.length) {
    notes.push(
      `Provider${unknownProviders.length > 1 ? "s" : ""} ${unknownProviders.join(", ")}: add whatever credentials ${unknownProviders.length > 1 ? "they read" : "it reads"} to the check's env block.`
    );
  }

  // Which binary: OpenTofu if the repository says so, otherwise Terraform.
  const lock = byPath.get(path ? `${path}/.terraform.lock.hcl` : ".terraform.lock.hcl") ?? "";
  const tofu =
    info.other.some((p) => baseOf(p) === ".opentofu-version") ||
    /registry\.opentofu\.org\//.test(lock);

  let readiness: Readiness;
  switch (backend.kind) {
    case "s3":
    case "r2":
    case "gcs":
    case "azurerm":
      readiness = "ready";
      break;
    case "tfc":
      readiness = "adopt-tfc";
      notes.push("State is in Terraform Cloud: adopt the workspace from a TFC connection instead.");
      break;
    case "local":
      readiness = "blocked";
      notes.push(
        "No remote backend: state lives on whichever machine last ran apply. Move it to S3, R2 or GCS first, then import."
      );
      break;
    default:
      readiness = "blocked";
      notes.push(`The ${backend.type} backend is not supported for import yet.`);
  }
  const badVariables = requiredVariables.filter((v) => !isSafeEnvName(`TF_VAR_${v}`));
  if (readiness === "ready" && badVariables.length) {
    readiness = "blocked";
    notes.push(
      `Variable name${badVariables.length > 1 ? "s" : ""} ${badVariables.map((v) => JSON.stringify(v)).join(", ")} ${badVariables.length > 1 ? "are" : "is"} not valid in Terraform (letters, digits, underscores and dashes, starting with a letter or underscore). Terraform will not plan this module until ${badVariables.length > 1 ? "they are" : "it is"} renamed.`
    );
  }
  if (readiness === "ready" && !isSafePath(path)) {
    readiness = "blocked";
    notes.push(
      "The directory name has characters other than letters, digits, dot, dash, underscore and slash. Rename it to import it."
    );
  }
  if (backend.partial && readiness === "ready") {
    if (backend.configFiles.length === 1) {
      notes.push(`Backend settings come from ${backend.configFiles[0]}; the check passes it to init.`);
    } else if (backend.configFiles.length > 1) {
      notes.push(
        `Backend settings are partial and there are ${backend.configFiles.length} config files (${backend.configFiles.join(", ")}). Pick one as the backend config file.`
      );
    } else {
      readiness = "blocked";
      notes.push(
        "The backend block is partial and no backend config file is checked in. Commit one (without secrets) so the check can init."
      );
    }
  }

  return {
    path,
    backend,
    providers: [...providers.values()].sort((a, b) => a.name.localeCompare(b.name)),
    resources,
    dataSources,
    moduleCalls: blocks.filter((b) => b.type === "module").length,
    resourceTypes,
    requiredVariables,
    credentials: [...creds].sort(),
    tool: tofu ? "tofu" : "terraform",
    readiness,
    notes,
  };
}

const BACKEND_SETTING_KEYS = new Set([
  "bucket", "key", "region", "prefix", "workspace_key_prefix", "dynamodb_table", "use_lockfile",
  "encrypt", "endpoint", "storage_account_name", "container_name", "resource_group_name",
  "organization", "hostname",
]);

/** Backend arguments that hold a credential when set inline. */
export const BACKEND_SECRET_KEYS = [
  "access_key", "secret_key", "token", "credentials", "access_token", "client_secret", "sas_token",
];

/** Blocks of every local module `blocks` calls, recursively, once per call. */
function localModuleBlocks(
  dir: string,
  blocks: HclBlock[],
  dirs: Map<string, DirInfo>,
  seen: string[] = [dir]
): HclBlock[] {
  const out: HclBlock[] = [];
  for (const b of blocks) {
    const src = b.type === "module" ? b.body.attrs.source?.str : undefined;
    if (!src || !(src.startsWith("./") || src.startsWith("../"))) continue;
    const target = joinPath(dir, src);
    if (target === null || seen.includes(target)) continue;
    const inner = (dirs.get(target)?.files ?? []).flatMap((f) => f.body.blocks);
    out.push(...inner, ...localModuleBlocks(target, inner, dirs, [...seen, target]));
  }
  return out;
}

function readBackend(block: HclBlock | null, info: DirInfo): Backend {
  const configFiles = info.other
    .filter((p) => p.endsWith(".tfbackend") || /^backend.*\.hcl$/.test(baseOf(p)))
    .filter((p) => !/\.example$/.test(p) && isSafePath(p))
    .sort();
  if (!block) return { kind: "local", type: null, settings: {}, partial: false, configFiles };
  // Only settings that say where state is. A backend block can also carry
  // credentials, which a scan must never echo back.
  const settings: Record<string, string> = {};
  for (const [k, v] of Object.entries(block.body.attrs)) {
    if (v.str !== undefined && BACKEND_SETTING_KEYS.has(k)) settings[k] = v.str;
  }
  if (block.type === "cloud") return { kind: "tfc", type: "cloud", settings, partial: false, configFiles };
  const type = block.labels[0] ?? "unknown";
  const raw = Object.values(block.body.attrs).map((a) => a.raw).join("\n");
  const endpointsBlock = block.body.blocks.find((b) => b.type === "endpoints");
  const endpointRaw = raw + (endpointsBlock ? Object.values(endpointsBlock.body.attrs).map((a) => a.raw).join("\n") : "");
  let kind: BackendKind;
  let partial = false;
  switch (type) {
    case "s3":
      kind = /r2\.cloudflarestorage\.com/.test(endpointRaw) ? "r2" : "s3";
      partial = !settings.bucket || !settings.key;
      break;
    case "gcs":
      kind = "gcs";
      partial = !settings.bucket;
      break;
    case "azurerm":
      kind = "azurerm";
      partial = !settings.storage_account_name || !settings.container_name || !settings.key;
      break;
    case "remote":
      kind = "tfc";
      break;
    case "local":
      kind = "local";
      break;
    default:
      kind = "other";
  }
  return { kind, type, settings, partial, configFiles };
}
