import type { Provider, ResourceInventoryItem } from "@infralift/shared";
import { importBlockFor } from "../../tf/codegen.js";
import { attr, block, type Node } from "../../hcl/write.js";
import { awsAdopter, AWS_DEFAULT_REGION } from "./aws.js";
import { azureAdopter } from "./azure.js";
import { cloudflareAdopter } from "./cloudflare.js";
import { digitaloceanAdopter } from "./digitalocean.js";
import { firebaseAdopter, gcpAdopter } from "./gcp.js";
import type { Adopter, ProviderSettings } from "./types.js";

export { isSkip, tfName, type Adopter, type AdoptSkip, type AdoptTarget, type ProviderSettings } from "./types.js";

// ---------------------------------------------------------------------------
// Adopters: one per provider, each mapping an inventory item to an `import {}`
// block (Adapter pattern; registered here as connectors are in
// connectors/index.ts). A provider with no adopter of its own falls back to
// codegen's import table, which is shared so codegen and adoption agree on ids.
// ---------------------------------------------------------------------------

const ADOPTERS: Partial<Record<Provider, Adopter>> = {
  aws: awsAdopter,
  azure: azureAdopter,
  cloudflare: cloudflareAdopter,
  digitalocean: digitaloceanAdopter,
  firebase: firebaseAdopter,
  gcp: gcpAdopter,
};

export function adopterFor(provider: Provider): Adopter {
  return ADOPTERS[provider] ?? { provider, map: (item) => importBlockFor(provider, item) };
}

/** Provider alias for a region: us-west-2 becomes us_west_2. */
export const regionAlias = (region: string) => region.replace(/-/g, "_");

export function providerSettings(provider: Provider, inventory: ResourceInventoryItem[]): ProviderSettings {
  return adopterFor(provider).settings?.(inventory) ?? {};
}

/** The provider blocks for provider.tf: the default one, then one alias per
 *  region the imports use. */
export function providerBlocks(provider: Provider, name: string, settings: ProviderSettings = {}): Node[] {
  const adopter = adopterFor(provider);
  const body: Node[] = [];
  if (settings.project) body.push(attr("project", settings.project));
  if (adopter.defaultBody === "features") body.push(block("features", [], []));
  // Global AWS services (IAM, CloudFront, Route 53) use the default provider,
  // which must name a region.
  if (provider === "aws") body.push(attr("region", AWS_DEFAULT_REGION));
  const aliases = (settings.regions ?? []).map((r) => block("provider", [name], [attr("alias", regionAlias(r)), attr("region", r)]));
  return [block("provider", [name], body), ...aliases];
}
