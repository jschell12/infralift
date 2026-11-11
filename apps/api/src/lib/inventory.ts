import type { InventoryItem } from "@prisma/client";
import type { Provider, ResourceInventoryItem } from "@infralift/shared";

/** A stored InventoryItem row as the shape connectors produce and every
 *  analyzer reads: nulls become absent fields. The one copy of a mapping that
 *  services, the job pipeline and the assessment routes each used to write
 *  out by hand. */
export function toInventoryItem(row: InventoryItem): ResourceInventoryItem {
  return {
    provider: row.provider as Provider,
    type: row.type,
    externalId: row.externalId,
    name: row.name,
    region: row.region ?? undefined,
    monthlyCostCents: row.monthlyCostCents ?? undefined,
    metadata: (row.metadata as Record<string, unknown> | null) ?? undefined,
  };
}
