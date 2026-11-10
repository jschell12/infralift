#!/usr/bin/env node
/**
 * infralift inventory collector — Heroku.
 *
 * Run this yourself instead of handing infralift an API key. It reads your
 * Heroku account, writes a JSON file, and stops. You read the file, then you
 * decide whether to upload it.
 *
 * The property worth checking first: **this never calls /apps/{id}/config-vars.**
 * That is the Heroku endpoint that returns config values in plaintext, and a
 * key with `read` scope can reach it. It is not in ENDPOINTS below, and the
 * only function that performs a request is hFetch(), so the list is the whole
 * story. Your DATABASE_URL and your API keys are not read, not written, and
 * not in the output.
 *
 * What else holds:
 *   - Nothing is transmitted. The only host contacted is api.heroku.com. No
 *     telemetry, no version check, no callback.
 *   - A fixed field list is captured, never a raw API response. Run --fields.
 *     Notably `owner.email` on the app object is not kept.
 *   - No dependencies. Node 18+ for global fetch, nothing to npm install.
 *
 * Usage:
 *   HEROKU_API_KEY=... node heroku.mjs --out inventory.json
 *   node heroku.mjs --dry-run      # print the exact API calls, make none
 *   node heroku.mjs --fields       # print every field captured
 *
 * Get a key with `heroku authorizations:create -d "infralift inventory"` and
 * revoke it with `heroku authorizations:revoke <id>` when you are done. The
 * key is used only for the Authorization header and never written to output.
 */

export const SCHEMA_VERSION = 1;
export const COLLECTOR_VERSION = "1.0.0";

const API = "https://api.heroku.com";

/** Every endpoint this collector calls. Printed by --dry-run. */
export const ENDPOINTS = [
  { path: "/apps", why: "app list: name, region, stack" },
  {
    path: "/apps/{id}/formation",
    why: "dyno formation: process type, size, quantity. Drives the cost estimate",
  },
  {
    path: "/apps/{id}/addons",
    why: "add-ons: service name, plan, billed price",
  },
];

/** Endpoints deliberately NOT called, and why. Printed by --dry-run. */
export const NOT_CALLED = [
  {
    path: "/apps/{id}/config-vars",
    why: "returns config values in plaintext. Never read",
  },
  {
    path: "/apps/{id}/releases, /apps/{id}/dynos",
    why: "not needed to size a migration",
  },
];

export const FIELDS = {
  "apps[]": ["id", "name", "region (name only)", "stack (name only)", "maintenance"],
  "apps[].formation[]": ["type", "size", "quantity"],
  "apps[].addons[]": [
    "id",
    "name",
    "addonServiceName",
    "planName",
    "billedPriceCents",
  ],
  meta: ["schemaVersion", "provider", "collector", "collectedAt"],
};

async function hFetch(token, path, fetchImpl) {
  const res = await fetchImpl(`${API}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.heroku+json; version=3",
    },
  });
  if (!res.ok) throw Object.assign(new Error(`Heroku API ${path} -> ${res.status}`), { status: res.status });
  return res.json();
}

/** Explicit assignments, not a spread — see the note in vercel.mjs. */
export function pickApp(a) {
  return {
    id: a.id ?? null,
    name: a.name ?? null,
    // `.name` only. The region and stack objects carry ids and descriptions
    // that nothing downstream reads, and `owner.email` is not touched at all.
    region: a.region?.name ?? null,
    stack: a.stack?.name ?? null,
    maintenance: a.maintenance ?? false,
  };
}

export function pickFormation(f) {
  return {
    type: f.type ?? null,
    size: f.size ?? null,
    quantity: typeof f.quantity === "number" ? f.quantity : 0,
  };
}

export function pickAddon(a) {
  return {
    id: a.id ?? null,
    name: a.name ?? null,
    addonServiceName: a.addon_service?.name ?? null,
    planName: a.plan?.name ?? null,
    billedPriceCents:
      typeof a.billed_price?.cents === "number" ? a.billed_price.cents : null,
  };
}

export async function collect({
  token,
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
} = {}) {
  if (!token) throw new Error("A Heroku API key is required.");

  const rawApps = await hFetch(token, "/apps", fetchImpl);
  const apps = [];

  for (const rawApp of rawApps ?? []) {
    const app = pickApp(rawApp);

    // Both sub-reads can 403 on a collaborator-scoped key. Record that the
    // read failed rather than emitting an empty list, so "no dynos" and
    // "could not see the dynos" stay distinguishable in the report.
    let formation = [];
    let formationRead = true;
    try {
      const raw = await hFetch(token, `/apps/${app.id}/formation`, fetchImpl);
      formation = (raw ?? []).map(pickFormation);
    } catch {
      formationRead = false;
    }

    let addons = [];
    let addonsRead = true;
    try {
      const raw = await hFetch(token, `/apps/${app.id}/addons`, fetchImpl);
      addons = (raw ?? []).map(pickAddon);
    } catch {
      addonsRead = false;
    }

    apps.push({ ...app, formation, formationRead, addons, addonsRead });
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    provider: "heroku",
    collector: { name: "@infralift/collectors/heroku", version: COLLECTOR_VERSION },
    collectedAt: now().toISOString(),
    apps,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { out: null, token: null, dryRun: false, fields: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out" || a === "-o") args.out = argv[++i];
    else if (a === "--token") args.token = argv[++i];
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--fields") args.fields = true;
    else if (a === "--help" || a === "-h") args.help = true;
  }
  return args;
}

const USAGE = `infralift Heroku collector v${COLLECTOR_VERSION}

  HEROKU_API_KEY=... node heroku.mjs --out inventory.json

Options
  -o, --out <file>   write the snapshot here (default: stdout)
      --token <key>  key, if you would rather not use HEROKU_API_KEY
      --dry-run      print the API calls this would make, then exit
      --fields       print every field captured, then exit
  -h, --help         this

Sends nothing anywhere. Never reads config vars.`;

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(USAGE);
    return 0;
  }

  if (args.fields) {
    console.log("Captured fields — nothing outside this list is written:\n");
    for (const [section, fields] of Object.entries(FIELDS)) {
      console.log(`  ${section}`);
      for (const f of fields) console.log(`    - ${f}`);
    }
    console.log("\nConfig vars are never read. Neither is the app owner's email.");
    return 0;
  }

  if (args.dryRun) {
    console.log("Would call, and nothing else:\n");
    for (const e of ENDPOINTS) console.log(`  GET ${API}${e.path}\n      ${e.why}\n`);
    console.log("Deliberately NOT called:\n");
    for (const e of NOT_CALLED) console.log(`  GET ${API}${e.path}\n      ${e.why}\n`);
    console.log("No other host is contacted. No data leaves this machine.");
    return 0;
  }

  const token = args.token ?? process.env.HEROKU_API_KEY;
  if (!token) {
    console.error("No API key. Set HEROKU_API_KEY or pass --token.\n");
    console.error(USAGE);
    return 2;
  }

  const snapshot = await collect({ token });
  const json = JSON.stringify(snapshot, null, 2);

  if (args.out) {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(args.out, json + "\n", "utf8");
    const dynos = snapshot.apps.reduce(
      (n, a) => n + a.formation.reduce((m, f) => m + f.quantity, 0),
      0
    );
    console.error(
      `Wrote ${args.out}: ${snapshot.apps.length} app(s), ${dynos} dyno(s).`
    );
    console.error("Read it before you send it to anyone.");
  } else {
    console.log(json);
  }
  return 0;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`Collection failed: ${err.message}`);
      process.exit(1);
    });
}
