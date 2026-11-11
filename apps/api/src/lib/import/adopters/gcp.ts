import type { Provider, ResourceInventoryItem } from "@infralift/shared";
import { importBlockFor } from "../../tf/codegen.js";
import type { Adopter } from "./types.js";
import { tfName } from "./types.js";

// Google project ids: 6-30 lowercase letters, digits and dashes.
const PROJECT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

function googleAdopter(provider: Provider): Adopter {
  return {
    provider,
    map(item) {
      const codegen = importBlockFor(provider, item);
      if (codegen) return codegen;
      return item.type === "gcp:gcs_bucket" ? { to: `google_storage_bucket.${tfName(item.name)}`, id: item.externalId } : null;
    },
    // The connector records the project it assessed as a <provider>:project
    // item. Bare-name import ids (Cloud SQL, location/name) resolve against it.
    settings(inventory: ResourceInventoryItem[]) {
      const p = inventory.find((i) => i.type === `${provider}:project`)?.externalId;
      return p && PROJECT.test(p) ? { project: p } : {};
    },
  };
}

export const gcpAdopter = googleAdopter("gcp");
export const firebaseAdopter = googleAdopter("firebase");
