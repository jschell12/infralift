// ---------------------------------------------------------------------------
// Writes the OpenAPI subsets the e2e stack serves and validates against.
//
//   tsx e2e/specs/extract.ts           download the pinned descriptions, write
//                                      github.openapi.json, cloudflare.openapi.json
//   tsx e2e/specs/extract.ts --check   the same, but fail if what it would write
//                                      differs from what is committed
//
// Each subset holds only the operations infralift calls (OPERATIONS below)
// and the components they reference, taken from the vendor's own published
// description at a pinned commit. The GitHub fake answers in, and refuses
// requests against, github.openapi.json; Prism serves cloudflare.openapi.json
// with the examples from cloudflare-seed.ts, each checked against its
// response schema here. Bumping a pin and re-running shows, as a diff, what
// changed in the vendor's contract for exactly the calls infralift makes.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CF_EXAMPLES } from "./cloudflare-seed.js";
import { fillRequired, responseSchema, SpecValidator, type OpenApiDocument, type OperationRef, type Schema } from "./openapi.js";

const here = dirname(fileURLToPath(import.meta.url));

interface Source {
  name: "github" | "cloudflare";
  repo: string;
  /** A commit, never a branch: the subset must be reproducible. */
  commit: string;
  path: string;
  out: string;
  operations: OperationRef[];
}

/** Every GitHub REST call the adopt path makes (lib/git/github.ts,
 *  lib/git/hosts.ts, connectors/github.ts), plus the ones the e2e harness
 *  makes as the customer and their CI would: creating the repository,
 *  posting the check run, merging or closing the pull request. */
const GITHUB_OPERATIONS: OperationRef[] = [
  { method: "get", path: "/user" },
  { method: "post", path: "/user/repos" },
  { method: "post", path: "/orgs/{org}/repos" },
  { method: "get", path: "/repos/{owner}/{repo}" },
  { method: "get", path: "/repos/{owner}/{repo}/contents/{path}" },
  { method: "get", path: "/repos/{owner}/{repo}/git/ref/{ref}" },
  { method: "post", path: "/repos/{owner}/{repo}/git/refs" },
  { method: "patch", path: "/repos/{owner}/{repo}/git/refs/{ref}" },
  { method: "delete", path: "/repos/{owner}/{repo}/git/refs/{ref}" },
  { method: "post", path: "/repos/{owner}/{repo}/git/blobs" },
  { method: "post", path: "/repos/{owner}/{repo}/git/trees" },
  { method: "get", path: "/repos/{owner}/{repo}/git/trees/{tree_sha}" },
  { method: "post", path: "/repos/{owner}/{repo}/git/commits" },
  { method: "get", path: "/repos/{owner}/{repo}/git/commits/{commit_sha}" },
  { method: "get", path: "/repos/{owner}/{repo}/commits" },
  { method: "get", path: "/repos/{owner}/{repo}/commits/{ref}" },
  { method: "get", path: "/repos/{owner}/{repo}/commits/{ref}/check-runs" },
  { method: "post", path: "/repos/{owner}/{repo}/check-runs" },
  { method: "get", path: "/repos/{owner}/{repo}/check-runs/{check_run_id}/annotations" },
  { method: "get", path: "/repos/{owner}/{repo}/pulls" },
  { method: "post", path: "/repos/{owner}/{repo}/pulls" },
  { method: "get", path: "/repos/{owner}/{repo}/pulls/{pull_number}" },
  { method: "patch", path: "/repos/{owner}/{repo}/pulls/{pull_number}" },
  { method: "put", path: "/repos/{owner}/{repo}/pulls/{pull_number}/merge" },
];

/** Every Cloudflare call connectors/cloudflare.ts makes. */
const CLOUDFLARE_OPERATIONS: OperationRef[] = Object.keys(CF_EXAMPLES).map((path) => ({ method: "get", path }));

export const SOURCES: Source[] = [
  {
    name: "github",
    repo: "github/rest-api-description",
    commit: "53fd7d2ea1380eabdcfcc9ab9a043a56ef444fd6",
    path: "descriptions/api.github.com/api.github.com.json",
    out: "github.openapi.json",
    operations: GITHUB_OPERATIONS,
  },
  {
    name: "cloudflare",
    repo: "cloudflare/api-schemas",
    commit: "8b1a451819bc546d410e41cca71a86bcc2779808",
    path: "openapi.json",
    out: "cloudflare.openapi.json",
    operations: CLOUDFLARE_OPERATIONS,
  },
];

async function download(source: Source): Promise<{ doc: OpenApiDocument; sha256: string }> {
  const url = `https://raw.githubusercontent.com/${source.repo}/${source.commit}/${source.path}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  const text = await res.text();
  return { doc: JSON.parse(text), sha256: createHash("sha256").update(text).digest("hex") };
}

/** Every "#/components/<kind>/<name>" reachable from `node`, transitively. */
function collectRefs(doc: OpenApiDocument, node: unknown, seen: Set<string>): void {
  if (Array.isArray(node)) {
    for (const n of node) collectRefs(doc, n, seen);
    return;
  }
  if (!node || typeof node !== "object") return;
  for (const [key, value] of Object.entries(node)) {
    if (key === "$ref" && typeof value === "string" && value.startsWith("#/components/") && !seen.has(value)) {
      seen.add(value);
      const [, , kind, name] = value.split("/");
      collectRefs(doc, doc.components?.[kind]?.[name], seen);
    } else {
      collectRefs(doc, value, seen);
    }
  }
}

/** Examples in the vendor's description reference a large components/examples
 *  section and are not needed: the fake writes its own values, and Prism gets
 *  ours. Dropped so the subset stays small and diffs stay readable. */
function withoutExamples<T>(node: T): T {
  if (Array.isArray(node)) return node.map(withoutExamples) as T;
  if (!node || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === "examples" || k === "example") continue;
    out[k] = withoutExamples(v);
  }
  return out as T;
}

export function subset(source: Source, full: OpenApiDocument, sha256: string): OpenApiDocument {
  const paths: OpenApiDocument["paths"] = {};
  for (const ref of source.operations) {
    const item = full.paths[ref.path];
    const op = item?.[ref.method];
    if (!op) throw new Error(`${source.name}: ${ref.method.toUpperCase()} ${ref.path} is not in ${source.repo}@${source.commit}`);
    paths[ref.path] ??= item.parameters ? { parameters: item.parameters } : {};
    paths[ref.path][ref.method] = op;
  }
  const trimmed = withoutExamples(paths);
  const refs = new Set<string>();
  collectRefs(full, trimmed, refs);
  const components: Record<string, Record<string, Schema>> = {};
  for (const ref of [...refs].sort()) {
    const [, , kind, name] = ref.split("/");
    (components[kind] ??= {})[name] = withoutExamples(full.components![kind][name]);
  }
  const securitySchemes = (full.components as any)?.securitySchemes;
  if (securitySchemes) components.securitySchemes = securitySchemes;
  return {
    openapi: full.openapi,
    info: { ...(full.info as object), "x-infralift-subset": `operations infralift calls, from ${source.repo}@${source.commit}/${source.path}` },
    "x-infralift-source": { repo: source.repo, commit: source.commit, path: source.path, sha256 },
    ...(full.servers ? { servers: full.servers } : {}),
    ...(full.security ? { security: full.security } : {}),
    paths: trimmed,
    components,
  };
}

/** Writes each seeded example into its operation's 200 response, filled out
 *  to the schema's required fields and then checked against that schema. A seed the description would
 *  reject stops the extraction: Prism would serve it, and infralift would be
 *  tested against a Cloudflare that does not exist. */
export function seedCloudflareExamples(doc: OpenApiDocument): string[] {
  const validator = new SpecValidator(doc);
  const problems: string[] = [];
  for (const [path, seed] of Object.entries(CF_EXAMPLES)) {
    const ref = { method: "get" as const, path };
    const schema = responseSchema(doc, ref, 200);
    if (!schema) {
      problems.push(`${path}: no JSON 200 response`);
      continue;
    }
    const example = fillRequired(doc, schema, seed);
    const error = validator.check(schema, example);
    if (error) problems.push(`${path}: ${error}`);
    const op = doc.paths[path].get;
    const content = op.responses["200"].content;
    const type = content["application/json"] ? "application/json" : Object.keys(content)[0];
    content[type] = { ...content[type], examples: { e2e: { summary: "infralift e2e seed (e2e/specs/cloudflare-seed.ts)", value: example } } };
  }
  return problems;
}

async function main(): Promise<void> {
  const check = process.argv.includes("--check");
  let drift = false;
  for (const source of SOURCES) {
    const { doc: full, sha256 } = await download(source);
    const doc = subset(source, full, sha256);
    if (source.name === "cloudflare") {
      const problems = seedCloudflareExamples(doc);
      if (problems.length) throw new Error(`Cloudflare seed does not match the description:\n  ${problems.join("\n  ")}`);
    }
    const text = `${JSON.stringify(doc, null, 1)}\n`;
    const out = join(here, source.out);
    if (check) {
      const committed = await readFile(out, "utf8").catch(() => "");
      if (committed !== text) {
        drift = true;
        console.error(`${source.out} differs from a fresh extraction of ${source.repo}@${source.commit}; run tsx e2e/specs/extract.ts`);
      } else {
        console.log(`${source.out}: matches ${source.repo}@${source.commit.slice(0, 12)} (${source.operations.length} operations)`);
      }
    } else {
      await writeFile(out, text);
      console.log(`wrote ${source.out}: ${source.operations.length} operations, ${Object.values(doc.components ?? {}).reduce((n, c) => n + Object.keys(c).length, 0)} components, ${text.length} bytes`);
    }
  }
  if (drift) process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
