// ---------------------------------------------------------------------------
// One self-contained description from a vendor's multi-file one, holding only
// the operations infralift calls.
//
// DigitalOcean splits its OpenAPI description over hundreds of YAML files and
// Azure splits each resource provider's Swagger over a file per area plus a
// shared common-types tree; Netlify's is one Swagger 2.0 file. None of them
// can be handed to Prism or to the validator as they are. bundle() reads the
// root file at the pinned commit, follows every $ref the listed operations
// reach (fetching the other files from the same commit), and writes one
// document whose refs are all local:
//
//   - a ref reached from inside a schema becomes a named definition
//     (#/definitions/<name> for Swagger, #/components/schemas/<name> for
//     OpenAPI), so recursive schemas stay finite;
//   - any other ref (a parameter, a response, a whole operation file) is
//     inlined where it is used.
//
// Examples are dropped on the way, as extract.ts drops them for the single
// file descriptions: they reference example files infralift has no use for.
// Names are assigned in traversal order, so the same pin always produces the
// same document.
// ---------------------------------------------------------------------------

import { posix } from "node:path";
import YAML from "yaml";
import type { OperationRef } from "./openapi.js";

/** Reads one file of the description by its repository path. */
export type FileReader = (repoPath: string) => Promise<unknown>;

/** Keys never followed: examples (and the files they point at) are not needed. */
const SKIPPED_KEYS = new Set(["example", "examples", "x-ms-examples", "x-codeSamples"]);

export interface BundleInput {
  /** Root files, each with the operations to take from it. */
  roots: { path: string; operations: OperationRef[] }[];
  read: FileReader;
}

export interface Bundled {
  /** "2.0" when the roots are Swagger, else the OpenAPI version of the first root. */
  version: { swagger: string } | { openapi: string };
  info: Record<string, unknown>;
  paths: Record<string, Record<string, unknown>>;
  /** Named schemas, keyed by their assigned name. */
  schemas: Record<string, unknown>;
}

/** A fetching reader for raw.githubusercontent.com at a commit, caching each file. */
export function githubReader(repo: string, commit: string): FileReader {
  const cache = new Map<string, Promise<unknown>>();
  return (repoPath) => {
    let pending = cache.get(repoPath);
    if (!pending) {
      const url = `https://raw.githubusercontent.com/${repo}/${commit}/${repoPath}`;
      pending = fetch(url, { signal: AbortSignal.timeout(120_000) }).then(async (res) => {
        if (!res.ok) throw new Error(`${url} answered ${res.status}`);
        const text = await res.text();
        return repoPath.endsWith(".json") ? JSON.parse(text) : YAML.parse(text, { maxAliasCount: -1 });
      });
      cache.set(repoPath, pending);
    }
    return pending;
  };
}

function decodePointer(pointer: string): string[] {
  return pointer
    .replace(/^#?\/?/, "")
    .split("/")
    .filter((p) => p !== "")
    .map((p) => decodeURIComponent(p).replace(/~1/g, "/").replace(/~0/g, "~"));
}

function at(node: unknown, pointer: string, where: string): unknown {
  let n: any = node;
  for (const part of decodePointer(pointer)) {
    n = n?.[part];
    if (n === undefined) throw new Error(`${where} does not exist`);
  }
  return n;
}

class Bundler {
  /** "<file>#<pointer>" of each named schema, to its assigned name. */
  private readonly names = new Map<string, string>();
  private readonly taken = new Set<string>();
  readonly schemas: Record<string, unknown> = {};

  constructor(
    private readonly read: FileReader,
    private readonly schemaPrefix: string
  ) {}

  /** `node` from `file` with every ref resolved as described above. */
  async resolve(node: unknown, file: string, inSchema: boolean): Promise<unknown> {
    if (Array.isArray(node)) {
      const out: unknown[] = [];
      for (const n of node) out.push(await this.resolve(n, file, inSchema));
      return out;
    }
    if (!node || typeof node !== "object") return node;
    const obj = node as Record<string, unknown>;
    if (typeof obj.$ref === "string") return this.follow(obj, file, inSchema);
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (inSchema && (key === "properties" || key === "patternProperties") && value && typeof value === "object") {
        // Named by the vendor: a property called "example" is a property.
        const props: Record<string, unknown> = {};
        for (const [name, prop] of Object.entries(value)) props[name] = await this.resolve(prop, file, true);
        out[key] = props;
        continue;
      }
      if (SKIPPED_KEYS.has(key)) continue;
      // A parameter's, response's or media type's "schema" starts a schema.
      out[key] = await this.resolve(value, file, inSchema || key === "schema");
    }
    return out;
  }

  private async follow(obj: Record<string, unknown>, file: string, inSchema: boolean): Promise<unknown> {
    const ref = obj.$ref as string;
    const [target, pointer = ""] = ref.split("#");
    const targetFile = target ? posix.normalize(posix.join(posix.dirname(file), target)) : file;
    const key = `${targetFile}#${pointer}`;
    const schemaLike = inSchema || /^\/(definitions|components\/schemas)\//.test(pointer);
    if (!schemaLike) {
      const body = at(await this.read(targetFile), pointer, key);
      return this.resolve(body, targetFile, false);
    }
    let name = this.names.get(key);
    if (!name) {
      name = this.assignName(targetFile, pointer);
      this.names.set(key, name);
      this.schemas[name] = {}; // claimed before resolving, so a cycle finds it
      const body = at(await this.read(targetFile), pointer, key);
      this.schemas[name] = await this.resolve(body, targetFile, true);
    }
    return { $ref: `${this.schemaPrefix}${name}` };
  }

  private assignName(file: string, pointer: string): string {
    const parts = decodePointer(pointer);
    const base = (parts.length ? parts[parts.length - 1] : posix.basename(file).replace(/\.(ya?ml|json)$/, "")).replace(/[^A-Za-z0-9_.-]/g, "_");
    let name = base;
    for (let n = 2; this.taken.has(name); n++) name = `${base}_${n}`;
    this.taken.add(name);
    return name;
  }
}

/** The listed operations from `roots`, with everything they reference. */
export async function bundle(input: BundleInput): Promise<Bundled> {
  const first = (await input.read(input.roots[0].path)) as Record<string, any>;
  const swagger = typeof first.swagger === "string";
  const bundler = new Bundler(input.read, swagger ? "#/definitions/" : "#/components/schemas/");
  const paths: Bundled["paths"] = {};
  for (const root of input.roots) {
    const doc = (await input.read(root.path)) as Record<string, any>;
    for (const ref of root.operations) {
      let item = doc.paths?.[ref.path];
      if (item?.$ref) item = await bundler.resolve(item, root.path, false);
      const op = item?.[ref.method];
      if (!op) throw new Error(`${ref.method.toUpperCase()} ${ref.path} is not in ${root.path}`);
      const target = (paths[ref.path] ??= {});
      if (item.parameters && !target.parameters) target.parameters = await bundler.resolve(item.parameters, root.path, false);
      target[ref.method] = await bundler.resolve(op, root.path, false);
    }
  }
  return {
    version: swagger ? { swagger: first.swagger } : { openapi: first.openapi },
    // Title and version only: DigitalOcean's description is itself a $ref.
    info: { title: first.info?.title ?? "", version: first.info?.version ?? "" },
    paths,
    schemas: bundler.schemas,
  };
}
