#!/usr/bin/env node
/**
 * infralift inventory collector — Vercel.
 *
 * Run this yourself instead of handing infralift an API token. It reads your
 * Vercel account, writes a JSON file, and stops. You read the file, then you
 * decide whether to upload it.
 *
 * Three properties this file is built around, in the order a reviewer checks:
 *
 *   1. It sends nothing anywhere. The only host it contacts is
 *      api.vercel.com, and the only writes are to stdout or the path you pass
 *      to --out. There is no telemetry, no version check, no callback. Grep
 *      for `fetch(` — every call goes through vfetch(), which hard-codes API.
 *
 *   2. It captures a fixed list of fields, never a raw API response. See
 *      FIELDS below, or run --fields to print it. This matters more than it
 *      sounds: GET /v10/projects returns an `env` array where each entry
 *      carries a `value`. Vercel encrypts those values, so they arrive as
 *      ciphertext rather than plaintext, but a collector that dumped the raw
 *      response would still drop ~1KB of high-entropy data per environment
 *      variable into a file you are about to send someone. This one records
 *      the *count* of environment variables and no part of the array.
 *
 *   3. It has no dependencies. Nothing to `npm install`, nothing transitive to
 *      audit. Node 18+ for global fetch, and that is the whole requirement.
 *
 * Usage:
 *   VERCEL_TOKEN=... node vercel.mjs --out inventory.json
 *   node vercel.mjs --dry-run      # print the exact API calls, make none
 *   node vercel.mjs --fields       # print every field captured
 *
 * The token is read from VERCEL_TOKEN (or --token) and used only for the
 * Authorization header on the calls listed below. It is never written to the
 * output. Revoke it as soon as this finishes if you like; nothing else needs
 * it.
 */

export const SCHEMA_VERSION = 1;
export const COLLECTOR_VERSION = "1.0.0";

const API = "https://api.vercel.com";

/** Every endpoint this collector calls. Printed by --dry-run. */
export const ENDPOINTS = [
  {
    path: "/v10/projects?limit=100",
    why: "project list: framework, build settings, git link, env var count. Paged: the next page passes the previous one's pagination.next as &from=",
  },
  {
    path: "/v5/domains?limit=100",
    why: "custom domains. Optional — a token without domain scope just skips it",
  },
];

/**
 * Every field written to the output, by section. This is the manifest a
 * security reviewer reads. If a field is not on this list it is not captured.
 */
export const FIELDS = {
  "projects[]": [
    "id",
    "name",
    "framework",
    "nodeVersion",
    "serverlessFunctionRegion",
    "envVarCount  (a NUMBER — the length of the env array, never its contents)",
    "buildCommand",
    "outputDirectory",
    "rootDirectory",
    "installCommand",
    "devCommand",
    "link.type, link.org, link.repo, link.productionBranch",
  ],
  "domains[]": ["id", "name", "serviceType"],
  meta: ["schemaVersion", "provider", "collector", "collectedAt", "domainsRead"],
};

async function vfetch(token, path, fetchImpl) {
  const res = await fetchImpl(`${API}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw Object.assign(new Error(`Vercel API ${path} -> ${res.status}`), { status: res.status });
  return res.json();
}

/** Pages of projects read before giving up, so a provider that keeps
 * answering with a next page cannot keep this running forever. 100 pages of
 * 100 is far beyond any account this has been pointed at. */
export const MAX_PROJECT_PAGES = 100;

/**
 * Every project in the account, following Vercel's pagination.
 *
 * GET /v10/projects answers either a bare array or { projects, pagination }
 * (vercel/sdk's vercel-spec.json documents both). pagination.next is a
 * continuation token (a string) or a timestamp (a number), and either one is
 * passed back as `from`. A null or missing next is the last page. A next equal
 * to the one just sent would ask for the same page again, so it ends the read
 * too, with an error rather than a silently short list.
 */
async function listProjects(token, fetchImpl) {
  const projects = [];
  let from = null;
  for (let page = 0; page < MAX_PROJECT_PAGES; page++) {
    const path = from === null ? ENDPOINTS[0].path : `${ENDPOINTS[0].path}&from=${encodeURIComponent(String(from))}`;
    const body = await vfetch(token, path, fetchImpl);
    const items = Array.isArray(body) ? body : (body?.projects ?? []);
    projects.push(...items);
    const next = Array.isArray(body) ? null : (body?.pagination?.next ?? null);
    if (next === null || items.length === 0) return projects;
    if (String(next) === String(from)) {
      throw new Error(`Vercel API /v10/projects returned the same next page (${next}) twice`);
    }
    from = next;
  }
  throw new Error(`Vercel API /v10/projects still had more pages after ${MAX_PROJECT_PAGES}`);
}

/**
 * Pick the project fields we keep. Written as explicit assignments rather than
 * a spread or a key filter, so that adding a field to the output requires
 * editing this function and shows up in a diff.
 */
export function pickProject(p) {
  const link = p.link ?? null;
  return {
    id: p.id ?? null,
    name: p.name ?? null,
    framework: p.framework ?? null,
    nodeVersion: p.nodeVersion ?? null,
    serverlessFunctionRegion: p.serverlessFunctionRegion ?? null,
    // Count only. `p.env` itself is deliberately not read beyond its length.
    envVarCount: Array.isArray(p.env) ? p.env.length : null,
    buildCommand: p.buildCommand ?? null,
    outputDirectory: p.outputDirectory ?? null,
    rootDirectory: p.rootDirectory ?? null,
    installCommand: p.installCommand ?? null,
    devCommand: p.devCommand ?? null,
    link: link
      ? {
          type: link.type ?? null,
          org: link.org ?? null,
          repo: link.repo ?? null,
          productionBranch: link.productionBranch ?? null,
        }
      : null,
  };
}

export function pickDomain(d) {
  return {
    id: d.id ?? d.name ?? null,
    name: d.name ?? null,
    serviceType: d.serviceType ?? null,
  };
}

/**
 * Read the account and return a snapshot.
 *
 * `fetchImpl` and `now` are injectable so the API server and the test suite
 * can drive this exact function; customers running the CLI get the defaults.
 */
export async function collect({
  token,
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
} = {}) {
  if (!token) throw new Error("A Vercel token is required.");

  const projects = (await listProjects(token, fetchImpl)).map(pickProject);

  // A token scoped without domain access is a normal, supported case. Record
  // that the read did not happen rather than reporting "no domains", so the
  // report can tell an empty account from a partial one.
  let domains = [];
  let domainsRead = true;
  try {
    const domainsRes = await vfetch(token, ENDPOINTS[1].path, fetchImpl);
    domains = (domainsRes.domains ?? []).map(pickDomain);
  } catch {
    domainsRead = false;
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    provider: "vercel",
    collector: { name: "@infralift/collectors/vercel", version: COLLECTOR_VERSION },
    collectedAt: now().toISOString(),
    projects,
    domains,
    domainsRead,
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

const USAGE = `infralift Vercel collector v${COLLECTOR_VERSION}

  VERCEL_TOKEN=... node vercel.mjs --out inventory.json

Options
  -o, --out <file>   write the snapshot here (default: stdout)
      --token <tok>  token, if you would rather not use VERCEL_TOKEN
      --dry-run      print the API calls this would make, then exit
      --fields       print every field captured, then exit
  -h, --help         this

Sends nothing anywhere. Reads api.vercel.com, writes a file, exits.`;

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
    console.log(
      "\nEnvironment variables: the COUNT is recorded. Names and values are not read."
    );
    return 0;
  }

  if (args.dryRun) {
    console.log("Would call, and nothing else:\n");
    for (const e of ENDPOINTS) console.log(`  GET ${API}${e.path}\n      ${e.why}\n`);
    console.log("No other host is contacted. No data leaves this machine.");
    return 0;
  }

  const token = args.token ?? process.env.VERCEL_TOKEN;
  if (!token) {
    console.error("No token. Set VERCEL_TOKEN or pass --token.\n");
    console.error(USAGE);
    return 2;
  }

  const snapshot = await collect({ token });
  const json = JSON.stringify(snapshot, null, 2);

  if (args.out) {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(args.out, json + "\n", "utf8");
    // stderr, so `--out /dev/stdout` still produces clean JSON.
    console.error(
      `Wrote ${args.out}: ${snapshot.projects.length} project(s), ${snapshot.domains.length} domain(s).`
    );
    console.error("Read it before you send it to anyone.");
  } else {
    console.log(json);
  }
  return 0;
}

// Only run when executed directly, so importing this file (the API server and
// the parity test both do) has no side effects.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`Collection failed: ${err.message}`);
      process.exit(1);
    });
}
