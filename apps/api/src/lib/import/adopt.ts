import type { Provider, ResourceInventoryItem } from "@infralift/shared";
import { importBlockFor, providerSource } from "../tf/codegen.js";
import { PROVIDER_ENV, type RootModule } from "./scan.js";

// ---------------------------------------------------------------------------
// Adopt resources that were built by hand in a cloud console, as they are.
//
// infralift writes only `import {}` blocks, a provider and a backend. It does
// not write resource code: Terraform generates that in the customer's CI from
// what is actually running (`plan -generate-config-out`), and the import check
// then holds it to "N to import, 0 to change, 0 to destroy". Guessed code is
// how a takeover resizes a server; generated code describes the real one.
// ---------------------------------------------------------------------------

export interface AdoptBackend {
  kind: "s3" | "r2";
  bucket: string;
  key: string;
  /** AWS region for S3. R2 is always "auto". */
  region?: string;
  /** Cloudflare account id, for the R2 endpoint. */
  accountId?: string;
}

export interface AdoptPlan {
  imports: { to: string; id: string; type: string; name: string }[];
  /** Inventory items left out, with the reason, so a partial adoption never
   *  reads as a whole one. */
  skipped: { type: string; name: string; reason: string }[];
}

export class AdoptInputError extends Error {}

// Import mappings used for adoption only. They are kept out of codegen's
// table because codegen writes resource blocks for everything it imports, and
// an import block with no resource block is an error there. Here the resource
// block is generated, so any resource with a known import id format works.
const ADOPT_ONLY: Partial<Record<Provider, (item: ResourceInventoryItem) => { to: string; id: string } | null>> = {
  cloudflare: (item) =>
    item.type === "cloudflare:zone" ? { to: `cloudflare_zone.${tfName(item.name)}`, id: item.externalId } : null,
  digitalocean: (item) =>
    item.type === "digitalocean:domain" ? { to: `digitalocean_domain.${tfName(item.name)}`, id: item.externalId } : null,
  gcp: (item) =>
    item.type === "gcp:gcs_bucket" ? { to: `google_storage_bucket.${tfName(item.name)}`, id: item.externalId } : null,
  azure: (item) => {
    // azurerm imports by the full ARM resource id, which the connector stores.
    const type: Record<string, string> = {
      "azure:storage_account": "azurerm_storage_account",
      "azure:app_service_plan": "azurerm_service_plan",
      "azure:sql_server": "azurerm_mssql_server",
      "azure:sql_database": "azurerm_mssql_database",
    };
    const t = type[item.type];
    return t && item.externalId.startsWith("/subscriptions/") ? { to: `${t}.${tfName(item.name)}`, id: item.externalId } : null;
  },
};

/** Same rule codegen uses for resource names. */
function tfName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, "_").replace(/^[0-9]/, "_$&");
}

/** An import id goes into HCL inside quotes. Anything that could close the
 *  string or start an interpolation is refused, not escaped. */
const SAFE_ID = /^[A-Za-z0-9._:/@=+-]+$/;

export function planAdoption(provider: Provider, inventory: ResourceInventoryItem[]): AdoptPlan {
  const imports: AdoptPlan["imports"] = [];
  const skipped: AdoptPlan["skipped"] = [];
  const taken = new Set<string>();
  for (const item of inventory) {
    if (item.type.endsWith(":usage")) continue;
    const block = importBlockFor(provider, item) ?? ADOPT_ONLY[provider]?.(item) ?? null;
    if (!block) {
      skipped.push({ type: item.type, name: item.name, reason: "no Terraform import mapping for this kind yet" });
      continue;
    }
    if (!SAFE_ID.test(block.id)) {
      skipped.push({ type: item.type, name: item.name, reason: "its id has characters infralift will not write into code" });
      continue;
    }
    // Two resources with the same name would claim one address.
    let to = block.to;
    for (let n = 2; taken.has(to); n++) to = `${block.to}_${n}`;
    taken.add(to);
    imports.push({ to, id: block.id, type: item.type, name: item.name });
  }
  return { imports, skipped };
}

const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const KEY = /^[A-Za-z0-9._/-]{1,512}$/;
const REGION = /^[a-z0-9-]{2,32}$/;
const ACCOUNT = /^[a-f0-9]{32}$/;

export function validateBackend(b: AdoptBackend): void {
  if (!BUCKET.test(b.bucket)) throw new AdoptInputError("bucket: 3-63 lowercase letters, digits, dots and dashes");
  if (!KEY.test(b.key) || b.key.split("/").includes("..")) throw new AdoptInputError("key: a path such as infra/terraform.tfstate");
  if (b.kind === "s3" && !REGION.test(b.region ?? "")) throw new AdoptInputError("region: an AWS region such as us-east-1");
  if (b.kind === "r2" && !ACCOUNT.test(b.accountId ?? "")) throw new AdoptInputError("accountId: the 32-character Cloudflare account id");
}

/** Environment the provider reads credentials from. Same table the scan uses,
 *  so the check asks for the same secrets a repo scan would. */
function providerCredentials(provider: Provider): string[] {
  const src = providerSource(provider);
  if (!src) return [];
  return PROVIDER_ENV[src.source.split("/").pop()!] ?? PROVIDER_ENV[src.name] ?? [];
}

export function renderAdoption(opts: {
  provider: Provider;
  plan: AdoptPlan;
  backend: AdoptBackend;
  path: string;
  label: string;
}): { files: { path: string; content: string }[]; root: RootModule } {
  const { provider, plan, backend } = opts;
  validateBackend(backend);
  const src = providerSource(provider);
  if (!src) throw new AdoptInputError(`${provider} has no Terraform provider`);
  if (!plan.imports.length) throw new AdoptInputError("nothing in this account can be imported yet");

  const backendLines =
    backend.kind === "r2"
      ? [
          `    bucket                      = "${backend.bucket}"`,
          `    key                         = "${backend.key}"`,
          `    region                      = "auto"`,
          `    endpoints                   = { s3 = "https://${backend.accountId}.r2.cloudflarestorage.com" }`,
          `    skip_credentials_validation = true`,
          `    skip_region_validation      = true`,
          `    skip_requesting_account_id  = true`,
          `    skip_metadata_api_check     = true`,
          `    skip_s3_checksum            = true`,
          `    use_path_style              = true`,
          `    use_lockfile                = true`,
        ]
      : [
          `    bucket       = "${backend.bucket}"`,
          `    key          = "${backend.key}"`,
          `    region       = "${backend.region}"`,
          `    encrypt      = true`,
          `    use_lockfile = true`,
        ];

  const files = [
    {
      path: "versions.tf",
      content: [
        `# Managed by infralift.`,
        `terraform {`,
        `  required_version = ">= 1.6"`,
        `  required_providers {`,
        `    ${src.name} = {`,
        `      source  = "${src.source}"`,
        `      version = "${src.version}"`,
        `    }`,
        `  }`,
        `  backend "s3" {`,
        ...backendLines,
        `  }`,
        `}`,
        ``,
      ].join("\n"),
    },
    {
      path: "provider.tf",
      content: [
        `# Managed by infralift. Credentials come from the environment, never from`,
        `# this file: ${providerCredentials(provider).join(", ") || "see the provider's docs"}.`,
        `provider "${src.name}" {}`,
        ``,
      ].join("\n"),
    },
    {
      path: "imports.tf",
      content: [
        `# Managed by infralift. Each block adopts one resource that already exists.`,
        `# The resource code is generated from what is running, by the import check`,
        `# workflow (plan -generate-config-out=generated.tf), and committed beside`,
        `# this file. Applying imports into state; it changes nothing.`,
        ``,
        ...plan.imports.flatMap((i) => [`# ${i.type}: ${i.name}`, `import {`, `  to = ${i.to}`, `  id = "${i.id}"`, `}`, ``]),
      ].join("\n"),
    },
  ];

  const resourceTypes: Record<string, number> = {};
  for (const i of plan.imports) {
    const t = i.to.split(".")[0];
    resourceTypes[t] = (resourceTypes[t] ?? 0) + 1;
  }
  const backendCreds = backend.kind === "r2" ? ["R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"] : ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"];
  const root: RootModule = {
    path: opts.path,
    backend: {
      kind: backend.kind,
      type: "s3",
      settings: { bucket: backend.bucket, key: backend.key, ...(backend.region ? { region: backend.region } : {}) },
      partial: false,
      configFiles: [],
    },
    providers: [{ name: src.name, source: src.source, version: src.version }],
    resources: plan.imports.length,
    dataSources: 0,
    moduleCalls: 0,
    resourceTypes,
    requiredVariables: [],
    credentials: [...new Set([...backendCreds, ...providerCredentials(provider)])].sort(),
    tool: "tofu",
    readiness: "ready",
    notes: plan.skipped.length
      ? [`${plan.skipped.length} resource(s) are not adopted yet: ${[...new Set(plan.skipped.map((s) => s.type))].join(", ")}.`]
      : [],
    generateConfig: true,
  };
  return { files, root };
}
