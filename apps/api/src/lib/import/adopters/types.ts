import type { Provider, ResourceInventoryItem } from "@infralift/shared";

/** Where one inventory item goes in Terraform. `region` puts its import
 *  block on a provider alias for that region (AWS); without it the item uses
 *  the default provider. */
export interface AdoptTarget {
  to: string;
  id: string;
  region?: string;
}

/** A specific reason an item cannot be adopted, said to the customer. */
export interface AdoptSkip {
  skip: string;
}

/** Values the provider block needs, read from the inventory. */
export interface ProviderSettings {
  /** Regions that get a provider alias. */
  regions?: string[];
  /** Google project id. */
  project?: string;
}

/**
 * One adapter per provider: maps an inventory item to an import, or says why
 * not. null means "no mapping for this kind", which the caller reports with
 * one generic reason.
 */
export interface Adopter {
  provider: Provider;
  map(item: ResourceInventoryItem): AdoptTarget | AdoptSkip | null;
  /** Settings for the provider block, from the whole inventory. */
  settings?(inventory: ResourceInventoryItem[]): ProviderSettings;
  /** Static body of the default provider block, e.g. azurerm's features {}. */
  defaultBody?: "features";
}

export const isSkip = (r: AdoptTarget | AdoptSkip): r is AdoptSkip => "skip" in r;

/** Same rule codegen uses for resource names. */
export function tfName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, "_").replace(/^[0-9]/, "_$&");
}
