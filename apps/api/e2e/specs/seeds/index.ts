// The seeded accounts Prism serves, by sources.ts entry name. extract.ts
// writes each `examples` entry into its operation's 200 response after
// checking it against the response schema; the e2e tests read the same
// modules to know what each unmanaged view should list.

import { CF_EXAMPLES } from "../cloudflare-seed.js";
import { AZURE_EXAMPLES } from "./azure.js";
import { DO_EXAMPLES } from "./digitalocean.js";
import { FLY_MACHINES_EXAMPLES } from "./flyio.js";
import { GOOGLE_EXAMPLES } from "./google.js";
import { HEROKU_EXAMPLES } from "./heroku.js";
import { NETLIFY_EXAMPLES } from "./netlify.js";
import { RENDER_EXAMPLES } from "./render.js";
import { VERCEL_EXAMPLES } from "./vercel.js";

export interface Seed {
  /** The seed module, relative to e2e/specs, named in each written example. */
  file: string;
  /** GET responses by the description's path template. */
  examples: Record<string, unknown>;
}

export const SEEDS: Record<string, Seed> = {
  cloudflare: { file: "cloudflare-seed.ts", examples: CF_EXAMPLES },
  digitalocean: { file: "seeds/digitalocean.ts", examples: DO_EXAMPLES },
  render: { file: "seeds/render.ts", examples: RENDER_EXAMPLES },
  vercel: { file: "seeds/vercel.ts", examples: VERCEL_EXAMPLES },
  heroku: { file: "seeds/heroku.ts", examples: HEROKU_EXAMPLES },
  netlify: { file: "seeds/netlify.ts", examples: NETLIFY_EXAMPLES },
  "flyio-machines": { file: "seeds/flyio.ts", examples: FLY_MACHINES_EXAMPLES },
  azure: { file: "seeds/azure.ts", examples: AZURE_EXAMPLES },
  google: { file: "seeds/google.ts", examples: GOOGLE_EXAMPLES },
};
