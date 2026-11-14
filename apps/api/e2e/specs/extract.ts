// ---------------------------------------------------------------------------
// Writes the vendor description subsets the e2e stack serves and validates
// against, from the pins in sources.ts.
//
//   tsx e2e/specs/extract.ts           download the pinned descriptions, write
//                                      each entry's subset beside this file
//   tsx e2e/specs/extract.ts --check   the same, but fail if what it would write
//                                      differs from what is committed
//   tsx e2e/specs/extract.ts render    only the named entries (either mode)
//
// Each subset holds only the operations infralift calls and what they
// reference, taken from the vendor's own published description at a pinned
// commit. REST subsets are OpenAPI (Swagger, discovery documents and Heroku's
// hyper-schema are converted, convert.ts); GraphQL subsets are SDL
// (graphql-subset.ts). The GitHub fake answers in, and refuses requests
// against, github.openapi.json; Prism serves the other REST subsets with the
// examples from seeds/, each checked against its response schema here; the
// provider fake executes GraphQL queries against the GraphQL subsets. Bumping
// a pin and re-running shows, as a diff, what changed in the vendor's contract
// for exactly the calls infralift makes.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildClientSchema, buildSchema, type GraphQLSchema } from "graphql";
import { bundle, githubReader } from "./bundle.js";
import { discoveryToOpenApi, hyperSchemaToOpenApi, swagger2ToOpenApi } from "./convert.js";
import { graphqlSubset, printSubset, queryProblems } from "./graphql-subset.js";
import { fillRequired, responseSchema, SpecValidator, type OpenApiDocument, type Schema } from "./openapi.js";
import { SEEDS } from "./seeds/index.js";
import { SOURCES, type GithubPin, type OpenApiSource, type SpecSource, type UrlPin } from "./sources.js";

const here = dirname(fileURLToPath(import.meta.url));

/** A pinned file's text and sha256. A UrlPin whose body no longer has the
 *  recorded digest stops the extraction: the archived copy is the pin. */
async function download(pin: GithubPin | UrlPin): Promise<{ text: string; sha256: string }> {
  const url = "url" in pin ? pin.url : `https://raw.githubusercontent.com/${pin.repo}/${pin.commit}/${pin.path}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  const text = await res.text();
  const sha256 = createHash("sha256").update(text).digest("hex");
  if ("url" in pin && sha256 !== pin.sha256) throw new Error(`${url} has sha256 ${sha256}, not the pinned ${pin.sha256}`);
  return { text, sha256 };
}

function pinLabel(pin: GithubPin | UrlPin): string {
  return "url" in pin ? `${pin.published} (archived copy ${pin.url})` : `${pin.repo}@${pin.commit}/${pin.path}`;
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

export function subset(source: OpenApiSource, full: OpenApiDocument, sha256: string): OpenApiDocument {
  const paths: OpenApiDocument["paths"] = {};
  for (const ref of source.operations) {
    const item = full.paths[ref.path];
    const op = item?.[ref.method];
    if (!op) throw new Error(`${source.name}: ${ref.method.toUpperCase()} ${ref.path} is not in ${pinLabel(source.pin)}`);
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
    info: { ...(full.info as object), "x-infralift-subset": `operations infralift calls, from ${pinLabel(source.pin)}` },
    "x-infralift-source": { ...source.pin, ...("url" in source.pin ? {} : { sha256 }) },
    ...(full.servers ? { servers: full.servers } : {}),
    ...(full.security ? { security: full.security } : {}),
    paths: trimmed,
    components,
  };
}

/** Writes each seeded example into its operation's 200 response, filled out
 *  to the schema's required fields and then checked against that schema. A
 *  seed the description would reject stops the extraction: Prism would serve
 *  it, and infralift would be tested against a vendor that does not exist.
 *  `examples` is keyed by the GET operation's path template. */
export function seedExamples(doc: OpenApiDocument, examples: Record<string, unknown>, seedFile: string): string[] {
  const validator = new SpecValidator(doc);
  const problems: string[] = [];
  for (const [path, seed] of Object.entries(examples)) {
    const ref = { method: "get" as const, path };
    if (!doc.paths[path]?.get) {
      problems.push(`${path}: not an operation in this subset`);
      continue;
    }
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
    content[type] = { ...content[type], examples: { e2e: { summary: `infralift e2e seed (e2e/specs/${seedFile})`, value: example } } };
  }
  return problems;
}

/** The connector calls recorded as undocumented must still be absent: if a
 *  pin bump adds one, the finding it records needs revisiting. */
function stillUndocumented(source: SpecSource, docs: Record<string, any>[]): string[] {
  const problems: string[] = [];
  for (const u of source.undocumented ?? []) {
    if (docs.some((d) => d.paths?.[u.path]?.[u.method])) {
      problems.push(`${u.method.toUpperCase()} ${u.path} is recorded as undocumented but the description now has it; revisit: ${u.note}`);
    }
  }
  return problems;
}

/** One entry's subset, as the text to commit. */
async function extract(source: SpecSource): Promise<string> {
  switch (source.format) {
    case "openapi": {
      const { text, sha256 } = await download(source.pin);
      const full = JSON.parse(text) as OpenApiDocument;
      fail(source, stillUndocumented(source, [full]));
      return json(seeded(source, subset(source, full, sha256)));
    }
    case "bundle": {
      const read = githubReader(source.repo, source.commit);
      const bundled = await bundle({ roots: source.roots, read });
      const roots = await Promise.all(source.roots.map((r) => read(r.path) as Promise<Record<string, any>>));
      fail(source, stillUndocumented(source, roots));
      const base: OpenApiDocument =
        "swagger" in bundled.version
          ? swagger2ToOpenApi(bundled)
          : { openapi: bundled.version.openapi, info: bundled.info, paths: bundled.paths as OpenApiDocument["paths"], components: { schemas: bundled.schemas as Record<string, Schema> } };
      return json(seeded(source, withSource(base, source.repo, source.commit, source.roots.map((r) => r.path))));
    }
    case "discovery": {
      const read = githubReader(source.repo, source.commit);
      const docs = await Promise.all(source.documents.map(async (d) => ({ doc: (await read(d.path)) as Record<string, any>, operations: d.operations })));
      const base = discoveryToOpenApi(docs);
      return json(seeded(source, withSource(base, source.repo, source.commit, source.documents.map((d) => d.path))));
    }
    case "hyper-schema": {
      const { text, sha256 } = await download(source.pin);
      const base = hyperSchemaToOpenApi(JSON.parse(text), source.operations);
      base.info = { ...base.info, "x-infralift-subset": `operations infralift calls, from ${pinLabel(source.pin)}` };
      base["x-infralift-source"] = { ...source.pin, sha256 };
      return json(seeded(source, base));
    }
    case "graphql": {
      const { text, sha256 } = await download(source.pin);
      const full: GraphQLSchema = source.schema === "sdl" ? buildSchema(text) : buildClientSchema((JSON.parse(text).data ?? JSON.parse(text)) as any);
      const stillRejected = (source.rejectedQueries ?? []).filter((r) => queryProblems(full, [r.query]).length === 0);
      fail(
        source,
        stillRejected.map((r) => `a query recorded as rejected now validates; revisit: ${r.note}`)
      );
      const sdl = printSubset(graphqlSubset(full, source.queries));
      return `# The part of ${pinLabel(source.pin)} (sha256 ${sha256})\n# that infralift's queries select (sources.ts). Written by e2e/specs/extract.ts; do not edit.\n\n${sdl}\n`;
    }
  }
}

function withSource(doc: OpenApiDocument, repo: string, commit: string, paths: string[]): OpenApiDocument {
  const label = paths.length === 1 ? `${repo}@${commit}/${paths[0]}` : `${repo}@${commit} (${paths.length} files)`;
  return {
    openapi: doc.openapi,
    info: { ...(doc.info as object), "x-infralift-subset": `operations infralift calls, from ${label}` },
    "x-infralift-source": { repo, commit, paths },
    paths: doc.paths,
    components: doc.components,
  };
}

function seeded(source: SpecSource, doc: OpenApiDocument): OpenApiDocument {
  const seed = SEEDS[source.name];
  if (!seed) return doc;
  const problems = seedExamples(doc, seed.examples, seed.file);
  if (problems.length) throw new Error(`${source.name}: the seed (e2e/specs/${seed.file}) does not match the description:\n  ${problems.join("\n  ")}`);
  return doc;
}

function fail(source: SpecSource, problems: string[]): void {
  if (problems.length) throw new Error(`${source.name}:\n  ${problems.join("\n  ")}`);
}

const json = (doc: OpenApiDocument): string => `${JSON.stringify(doc, null, 1)}\n`;

async function main(): Promise<void> {
  const check = process.argv.includes("--check");
  const only = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const unknown = only.filter((name) => !SOURCES.some((s) => s.name === name));
  if (unknown.length) throw new Error(`no such entry in sources.ts: ${unknown.join(", ")}`);
  let drift = false;
  for (const source of SOURCES.filter((s) => !only.length || only.includes(s.name))) {
    const text = await extract(source);
    const out = join(here, source.out);
    if (check) {
      const committed = await readFile(out, "utf8").catch(() => "");
      if (committed !== text) {
        drift = true;
        console.error(`${source.out} differs from a fresh extraction of its pin in sources.ts; run tsx e2e/specs/extract.ts ${source.name}`);
      } else {
        console.log(`${source.out}: matches its pin`);
      }
    } else {
      await writeFile(out, text);
      console.log(`wrote ${source.out}: ${text.length} bytes`);
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
