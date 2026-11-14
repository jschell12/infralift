// ---------------------------------------------------------------------------
// Where this checkout's e2e stack listens, and what its compose project is
// called. Two worktrees running `make e2e` at once must not share a database,
// a moto, or a port, so both are derived from the checkout's path:
//
//   base port  20000 + (hash % 127) * 100, i.e. 20000..32600, below the
//              ephemeral range Linux hands out (32768+). Each service is at a
//              fixed offset from it (OFFSETS).
//   project    infralift-e2e-<hash>, so `docker compose down` in one checkout
//              never removes another's containers.
//
// E2E_PORT_BASE and E2E_PROJECT override them (CI does not need to).
//
// This file is the one place the numbers come from. scripts/e2e.sh runs it
// (`tsx e2e/harness/ports.ts`) and evals the `export` lines it prints, which
// docker-compose.e2e.yml reads as ${E2E_PORT_*}; harness/env.ts imports it.
// ---------------------------------------------------------------------------

import { fileURLToPath } from "node:url";

/** Offsets from the base port. The API's per-provider processes take
 *  api + 1 upwards (providers.e2e.test.ts), so nothing else sits above api. */
export const OFFSETS = {
  moto: 0,
  postgres: 1,
  cloudflare: 10,
  digitalocean: 11,
  render: 12,
  vercel: 13,
  heroku: 14,
  netlify: 15,
  flyioMachines: 16,
  azure: 17,
  google: 18,
  githubFake: 20,
  providerFakes: 30,
  api: 40,
} as const;

export type PortName = keyof typeof OFFSETS;

/** FNV-1a, 32-bit: a stable hash of the path with no dependency. */
function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

export interface StackLayout {
  project: string;
  base: number;
  ports: Record<PortName, number>;
}

/** The layout for a checkout at `repoRoot`, honouring the overrides in `env`. */
export function stackLayout(repoRoot: string, env: Record<string, string | undefined> = process.env): StackLayout {
  const hash = fnv1a(repoRoot.replace(/\/+$/, ""));
  const override = env.E2E_PORT_BASE?.trim();
  const base = override ? Number(override) : 20000 + (hash % 127) * 100;
  if (!Number.isInteger(base) || base < 1024 || base + 100 > 65535) {
    throw new Error(`E2E_PORT_BASE must be an integer port between 1024 and 65435, not ${JSON.stringify(override)}`);
  }
  const project = env.E2E_PROJECT?.trim() || `infralift-e2e-${hash.toString(16).padStart(8, "0").slice(0, 6)}`;
  const ports = Object.fromEntries(Object.entries(OFFSETS).map(([name, offset]) => [name, base + offset])) as Record<PortName, number>;
  return { project, base, ports };
}

/** The variables docker-compose.e2e.yml reads, as `export` lines for bash. */
export function composeExports(layout: StackLayout): string[] {
  const p = layout.ports;
  const vars: Record<string, string | number> = {
    COMPOSE_PROJECT_NAME: layout.project,
    E2E_PORT_BASE: layout.base,
    E2E_PORT_MOTO: p.moto,
    E2E_PORT_POSTGRES: p.postgres,
    E2E_PORT_CLOUDFLARE: p.cloudflare,
    E2E_PORT_DIGITALOCEAN: p.digitalocean,
    E2E_PORT_RENDER: p.render,
    E2E_PORT_VERCEL: p.vercel,
    E2E_PORT_HEROKU: p.heroku,
    E2E_PORT_NETLIFY: p.netlify,
    E2E_PORT_FLYIO_MACHINES: p.flyioMachines,
    E2E_PORT_AZURE: p.azure,
    E2E_PORT_GOOGLE: p.google,
  };
  return Object.entries(vars).map(([k, v]) => `export ${k}=${v}`);
}

export const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  console.log(composeExports(stackLayout(REPO_ROOT)).join("\n"));
}
