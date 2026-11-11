import { importBlockFor } from "../../tf/codegen.js";
import type { Adopter } from "./types.js";
import { tfName } from "./types.js";

export const digitaloceanAdopter: Adopter = {
  provider: "digitalocean",
  map(item) {
    const codegen = importBlockFor("digitalocean", item);
    if (codegen) return codegen;
    return item.type === "digitalocean:domain" ? { to: `digitalocean_domain.${tfName(item.name)}`, id: item.externalId } : null;
  },
};
