// ---------------------------------------------------------------------------
// The version baseline (ADR 0012): the one place infralift says which
// Terraform/OpenTofu versions and which provider versions the code it writes
// asks for.
//
// Codegen (codegen.ts, targets.ts), adoption (lib/import/adopt.ts) and
// render.ts read these values when they write HCL. Catalog stacks are static
// files on disk, so they cannot import this module; catalog.test.ts reads
// every required_version and every provider pin in every catalog stack and
// fails if one disagrees with this file. Moving a pin means moving it here and
// in the stacks in the same change.
// ---------------------------------------------------------------------------

/**
 * required_version floors. One table rather than one value because the floor
 * follows the features a file uses, and raising the lowest one would refuse
 * someone today's code works for:
 *
 * - generated: codegen and template output. Terraform 1.5.7 is the last
 *   MPL-licensed Terraform and OpenTofu 1.6 forked from it, so ">= 1.5" keeps
 *   both working.
 * - stack: catalog stack root modules and their modules.
 * - stateEncryption: a stack's R2 backend file. Its encryption block and the
 *   variables in its backend block are OpenTofu 1.7 and 1.8 features.
 * - s3Lockfile: adoption. use_lockfile (S3-native state locking) arrived in
 *   1.10 of both tools.
 */
export const REQUIRED_VERSION = {
  generated: ">= 1.5",
  stack: ">= 1.6",
  stateEncryption: ">= 1.8",
  s3Lockfile: ">= 1.10",
} as const;

export type RequiredVersionFloor = keyof typeof REQUIRED_VERSION;

/**
 * Provider version constraints, by registry source. Every provider any
 * generated file or catalog stack declares is listed here, so a new one
 * cannot arrive without a pin.
 */
export const PROVIDER_VERSIONS: Readonly<Record<string, string>> = {
  // Patch releases only: adoption's cleanup rules (lib/import/cleanup.ts) were
  // measured on 6.73.0, and a new minor can write attributes they do not
  // cover. Raising it means re-measuring them (that file's header);
  // cleanup.test.ts fails until then.
  "hashicorp/aws": "~> 6.73.0",
  "hashicorp/azurerm": "~> 4.0",
  "hashicorp/google": "~> 6.0",
  "hashicorp/tls": "~> 4.0",
  "cloudflare/cloudflare": "~> 5.28",
  "digitalocean/digitalocean": "~> 2.0",
  "gitlabhq/gitlab": "~> 18.11",
  "hetznercloud/hcloud": "~> 1.70",
  "heroku/heroku": "~> 5.0",
  "integrations/github": "~> 6.13",
  "kislerdm/neon": "~> 0.15",
  "netlify/netlify": "~> 0.4",
  "render-oss/render": "~> 1.0",
  "upstash/upstash": "~> 2.1",
  "vercel/vercel": "~> 5.0",
};

/** The constraint for a registry source such as "hashicorp/aws". Throws for a
 *  source the baseline does not list: writing a provider with no pin is the
 *  mistake this module exists to prevent. */
export function providerVersion(source: string): string {
  const version = PROVIDER_VERSIONS[source];
  if (!version) throw new Error(`version baseline has no pin for provider ${source} (lib/tf/baseline.ts)`);
  return version;
}
