import { z } from "zod";
import type { TfcOutput, TfcVariable } from "./tfc-client.js";

// ---------------------------------------------------------------------------
// Adopted workspaces and workspace extensions.
//
// A project is backed by one or more workspaces in the customer's own HCP
// Terraform or Terraform Enterprise org. Some are adopted: they existed before
// infralift, were handcrafted, and are recorded and templatized but never
// upgraded. Others are extensions: new workspaces holding new infrastructure,
// reading outputs from the workspaces they depend on.
//
// Everything here is pure so the shape of what gets written to a customer's
// org and repo is testable without one.
// ---------------------------------------------------------------------------

// -- credentials --------------------------------------------------------------

// Stored encrypted as JSON in ProviderConnection.encryptedToken, provider
// "tfc". Unlike the assessment connectors this token is not read-only:
// creating extension workspaces, run triggers and remote-state sharing all
// need write access to the customer's org.
export const tfcCredentialSchema = z.object({
  hostname: z
    .string()
    .regex(/^[a-z0-9.-]+(:\d+)?$/i)
    .default("app.terraform.io"),
  organization: z.string().regex(/^[A-Za-z0-9_-]+$/),
  token: z.string().min(1),
});
export type TfcCredential = z.infer<typeof tfcCredentialSchema>;

// -- variable snapshot ---------------------------------------------------------

export interface StoredInput {
  key: string;
  category: "terraform" | "env";
  hcl: boolean;
  sensitive: boolean;
  description: string;
  /** Absent when sensitive. */
  value?: string;
}

/**
 * What gets persisted from a workspace's variables. Sensitive values are
 * dropped here as well as in the client, because this is the last point
 * before the database and the client is not the only possible caller.
 */
export function snapshotInputs(vars: TfcVariable[]): StoredInput[] {
  return vars
    .map((v) => ({
      key: v.key,
      category: v.category,
      hcl: v.hcl,
      sensitive: v.sensitive,
      description: v.description,
      ...(v.sensitive || v.value === null ? {} : { value: v.value }),
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

// -- templatizing an adopted workspace -------------------------------------------

/** Template placeholders only accept [A-Za-z0-9_]; Terraform names also allow "-". */
export function placeholderName(key: string): string {
  return key.replace(/-/g, "_");
}

const HCL_IDENT = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const SHA = /^[0-9a-f]{40}$/;

// A string value interpolated inside "..." must not be able to close the
// string or start an interpolation.
const SAFE_HCL_STRING = '^(?![\\s\\S]*\\$\\{)(?![\\s\\S]*%\\{)[^"\\\\\\n]*$';

export interface AdoptedTemplate {
  templateBody: string;
  inputSchema: Record<string, unknown>;
  /** Variables left out of the template, and why. */
  skipped: { key: string; reason: string }[];
}

export class NotTemplatizableError extends Error {}

/**
 * Turn an adopted workspace into a reusable template: a module block whose
 * source is the workspace's own repository pinned to the commit it was
 * adopted at, with its Terraform variables as the template's inputs.
 *
 * The workspace's code is not copied or rewritten. Pinning the ref is what
 * makes the template frozen: a new version only exists when someone adopts
 * again at a newer commit.
 *
 * Sensitive variables become `variable` declarations passed through, never
 * template inputs, so a secret is never rendered into a file that gets
 * committed. Env-category variables are workspace settings (credentials,
 * TF_LOG), not module inputs, and are left out.
 */
export function templatizeAdopted(opts: {
  workspaceName: string;
  repoUrl: string | null;
  workingDirectory: string | null;
  commitSha: string | null;
  inputs: StoredInput[];
}): AdoptedTemplate {
  if (!opts.repoUrl) {
    throw new NotTemplatizableError(
      "workspace has no VCS repository (CLI- or API-driven), so there is no source to pin a template to"
    );
  }
  if (!opts.commitSha || !SHA.test(opts.commitSha)) {
    throw new NotTemplatizableError(
      "workspace's current configuration has no commit SHA to pin to"
    );
  }
  const url = opts.repoUrl.replace(/\/+$/, "");
  if (!/^https:\/\/[^\s"\\]+$/.test(url)) {
    throw new NotTemplatizableError(`unsupported repository URL: ${url}`);
  }
  const dir = (opts.workingDirectory ?? "").replace(/^\/+|\/+$/g, "");
  if (/["\\\s]|\.\./.test(dir)) {
    throw new NotTemplatizableError(`unsupported working directory: ${dir}`);
  }
  const source = `git::${url}.git${dir ? `//${dir}` : ""}?ref=${opts.commitSha}`;
  const moduleLabel = opts.workspaceName.replace(/[^A-Za-z0-9_-]/g, "_");

  const skipped: { key: string; reason: string }[] = [];
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  const assignments: [string, string][] = [];
  const passthrough: string[] = [];

  for (const input of opts.inputs) {
    if (input.category !== "terraform") {
      skipped.push({ key: input.key, reason: "environment variable, not a module input" });
      continue;
    }
    if (!HCL_IDENT.test(input.key)) {
      skipped.push({ key: input.key, reason: "not a valid Terraform variable name" });
      continue;
    }
    if (input.sensitive) {
      passthrough.push(
        `variable "${input.key}" {\n  sensitive = true\n}`
      );
      assignments.push([input.key, `var.${input.key}`]);
      continue;
    }
    const ph = placeholderName(input.key);
    if (properties[ph]) {
      skipped.push({ key: input.key, reason: `collides with another variable as {{${ph}}}` });
      continue;
    }
    const description = input.description || undefined;
    if (input.hcl) {
      // An HCL expression is inserted as-is, which is the point of an HCL
      // variable. It renders into the org's own repository only.
      properties[ph] = { type: "string", minLength: 1, description, default: input.value };
      assignments.push([input.key, `{{${ph}}}`]);
    } else {
      properties[ph] = { type: "string", pattern: SAFE_HCL_STRING, description, default: input.value };
      assignments.push([input.key, `"{{${ph}}}"`]);
    }
    required.push(ph);
  }

  const header = [
    `# Adopted from workspace "${opts.workspaceName}" at ${opts.commitSha.slice(0, 7)}.`,
    `# Frozen: infralift does not upgrade adopted templates. Adopt again at a`,
    `# newer commit to get a new version.`,
  ];
  const body = [
    ...header,
    "",
    ...(passthrough.length ? [...passthrough, ""] : []),
    `module "${moduleLabel}" {`,
    `  source = "${source}"`,
    ...(assignments.length ? ["", ...alignHcl(assignments, "  ")] : []),
    `}`,
    "",
  ].join("\n");

  return {
    templateBody: body,
    inputSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties,
      required,
      additionalProperties: false,
    },
    skipped,
  };
}

/** Slug for an org-private adopted template. TfTemplate.slug is globally unique. */
export function adoptedTemplateSlug(orgId: string, workspaceName: string): string {
  const ws = workspaceName.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return `adopted-${orgId.toLowerCase()}-${ws}`.slice(0, 120);
}

// -- dependency graph -----------------------------------------------------------

/** `workspaceId` reads outputs from `dependsOnId`. */
export interface DependencyEdge {
  workspaceId: string;
  dependsOnId: string;
}

export class DependencyCycleError extends Error {
  constructor(public cycle: string[]) {
    super(`dependency cycle: ${cycle.join(" -> ")}`);
  }
}

/**
 * Apply order: every workspace after the workspaces it depends on. Ties are
 * broken by id so the order is stable between calls. Throws on a cycle,
 * naming it, rather than returning a partial order.
 */
export function applyOrder(ids: string[], edges: DependencyEdge[]): string[] {
  const nodes = [...new Set(ids)].sort();
  const known = new Set(nodes);
  const deps = new Map<string, string[]>(nodes.map((n) => [n, []]));
  for (const e of edges) {
    if (!known.has(e.workspaceId) || !known.has(e.dependsOnId)) {
      throw new Error(`edge references an unknown workspace: ${e.workspaceId} -> ${e.dependsOnId}`);
    }
    deps.get(e.workspaceId)!.push(e.dependsOnId);
  }
  for (const list of deps.values()) list.sort();

  const order: string[] = [];
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];
  const visit = (n: string) => {
    const s = state.get(n);
    if (s === "done") return;
    if (s === "visiting") {
      throw new DependencyCycleError([...stack.slice(stack.indexOf(n)), n]);
    }
    state.set(n, "visiting");
    stack.push(n);
    for (const d of deps.get(n)!) visit(d);
    stack.pop();
    state.set(n, "done");
    order.push(n);
  };
  for (const n of nodes) visit(n);
  return order;
}

/** Destroy order is the reverse: nothing is destroyed while something still reads it. */
export function destroyOrder(ids: string[], edges: DependencyEdge[]): string[] {
  return applyOrder(ids, edges).reverse();
}

// -- wiring an extension to its bases ------------------------------------------------

export interface WiringBase {
  workspaceName: string;
  /** extension-local name -> base output name */
  outputs: Record<string, string>;
}

export class WiringError extends Error {}

/**
 * The `deps.tf` an extension workspace needs to read its bases' outputs.
 *
 * Uses `terraform_remote_state` with the remote backend rather than the tfe
 * provider's `tfe_outputs`: inside an HCP Terraform run the remote backend
 * authenticates with the run's own token, and access is granted by the base
 * workspace's remote-state-consumers list, which infralift sets. `tfe_outputs`
 * would need a TFE_TOKEN planted in the extension workspace, and infralift
 * should not be copying the customer's API token into their workspaces. It
 * also works unchanged under OpenTofu.
 */
export function renderWiring(opts: {
  hostname: string;
  organization: string;
  bases: WiringBase[];
}): string {
  const seenLocals = new Set<string>();
  const seenLabels = new Set<string>();
  const blocks: string[] = [
    "# Generated by infralift. Reads outputs from the workspaces this one extends.",
    "# The base workspaces share state with this workspace by name; removing a",
    "# block here does not revoke that.",
    "",
  ];
  const locals: [string, string][] = [];
  for (const base of [...opts.bases].sort((a, b) => a.workspaceName.localeCompare(b.workspaceName))) {
    if (!HCL_IDENT.test(base.workspaceName)) {
      throw new WiringError(`workspace name is not usable as an HCL label: ${base.workspaceName}`);
    }
    const label = base.workspaceName.replace(/-/g, "_");
    if (seenLabels.has(label)) {
      throw new WiringError(`two bases map to the same label "${label}"`);
    }
    seenLabels.add(label);
    blocks.push(
      `data "terraform_remote_state" "${label}" {`,
      `  backend = "remote"`,
      `  config = {`,
      `    hostname     = "${opts.hostname}"`,
      `    organization = "${opts.organization}"`,
      `    workspaces = {`,
      `      name = "${base.workspaceName}"`,
      `    }`,
      `  }`,
      `}`,
      ""
    );
    for (const [local, output] of Object.entries(base.outputs).sort()) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(local) || !HCL_IDENT.test(output)) {
        throw new WiringError(`invalid wiring name: ${local} = ${output}`);
      }
      if (seenLocals.has(local)) {
        throw new WiringError(`local "${local}" is wired from more than one base`);
      }
      seenLocals.add(local);
      locals.push([local, `data.terraform_remote_state.${label}.outputs.${output}`]);
    }
  }
  if (locals.length) blocks.push("locals {", ...alignHcl(locals, "  "), "}", "");
  return blocks.join("\n");
}

/** `key = value` lines aligned the way `terraform fmt` aligns them. */
function alignHcl(pairs: [string, string][], indent: string): string[] {
  const width = Math.max(...pairs.map(([k]) => k.length));
  return pairs.map(([k, v]) => `${indent}${k.padEnd(width)} = ${v}`);
}

/** Wiring requests that name outputs a base does not have. */
export function missingOutputs(
  requested: Record<string, string>,
  available: TfcOutput[] | { name: string }[]
): string[] {
  const names = new Set(available.map((o) => o.name));
  return Object.values(requested).filter((o) => !names.has(o));
}
