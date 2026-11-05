import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 as Ajv } from "ajv/dist/2020.js";
import type { GitHost } from "@infralift/shared";
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
//     stack.json   manifest: layers, input schema, rendered files, seeds
//     files/       copied verbatim for every project (executable bits kept)
//     deliveries/<delivery>/files/
//                  the CI files and credential wiring of one delivery
//                  layer (GitHub Actions, GitLab CI); only the chosen one
//                  is rendered
//     templates/   the few files that vary per project, {{var}} syntax
//
// infralift owns the stack from here on. It started as app-foundry's own
// deploy/ (stack.json "source"); the golden test keeps the templates
// reproducing that commit's main.tf and backend.tf for the GitHub delivery.
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
  /** The app this stack deploys, and the GitHub template a new repo comes from. */
  template: { slug: string; name: string; description: string; repo: string };
  /** Where it runs. The dashboard pairs a template with a target to pick a stack. */
  target: { slug: string; name: string };
  /** How the app runs on the target. One per stack for now. */
  runtime: { slug: string; name: string };
  /** What builds and deploys it. Each delivery runs on one git host, which
   *  is the compatibility rule the API and the dashboard enforce. */
  deliveries: StackDelivery[];
  source: { repo: string; commit: string };
  inputSchema: Record<string, unknown>;
  /** Inputs that reproduce the source repo's own deploy/; CI renders with these. */
  example: TfArguments;
  rendered: { path: string; template: string; when?: When }[];
  exclude?: { prefix: string; when?: When }[];
  seed?: string[];
}

export interface StackDelivery {
  slug: string;
  name: string;
  gitHost: GitHost;
}

/** The git hosts a stack can deploy from: those of its deliveries. */
export function stackGitHosts(m: StackManifest): GitHost[] {
  return [...new Set(m.deliveries.map((d) => d.gitHost))];
}

/** The delivery a project uses on a host: the one it names, or the
 *  stack's first delivery for that host. */
export function deliveryFor(
  m: StackManifest,
  host: GitHost,
  requested?: unknown
): StackDelivery | null {
  if (typeof requested === "string") {
    const d = m.deliveries.find((x) => x.slug === requested);
    return d && d.gitHost === host ? d : null;
  }
  return m.deliveries.find((x) => x.gitHost === host) ?? null;
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
  const delivery = manifest.deliveries.find((d) => d.slug === args.delivery);
  if (!delivery) {
    throw new TfInputValidationError([`unknown delivery ${String(args.delivery)}`]);
  }
  const templateArgs: TfArguments = {
    ...args,
    [`backend_${args.backend}`]: true,
    [`delivery_${delivery.gitHost}`]: true,
    ci_name: delivery.name,
    change_request: delivery.gitHost === "gitlab" ? "merge request" : "PR",
    ci_store:
      delivery.gitHost === "gitlab"
        ? "this project's CI/CD variables"
        : "this repository's Actions settings",
    state_tool: args.backend === "tfc" ? "Terraform (Terraform Cloud)" : "OpenTofu",
  };

  const stackDir = join(dir, manifest.slug);
  const seed = new Set(manifest.seed ?? []);
  const excluded = (path: string) =>
    (manifest.exclude ?? []).some(
      (x) => path.startsWith(x.prefix) && matches(x.when, args)
    );
  const files = new Map<string, StackFile>();

  for (const filesDir of [
    join(stackDir, "files"),
    join(stackDir, "deliveries", delivery.slug, "files"),
  ]) {
    for (const full of walk(filesDir)) {
      const path = relative(filesDir, full).split(sep).join("/");
      if (excluded(path)) continue;
      if (files.has(path)) {
        throw new Error(`stack ${manifest.slug}: ${path} is both common and delivery-specific`);
      }
      files.set(path, {
        path,
        content: readFileSync(full, "utf8"),
        mode: statSync(full).mode & 0o111 ? "100755" : "100644",
        ownership: seed.has(path) ? "seed" : "managed",
      });
    }
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
