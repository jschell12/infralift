// The seeded accounts Prism serves, by sources.ts entry name. extract.ts
// writes each `examples` entry into its operation's 200 response after
// checking it against the response schema; the e2e tests read the same
// modules to know what each unmanaged view should list.

import { CF_EXAMPLES } from "../cloudflare-seed.js";

export interface Seed {
  /** The seed module, relative to e2e/specs, named in each written example. */
  file: string;
  /** GET responses by the description's path template. */
  examples: Record<string, unknown>;
}

export const SEEDS: Record<string, Seed> = {
  cloudflare: { file: "cloudflare-seed.ts", examples: CF_EXAMPLES },
};
