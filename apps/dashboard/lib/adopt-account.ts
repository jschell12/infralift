// "Adopt from an account" (ADR 0010, 0011): the page at
// /projects/new/adopt?connection=<id> lists what a cloud account holds that no
// infralift project manages, lets you pick some of it, and adopts the picks
// into a new project with POST /connections/:id/adopt.
//
// Everything here is free of React so it can be tested: grouping and
// selection, the request body, and turning the API's error bodies into
// sentences. The two fetch helpers are here too, because api() in lib/api.ts
// keeps neither the X-Next-Cursor header nor the lists a 409 or 400 carries.
//
// Shapes are @infralift/shared's (packages/shared/src/unmanaged.ts), which the
// API route (apps/api/src/routes/connections.ts) answers with.

import type { AdoptSelectedRequest, AdoptSelectedResult, UnmanagedPage, UnmanagedResource } from "@infralift/shared";
import { API_URL, errorMessageFor } from "./api";

/** Most picks one request may carry (ADOPT_MAX_RESOURCES in
 *  apps/api/src/services/unmanaged.ts). */
export const ADOPT_MAX_RESOURCES = 200;

/** How old a cached list can be (INVENTORY_TTL_MS in the same file), in
 *  minutes, for the copy beside Refresh. */
export const INVENTORY_MAX_AGE_MINUTES = 5;

// -- keys and grouping ------------------------------------------------------------

/** One resource's identity: its inventory type and the provider's id. The same
 *  pair the API takes back when adopting, joined so it fits in a Set. */
export function resourceKey(r: Pick<UnmanagedResource, "type" | "providerId">): string {
  return `${r.type}\n${r.providerId}`;
}

export interface ResourceGroup {
  type: string;
  resources: UnmanagedResource[];
  /** The keys in this group that can be picked. */
  adoptableKeys: string[];
}

/** Resources grouped by inventory type, types in alphabetical order and the
 *  API's order within each. The API already sorts by (type, id); sorting the
 *  types here keeps a page appended by "Load more" from adding a second group
 *  of a type that is already shown. */
export function groupByType(resources: UnmanagedResource[]): ResourceGroup[] {
  const byType = new Map<string, UnmanagedResource[]>();
  for (const r of resources) {
    const list = byType.get(r.type);
    if (list) list.push(r);
    else byType.set(r.type, [r]);
  }
  return [...byType.keys()].sort().map((type) => {
    const list = byType.get(type)!;
    return { type, resources: list, adoptableKeys: list.filter((r) => r.adoptable).map(resourceKey) };
  });
}

/** The next page appended to what is loaded, skipping anything already there
 *  (a refresh between pages can move a resource across the cursor). */
export function appendPage(loaded: UnmanagedResource[], next: UnmanagedResource[]): UnmanagedResource[] {
  const seen = new Set(loaded.map(resourceKey));
  return [...loaded, ...next.filter((r) => !seen.has(resourceKey(r)))];
}

// -- selection ---------------------------------------------------------------------

/** One resource in or out. Returns a new Set; the state stays immutable. */
export function toggleResource(selected: ReadonlySet<string>, key: string): Set<string> {
  const out = new Set(selected);
  if (out.has(key)) out.delete(key);
  else out.add(key);
  return out;
}

export type GroupSelection = "none" | "some" | "all";

/** Whether a group's checkbox reads checked, mixed or empty. Only resources
 *  that can be adopted count: a group whose adoptable ones are all picked is
 *  "all" even with disabled rows beside them. */
export function groupSelection(group: Pick<ResourceGroup, "adoptableKeys">, selected: ReadonlySet<string>): GroupSelection {
  const picked = group.adoptableKeys.filter((k) => selected.has(k)).length;
  if (picked === 0) return "none";
  return picked === group.adoptableKeys.length ? "all" : "some";
}

/** The group checkbox: picks every adoptable resource in the group, or, when
 *  they are all picked already, clears them. A mixed group fills up first. */
export function toggleGroup(group: Pick<ResourceGroup, "adoptableKeys">, selected: ReadonlySet<string>): Set<string> {
  const out = new Set(selected);
  if (groupSelection(group, selected) === "all") group.adoptableKeys.forEach((k) => out.delete(k));
  else group.adoptableKeys.forEach((k) => out.add(k));
  return out;
}

/** Picks that are still in the loaded list and still adoptable. A refresh
 *  reloads as many resources as were shown before it (the adopt page does
 *  that), so what this drops is what left the account or was adopted
 *  meanwhile; its key must not ride along into the request. */
export function keepLoadedPicks(selected: ReadonlySet<string>, loaded: UnmanagedResource[]): Set<string> {
  const live = new Set(loaded.filter((r) => r.adoptable).map(resourceKey));
  return new Set([...selected].filter((k) => live.has(k)));
}

// -- the target form and the request -------------------------------------------------

export interface AdoptForm {
  name: string;
  /** owner/name on GitHub. */
  repo: string;
  branch: string;
  /** The org's GitHub connection that opens the pull request. */
  gitConnectionId: string;
  /** Directory in the repository the project's Terraform goes in. */
  path: string;
  backendKind: "r2" | "s3";
  bucket: string;
  stateKey: string;
  /** R2 only: the Cloudflare account that holds the bucket. */
  accountId: string;
  /** S3 only. */
  region: string;
}

/** Sensible starting values for a provider ("aws" gives aws-adopted in
 *  infra/aws). The name is cut to fit the API's 32-character rule. */
export function defaultAdoptForm(provider: string): AdoptForm {
  const slug = provider.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  return {
    name: `${slug}-adopted`.slice(0, 32),
    repo: "",
    branch: "main",
    gitConnectionId: "",
    path: `infra/${slug}`,
    backendKind: "r2",
    bucket: "",
    stateKey: `${slug}/terraform.tfstate`,
    accountId: "",
    region: "us-east-1",
  };
}

// The API's own field rules (adoptSchema in apps/api/src/routes/connections.ts
// and isSafePath in apps/api/src/lib/import/check.ts), checked before sending
// so the message is about the field rather than about the schema.
const NAME_RULE = /^[a-z][a-z0-9-]{2,31}$/;
const REPO_RULE = /^[\w.-]+\/[\w.-]+$/;
const PATH_RULE = /^[A-Za-z0-9._/-]*$/;

/** The first thing stopping the form from being sent, said as a sentence, or
 *  null when it can go. */
export function adoptFormProblem(form: AdoptForm, picked: number): string | null {
  if (picked === 0) return "Pick at least one resource to adopt.";
  if (picked > ADOPT_MAX_RESOURCES) return `Pick at most ${ADOPT_MAX_RESOURCES} resources at a time.`;
  if (!NAME_RULE.test(form.name.trim()))
    return "Project name: 3 to 32 lowercase letters, digits and dashes, starting with a letter.";
  if (!form.gitConnectionId) return "Connect GitHub first: the adoption arrives as a pull request there.";
  if (!REPO_RULE.test(form.repo.trim())) return "Repository: owner/name, as on GitHub.";
  const path = form.path.trim();
  if (!PATH_RULE.test(path) || path.split("/").includes(".."))
    return "Directory: letters, digits, dots, dashes, underscores and slashes only.";
  if (!form.bucket.trim()) return "State bucket: name the bucket the state goes in.";
  if (!form.stateKey.trim()) return "State key: the path of the state file in the bucket.";
  if (form.backendKind === "r2" && !form.accountId.trim())
    return "Cloudflare account id: the account that holds the R2 bucket.";
  if (form.backendKind === "s3" && !form.region.trim()) return "Region: the AWS region of the S3 bucket.";
  return null;
}

/** The body for POST /connections/:id/adopt. Keys are sent in the order they
 *  appear in the loaded list, so the same picks always make the same body.
 *  (The API compares a resend's picks as a set, so order is not what makes it
 *  a replay.) Only picks in the loaded list are sent. */
export function buildAdoptRequest(
  form: AdoptForm,
  selected: ReadonlySet<string>,
  loaded: UnmanagedResource[]
): AdoptSelectedRequest {
  const resources = loaded
    .filter((r) => selected.has(resourceKey(r)))
    .map((r) => ({ type: r.type, providerId: r.providerId }));
  const backend =
    form.backendKind === "r2"
      ? { kind: "r2" as const, bucket: form.bucket.trim(), key: form.stateKey.trim(), accountId: form.accountId.trim() }
      : { kind: "s3" as const, bucket: form.bucket.trim(), key: form.stateKey.trim(), region: form.region.trim() };
  const branch = form.branch.trim();
  return {
    resources,
    target: {
      kind: "new",
      name: form.name.trim(),
      repo: form.repo.trim(),
      ...(branch ? { ref: branch } : {}),
      gitConnectionId: form.gitConnectionId,
      path: form.path.trim().replace(/^\/+|\/+$/g, ""),
      backend,
    },
  };
}

// -- errors ----------------------------------------------------------------------------

/** A failed adopt or list request, for the page: a sentence, and the
 *  resources it is about when the API named them. */
export interface AdoptProblem {
  message: string;
  resources: { label: string; detail: string | null }[];
}

type KeyList = { type?: unknown; providerId?: unknown; project?: unknown; reason?: unknown }[];

const RATE_LIMITED =
  "infralift has read your cloud accounts too many times in the last few minutes. Try again in a few minutes.";

/** "web-1 (aws:ec2:instance)" when the resource is in the loaded list, the
 *  provider's id otherwise. */
function labelFor(item: { type?: unknown; providerId?: unknown }, loaded: UnmanagedResource[]): string {
  const type = String(item.type ?? "");
  const id = String(item.providerId ?? "");
  const known = loaded.find((r) => r.type === type && r.providerId === id);
  return known ? `${known.name} (${type})` : `${id} (${type})`;
}

function listOf(body: unknown, field: "managed" | "missing" | "refused"): KeyList {
  const value = body && typeof body === "object" ? (body as Record<string, unknown>)[field] : undefined;
  return Array.isArray(value) ? (value.filter((v) => v && typeof v === "object") as KeyList) : [];
}

/**
 * What to tell someone whose adopt request failed.
 *
 *   409 with `managed`  another project manages or has reserved these; named.
 *   409 otherwise       the API's own sentence (a project name already taken).
 *   400 with `missing`  gone from the account since the list was read.
 *   400 with `refused`  cannot be adopted yet, with each reason.
 *   429                 too many account reads; wait a few minutes.
 *   anything else       errorMessageFor in lib/api.ts, which never shows a
 *                       5xx body or a raw status.
 */
export function adoptProblemFor(status: number | null, body: unknown, loaded: UnmanagedResource[] = []): AdoptProblem {
  if (status === null) {
    return { message: "We couldn't reach infralift. Check your connection and try again.", resources: [] };
  }
  if (status === 429) return { message: RATE_LIMITED, resources: [] };

  const managed = status === 409 ? listOf(body, "managed") : [];
  if (managed.length) {
    return {
      message:
        managed.length === 1
          ? "One resource you picked is already managed by another project. Unpick it, or refresh the list, and try again."
          : `${managed.length} resources you picked are already managed by another project. Unpick them, or refresh the list, and try again.`,
      resources: managed.map((m) => ({
        label: labelFor(m, loaded),
        detail: typeof m.project === "string" && m.project ? `managed by ${m.project}` : null,
      })),
    };
  }

  const missing = status === 400 ? listOf(body, "missing") : [];
  if (missing.length) {
    return {
      message: "Some resources you picked are no longer in the account. Refresh the list and pick again.",
      resources: missing.map((m) => ({ label: labelFor(m, loaded), detail: null })),
    };
  }

  const refused = status === 400 ? listOf(body, "refused") : [];
  if (refused.length) {
    return {
      message: "Some resources you picked cannot be adopted yet. Unpick them and try again.",
      resources: refused.map((m) => ({
        label: labelFor(m, loaded),
        detail: typeof m.reason === "string" ? m.reason : null,
      })),
    };
  }

  return { message: errorMessageFor(status, body), resources: [] };
}

// -- requests ------------------------------------------------------------------------

/** GET /connections/:id/unmanaged's URL for one page. */
export function unmanagedPath(connectionId: string, opts: { cursor?: string | null; refresh?: boolean } = {}): string {
  const q = new URLSearchParams();
  if (opts.cursor) q.set("cursor", opts.cursor);
  if (opts.refresh) q.set("refresh", "1");
  const query = q.toString();
  return `/connections/${encodeURIComponent(connectionId)}/unmanaged${query ? `?${query}` : ""}`;
}

/** Thrown by the two helpers below. Carries the page-ready problem. */
export class AdoptRequestError extends Error {
  constructor(
    readonly problem: AdoptProblem,
    readonly status: number | null
  ) {
    super(problem.message);
  }
}

async function send(path: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(`${API_URL}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...init?.headers },
      credentials: "include",
      cache: "no-store",
    });
  } catch {
    throw new AdoptRequestError(adoptProblemFor(null, null), null);
  }
}

async function bodyOf(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/** One page of the unmanaged list, and the cursor of the next (null on the
 *  last page). */
export async function fetchUnmanagedPage(
  connectionId: string,
  opts: { cursor?: string | null; refresh?: boolean } = {}
): Promise<{ page: UnmanagedPage; nextCursor: string | null }> {
  const res = await send(unmanagedPath(connectionId, opts));
  if (!res.ok) throw new AdoptRequestError(adoptProblemFor(res.status, await bodyOf(res)), res.status);
  return { page: (await res.json()) as UnmanagedPage, nextCursor: res.headers.get("X-Next-Cursor") || null };
}

/** POST /connections/:id/adopt. A 202 and a 200 replay are both success: the
 *  replay is the same request sent twice (a double click, a retry), and its
 *  answer names the project the first one made. */
export async function postAdopt(
  connectionId: string,
  request: AdoptSelectedRequest,
  loaded: UnmanagedResource[]
): Promise<AdoptSelectedResult> {
  const res = await send(`/connections/${encodeURIComponent(connectionId)}/adopt`, {
    method: "POST",
    body: JSON.stringify(request),
  });
  if (!res.ok) throw new AdoptRequestError(adoptProblemFor(res.status, await bodyOf(res), loaded), res.status);
  return (await res.json()) as AdoptSelectedResult;
}

/** "Read from the account at 14:02." for the line beside Refresh. */
export function fetchedAtText(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `Read from the account at ${d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}.`;
}
