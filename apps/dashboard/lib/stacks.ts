// Stacks as the dashboard sees them (GET /tf/stacks, listStackSummaries in
// apps/api/src/services/stacks.ts), and the settings helpers the new-project
// page and a stack project's settings drawer share.

import type { GitHost } from "@infralift/shared";

export interface SchemaProperty {
  type?: string;
  enum?: (string | number)[];
  pattern?: string;
  minimum?: number;
  maximum?: number;
  default?: string | number;
  description?: string;
}

export interface InputSchema {
  properties?: Record<string, SchemaProperty>;
  required?: string[];
}

export type Settings = Record<string, string | number | boolean>;

export interface Stack {
  slug: string;
  name: string;
  description: string;
  /** The app this stack deploys and the repository template a new repo was
   *  created from. Every catalog stack has one today; see isAppStack. */
  template?: { slug: string; name: string; description: string; repo: string };
  target: { slug: string; name: string };
  runtime: { slug: string; name: string };
  deliveries: { slug: string; name: string; gitHost: GitHost }[];
  gitHosts: GitHost[];
  inputSchema: InputSchema;
  example: Settings;
}

/** Catalog stacks that deliver an application (a Dockerfile, app CI and
 *  hosting). ADR 0010 names app-foundry-hetzner as the only one today. */
const APP_STACK_SLUGS = new Set(["app-foundry-hetzner"]);

/**
 * True for a stack that deploys an app rather than infrastructure.
 *
 * ADR 0010 (docs/adr/0010-a-project-is-one-accounts-infrastructure.md) takes
 * these out of /projects/new: a project is one cloud account's
 * infrastructure, not an app. They are hidden here, not deleted: existing
 * stack projects keep rendering, and their settings drawer still finds the
 * stack in the full list. A stack is an app stack when the ADR names it, or
 * when it carries an app template (a repository a new repo is created from).
 */
export function isAppStack(stack: Pick<Stack, "slug" | "template">): boolean {
  return APP_STACK_SLUGS.has(stack.slug) || Boolean(stack.template?.repo);
}

/** The stacks /projects/new offers: everything that is not an app stack. */
export function newProjectStacks<T extends Pick<Stack, "slug" | "template">>(stacks: T[]): T[] {
  return stacks.filter((s) => !isAppStack(s));
}

// -- settings ------------------------------------------------------------------

/** Form-only key for the chosen Terraform Cloud connection. It is sent as
 *  tfcConnectionId, not as a stack setting; the API fills tfc_organization
 *  from the connection. */
export const TFC_CONNECTION = "__tfc_connection";

/** The state backend has its own control; the generic settings form skips it. */
export const BACKEND_KEYS = new Set(["backend", "tfc_organization", "tfc_workspace", TFC_CONNECTION]);

/** Form values are strings; the API wants the schema's types. Blank fields are
 *  left out so the stack's defaults apply. */
export function toSettings(schema: InputSchema, values: Record<string, string>): Settings {
  const out: Settings = {};
  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    const raw = values[key];
    if (raw === undefined || raw === "") continue;
    out[key] = prop.type === "integer" || prop.type === "number" ? Number(raw) : raw;
  }
  return out;
}

export function toValues(settings: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(settings ?? {})) out[k] = String(v);
  return out;
}

/** The one cross-field rule a person is likely to trip over, said plainly
 *  before the API answers with schema language. */
export function backendProblem(values: Record<string, string>): string | null {
  return values.backend === "tfc" && !values[TFC_CONNECTION]
    ? "Terraform Cloud needs a connection: the workspace goes in its organization."
    : null;
}

export function tfcConnectionOf(values: Record<string, string>): string | null {
  return values.backend === "tfc" ? values[TFC_CONNECTION] || null : null;
}

/** Settings sent for the chosen backend only: switching back to R2 must not
 *  carry a stale Terraform Cloud org along. */
export function withBackend(values: Record<string, string>): Record<string, string> {
  const v: Record<string, string> = { ...values, backend: values.backend || "r2" };
  delete v[TFC_CONNECTION];
  // Always the connection's organization, filled in by the API.
  delete v.tfc_organization;
  if (v.backend !== "tfc") delete v.tfc_workspace;
  return v;
}
