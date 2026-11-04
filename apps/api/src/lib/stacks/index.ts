import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 as Ajv } from "ajv/dist/2020.js";
import {
  renderTemplate,
  TfInputValidationError,
  type TfArguments,
} from "../tf/render.js";

// ---------------------------------------------------------------------------
// Stacks: whole deploy setups (infra, server scripts, CI workflows) rendered
// into a customer's app repository.
//
// A template (render.ts) is one .tf file. A stack is a directory tree that only
// works as a unit, so it is stored on disk as files rather than as a DB row:
//
//   apps/api/stacks/<slug>/
//     stack.json   manifest: input schema, rendered files, seed files
//     files/       copied verbatim (executable bits kept)
//     templates/   the few files that vary per project, {{var}} syntax
//
// Every file is either "managed" (infralift rewrites it on each change) or
// "seed" (written only when the repo does not have it yet). That is how
// generated/ stays ours while overrides.tf stays the customer's.
// ---------------------------------------------------------------------------

const STACKS_DIR = fileURLToPath(new URL("../../../stacks/", import.meta.url));

type When = Record<string, string>;

export interface StackManifest {
  slug: string;
  name: string;
  description: string;
  source: { repo: string; commit: string };
  inputSchema: Record<string, unknown>;
  /** Inputs that reproduce the source repo's own deploy/; CI renders with these. */
  example: TfArguments;
  rendered: { path: string; template: string; when?: When }[];
  exclude?: { prefix: string; when?: When }[];
  seed?: string[];
}

export interface StackFile {
  path: string;
  content: string;
  /** git file mode: scripts the box runs directly must stay executable */
  mode: "100644" | "100755";
  ownership: "managed" | "seed";
}

const ajv = new Ajv({ allErrors: true, strict: false, useDefaults: true });

export function listStacks(dir = STACKS_DIR): StackManifest[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => loadManifest(d.name, dir))
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

export function getStack(slug: string, dir = STACKS_DIR): StackManifest | null {
  if (!/^[a-z0-9-]+$/.test(slug)) return null;
  try {
    return loadManifest(slug, dir);
  } catch {
    return null;
  }
}

function loadManifest(slug: string, dir: string): StackManifest {
  const manifest = JSON.parse(
    readFileSync(join(dir, slug, "stack.json"), "utf8")
  ) as StackManifest;
  if (manifest.slug !== slug) {
    throw new Error(`stack ${slug}: manifest slug is ${manifest.slug}`);
  }
  return manifest;
}

/** Validates inputs against the stack's schema and fills in its defaults.
 * Returns a new object; the caller's is not modified. */
export function resolveStackInputs(
  manifest: StackManifest,
  inputs: TfArguments
): TfArguments {
  const resolved: TfArguments = { ...inputs };
  const validate = ajv.compile(manifest.inputSchema);
  if (!validate(resolved)) {
    throw new TfInputValidationError(
      (validate.errors ?? []).map(
        (e) => `${e.instancePath || "(root)"} ${e.message ?? "invalid"}`
      )
    );
  }
  if (resolved.backend === "tfc" && resolved.tfc_workspace === undefined) {
    resolved.tfc_workspace = resolved.name;
  }
  return resolved;
}

function matches(when: When | undefined, args: TfArguments): boolean {
  return Object.entries(when ?? {}).every(([k, v]) => args[k] === v);
}

function walk(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/** Renders a stack into the files to commit, sorted by path. */
export function renderStack(
  manifest: StackManifest,
  inputs: TfArguments,
  dir = STACKS_DIR
): StackFile[] {
  const args = resolveStackInputs(manifest, inputs);
  // Flags for {{#if}} blocks, which test presence rather than value.
  const templateArgs: TfArguments = {
    ...args,
    [`backend_${args.backend}`]: true,
    state_tool: args.backend === "tfc" ? "Terraform (Terraform Cloud)" : "OpenTofu",
  };

  const stackDir = join(dir, manifest.slug);
  const seed = new Set(manifest.seed ?? []);
  const excluded = (path: string) =>
    (manifest.exclude ?? []).some(
      (x) => path.startsWith(x.prefix) && matches(x.when, args)
    );
  const files = new Map<string, StackFile>();

  const filesDir = join(stackDir, "files");
  for (const full of walk(filesDir)) {
    const path = relative(filesDir, full).split(sep).join("/");
    if (excluded(path)) continue;
    files.set(path, {
      path,
      content: readFileSync(full, "utf8"),
      mode: statSync(full).mode & 0o111 ? "100755" : "100644",
      ownership: seed.has(path) ? "seed" : "managed",
    });
  }

  for (const r of manifest.rendered) {
    if (!matches(r.when, args) || excluded(r.path)) continue;
    if (files.has(r.path)) {
      throw new Error(`stack ${manifest.slug}: ${r.path} is both copied and rendered`);
    }
    const body = readFileSync(join(stackDir, "templates", r.template), "utf8");
    files.set(r.path, {
      path: r.path,
      content: renderTemplate(body, templateArgs),
      mode: "100644",
      ownership: seed.has(r.path) ? "seed" : "managed",
    });
  }

  return [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
}
