import type { Provider, ResourceInventoryItem } from "@infralift/shared";
import { providerSource } from "../tf/codegen.js";
import { PROVIDER_ENV, type RootModule } from "./scan.js";
import { adopterFor, isSkip, providerBlocks, providerSettings, regionAlias, type AdoptTarget, type ProviderSettings } from "./adopters/index.js";
import { attr, blank, block, comment, expr, file as hcl } from "../hcl/write.js";

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
  /** `provider` is an alias address (aws.us_west_2) when the import is not on
   *  the default provider. */
  imports: { to: string; id: string; type: string; name: string; externalId: string; provider?: string }[];
  /** Inventory items left out, with the reason, so a partial adoption never
   *  reads as a whole one. */
  skipped: { type: string; name: string; reason: string }[];
  /** What provider.tf needs: a project, region aliases. */
  settings?: ProviderSettings;
}

export class AdoptInputError extends Error {}

// Which inventory items map to which import blocks is each provider's
// adopter (./adopters/). Adoption writes no resource code, so unlike codegen
// any resource with a known import id format can be adopted.

/** A name from the provider, for a one-line HCL comment. */
function commentSafe(name: string): string {
  return name.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 200);
}

/** An import id goes into HCL inside quotes. Anything that could close the
 *  string or start an interpolation is refused, not escaped. */
const SAFE_ID = /^[A-Za-z0-9._:/@=+-]+$/;

/** Usage lines (":usage" types) are billing figures, not resources. */
export const isUsageLine = (item: { type: string }) => item.type.endsWith(":usage");

/** Whether one inventory item can be adopted today: its import block, or the
 *  reason it cannot. The rule planAdoption applies to each item, exported so
 *  the unmanaged view (services/unmanaged.ts) says "adoptable" for exactly
 *  the items an adoption would import. */
export function adoptionTarget(provider: Provider, item: ResourceInventoryItem): AdoptTarget | { reason: string } {
  const block = adopterFor(provider).map(item);
  if (!block) return { reason: "no Terraform import mapping for this kind yet" };
  if (isSkip(block)) return { reason: block.skip };
  if (!SAFE_ID.test(block.id)) return { reason: "its id has characters infralift will not write into code" };
  return block;
}

/** Import blocks for `inventory`. Provider settings (a Google project) are
 *  read from `settingsInventory`, which defaults to the same list; a caller
 *  adopting a selection passes the whole account, because the item that
 *  carries the setting is not itself importable. */
export function planAdoption(
  provider: Provider,
  inventory: ResourceInventoryItem[],
  settingsInventory: ResourceInventoryItem[] = inventory
): AdoptPlan {
  const imports: AdoptPlan["imports"] = [];
  const skipped: AdoptPlan["skipped"] = [];
  const taken = new Set<string>();
  const regions = new Set<string>();
  const alias = providerSource(provider)?.name ?? provider;
  for (const item of inventory) {
    if (isUsageLine(item)) continue;
    const block = adoptionTarget(provider, item);
    if ("reason" in block) {
      skipped.push({ type: item.type, name: item.name, reason: block.reason });
      continue;
    }
    // Two resources with the same name would claim one address.
    let to = block.to;
    for (let n = 2; taken.has(to); n++) to = `${block.to}_${n}`;
    taken.add(to);
    if (block.region) {
      regions.add(block.region);
      imports.push({ to, id: block.id, type: item.type, name: item.name, externalId: item.externalId, provider: `${alias}.${regionAlias(block.region)}` });
    } else {
      imports.push({ to, id: block.id, type: item.type, name: item.name, externalId: item.externalId });
    }
  }
  const settings: ProviderSettings = { ...providerSettings(provider, settingsInventory) };
  if (regions.size) settings.regions = [...regions].sort();
  return { imports, skipped, settings };
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

  // R2 speaks the S3 API; these settings make the s3 backend accept it.
  const backendBody =
    backend.kind === "r2"
      ? [
          attr("bucket", backend.bucket),
          attr("key", backend.key),
          attr("region", "auto"),
          attr("skip_credentials_validation", true),
          attr("skip_region_validation", true),
          attr("skip_requesting_account_id", true),
          attr("skip_metadata_api_check", true),
          attr("skip_s3_checksum", true),
          attr("use_path_style", true),
          attr("use_lockfile", true),
          attr("endpoints", { s3: `https://${backend.accountId}.r2.cloudflarestorage.com` }),
        ]
      : [
          attr("bucket", backend.bucket),
          attr("key", backend.key),
          attr("region", backend.region!),
          attr("encrypt", true),
          attr("use_lockfile", true),
        ];

  const files = [
    {
      path: "versions.tf",
      content: hcl([
        comment("Managed by infralift."),
        block("terraform", [], [
          // use_lockfile (S3-native state locking) arrived in 1.10 of both.
          attr("required_version", ">= 1.10"),
          block("required_providers", [], [attr(src.name, { source: src.source, version: src.version })]),
          block("backend", ["s3"], backendBody),
        ]),
      ]),
    },
    {
      path: "provider.tf",
      content: hcl([
        comment(
          `Managed by infralift. Credentials come from the environment, never from\nthis file: ${providerCredentials(provider).join(", ") || "see the provider's docs"}.`
        ),
        ...providerBlocks(provider, src.name, plan.settings).flatMap((b, i) => (i ? [blank, b] : [b])),
      ]),
    },
    {
      path: "imports.tf",
      content: hcl([
        comment(
          [
            "Managed by infralift. Each block adopts one resource that already exists.",
            "The resource code is generated from what is running, by the import check",
            "workflow (plan -generate-config-out=generated.tf), and committed beside",
            "this file. Applying imports into state; it changes nothing.",
          ].join("\n")
        ),
        ...plan.imports.flatMap((i) => [
          blank,
          comment(`${i.type}: ${commentSafe(i.name)}`),
          // `to` is a resource address, an expression; `id` is a string.
          block("import", [], [
            attr("to", expr(i.to)),
            attr("id", i.id),
            // Built from a validated region, never from provider text.
            ...(i.provider ? [attr("provider", expr(i.provider))] : []),
          ]),
        ]),
      ]),
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
