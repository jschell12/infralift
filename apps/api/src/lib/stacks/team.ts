import { createHash } from "node:crypto";
import { Ajv2020 as Ajv } from "ajv/dist/2020.js";
import type { GitHostClient, TreeEntry } from "../git/hosts.js";
import { TfInputValidationError } from "../tf/render.js";
import { memoryTree, renderStack, type StackFile, type StackManifest } from "./index.js";
import { STACK_MANIFEST_SCHEMA } from "./manifest-schema.js";

// ---------------------------------------------------------------------------
// Team stacks: a stack a team keeps in its own repository, laid out like a
// catalog stack (stack.json, files/, deliveries/<d>/files/, templates/) under
// `path`, and pinned to the commit its ref resolved to (ADR 0009).
//
// infralift never runs a team's Terraform. Everything here is reading and
// checking: resolve the ref, list the tree, refuse what is unsafe or too big,
// read the files at the pinned SHA, validate the manifest, and render the
// manifest's example with the logic-less {{var}} renderer to prove it renders.
// `tofu validate` belongs in the team's own CI, never on our servers.
//
// What fails here is a fact about the stack and is returned as errors, so the
// version is recorded with them. What fails reaching the host is thrown.
// ---------------------------------------------------------------------------

export const TEAM_STACK_LIMITS = {
  maxFiles: 300,
  maxFileBytes: 256 * 1024,
  maxTotalBytes: 2 * 1024 * 1024,
  maxPathLength: 512,
};

/** The parts of the tree under `path` that make up a stack. Anything else
 *  there (a README, the repository's own CI) is not read. */
const DECLARED = [/^stack\.json$/, /^files\//, /^deliveries\/[a-z0-9-]+\/files\//, /^templates\//];

export interface IndexedFile {
  path: string;
  mode: StackFile["mode"];
  bytes: number;
  sha256: string;
}

export type TeamStackLoad =
  | {
      valid: true;
      sha: string;
      manifest: StackManifest;
      files: IndexedFile[];
      contents: Record<string, string>;
      renderedFiles: number;
    }
  | { valid: false; sha: string; manifest: StackManifest | null; files: IndexedFile[]; errors: string[] };

export class StackFetchError extends Error {}

/** A relative path that stays inside the tree: no leading slash, no "." or
 *  ".." segment, no backslash, nothing a shell or a filesystem reads twice. */
export function isStackPath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= TEAM_STACK_LIMITS.maxPathLength &&
    /^[A-Za-z0-9._@+-]+(\/[A-Za-z0-9._@+-]+)*$/.test(path) &&
    !path.split("/").some((seg) => seg === "." || seg === "..")
  );
}

/** The repository directory a stack lives in: "" for the root, else a stack path. */
export function isStackDir(dir: string): boolean {
  return dir === "" || isStackPath(dir);
}

/**
 * Which tree entries belong to the stack at `dir`, relative to it, and what is
 * wrong with them. Pure, so the limits are tested without a host.
 */
export function selectStackEntries(entries: TreeEntry[], dir: string) {
  const prefix = dir ? `${dir}/` : "";
  const errors: string[] = [];
  const files: { path: string; mode: StackFile["mode"]; size: number | null }[] = [];
  for (const e of entries) {
    if (!e.path.startsWith(prefix)) continue;
    const path = e.path.slice(prefix.length);
    if (!DECLARED.some((re) => re.test(path))) continue;
    if (!isStackPath(path)) errors.push(`${JSON.stringify(path)} is not a safe relative path`);
    else if (e.type === "commit" || e.mode === "160000") errors.push(`${path} is a submodule`);
    else if (e.mode === "120000") errors.push(`${path} is a symlink`);
    else if (e.mode !== "100644" && e.mode !== "100755") errors.push(`${path} has unsupported mode ${e.mode}`);
    else if (e.size !== null && e.size > TEAM_STACK_LIMITS.maxFileBytes) {
      errors.push(`${path} is ${e.size} bytes; the limit is ${TEAM_STACK_LIMITS.maxFileBytes}`);
    } else files.push({ path, mode: e.mode, size: e.size });
  }
  if (!files.some((f) => f.path === "stack.json")) errors.push(`no stack.json in ${dir || "the repository root"}`);
  if (files.length > TEAM_STACK_LIMITS.maxFiles) {
    errors.push(`${files.length} files; the limit is ${TEAM_STACK_LIMITS.maxFiles}`);
  }
  const known = files.reduce((n, f) => n + (f.size ?? 0), 0);
  if (known > TEAM_STACK_LIMITS.maxTotalBytes) {
    errors.push(`${known} bytes in total; the limit is ${TEAM_STACK_LIMITS.maxTotalBytes}`);
  }
  return { files, errors };
}

const ajv = new Ajv({ allErrors: true, strict: false });
const validateManifest = ajv.compile(STACK_MANIFEST_SCHEMA);

/** Schema errors, plus references the schema cannot see: every output path is
 *  safe, every rendered template is a file in templates/. */
export function checkManifest(raw: unknown, paths: Set<string>): string[] {
  if (!validateManifest(raw)) {
    return (validateManifest.errors ?? []).map((e) => `stack.json${e.instancePath} ${e.message ?? "invalid"}`);
  }
  const m = raw as unknown as StackManifest;
  const errors: string[] = [];
  const outputs = [...m.rendered.map((r) => r.path), ...(m.seed ?? []), ...(m.modules ?? []).map((x) => x.path)];
  for (const p of outputs) if (!isStackPath(p)) errors.push(`stack.json names an unsafe path ${JSON.stringify(p)}`);
  for (const r of m.rendered) {
    if (!isStackPath(r.template) || !paths.has(`templates/${r.template}`)) {
      errors.push(`stack.json renders ${JSON.stringify(r.template)}, which is not a file in templates/`);
    }
  }
  return errors;
}

/** Resolves `ref`, then reads and checks the stack at that commit. */
export async function loadTeamStack(
  client: GitHostClient,
  opts: { repo: string; dir: string; ref: string }
): Promise<TeamStackLoad> {
  const sha = await client.resolveRef({ repo: opts.repo, ref: opts.ref });
  if (!sha) throw new StackFetchError(`${opts.ref} is not a branch, tag or commit in ${opts.repo}`);
  const tree = await client.listTree({ repo: opts.repo, ref: sha });
  if (tree.truncated) throw new StackFetchError(`${opts.repo} is too large to list; point at a smaller repository`);

  const selected = selectStackEntries(tree.entries, opts.dir);
  if (selected.errors.length) return { valid: false, sha, manifest: null, files: [], errors: selected.errors };

  // Read at the SHA, never the ref: a tag moved between these calls must not
  // mix two commits into one version.
  const contents = new Map<string, { content: string; mode: StackFile["mode"] }>();
  const files: IndexedFile[] = [];
  const errors: string[] = [];
  let total = 0;
  for (const f of selected.files) {
    const full = opts.dir ? `${opts.dir}/${f.path}` : f.path;
    const content = await client.readFile({ repo: opts.repo, path: full, ref: sha });
    if (content === null) throw new StackFetchError(`${full} disappeared from ${opts.repo}@${sha.slice(0, 7)}`);
    const bytes = Buffer.byteLength(content, "utf8");
    total += bytes;
    if (bytes > TEAM_STACK_LIMITS.maxFileBytes) errors.push(`${f.path} is ${bytes} bytes; the limit is ${TEAM_STACK_LIMITS.maxFileBytes}`);
    contents.set(f.path, { content, mode: f.mode });
    files.push({ path: f.path, mode: f.mode, bytes, sha256: createHash("sha256").update(content).digest("hex") });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  if (total > TEAM_STACK_LIMITS.maxTotalBytes) errors.push(`${total} bytes in total; the limit is ${TEAM_STACK_LIMITS.maxTotalBytes}`);
  if (errors.length) return { valid: false, sha, manifest: null, files, errors };

  let raw: unknown;
  try {
    raw = JSON.parse(contents.get("stack.json")!.content);
  } catch (err) {
    return { valid: false, sha, manifest: null, files, errors: [`stack.json is not JSON: ${(err as Error).message}`] };
  }
  const manifestErrors = checkManifest(raw, new Set(contents.keys()));
  if (manifestErrors.length) return { valid: false, sha, manifest: null, files, errors: manifestErrors };
  const manifest = raw as StackManifest;

  try {
    const rendered = renderStack(manifest, manifest.example, memoryTree(contents));
    const text = Object.fromEntries([...contents].map(([p, f]) => [p, f.content]));
    return { valid: true, sha, manifest, files, contents: text, renderedFiles: rendered.length };
  } catch (err) {
    const why = err instanceof TfInputValidationError ? err.message : `does not render: ${(err as Error).message}`;
    return { valid: false, sha, manifest, files, errors: [`example ${why}`] };
  }
}
