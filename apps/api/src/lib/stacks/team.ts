import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";
import { Ajv2020 as Ajv } from "ajv/dist/2020.js";
import { GitFileTooLarge } from "../git/errors.js";
import type { GitHostClient, TreeEntry } from "../git/hosts.js";
import type { StackFile, StackManifest } from "./index.js";
import { STACK_MANIFEST_SCHEMA } from "./manifest-schema.js";
import type { RenderJob, RenderResult } from "./render-worker.js";

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
  /** The input schema as JSON, and how deeply it nests. */
  maxSchemaBytes: 64 * 1024,
  maxSchemaDepth: 32,
  /** The trial render's budget once its thread is loaded, and its heap. */
  renderTimeoutMs: 2000,
  renderHeapMb: 128,
  /** Trial renders running at once, and how many may wait for a slot. Each
   *  thread may take renderHeapMb, so this bounds the API's memory. */
  renderConcurrency: 2,
  renderQueue: 8,
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

/** The check itself could not run (queue full, thread failed): nothing was
 *  learned about the stack, so nothing is recorded and the same commit can be
 *  tried again. */
export class StackCheckUnavailable extends Error {
  constructor(
    message: string,
    readonly reason: "busy" | "failed"
  ) {
    super(message);
  }
}

type TrialResult = RenderResult | { ok: false; error: string; retry: "busy" | "failed" };

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

/**
 * The keyword checks below are defence in depth, not the guard. A schema can
 * be exponential without any regex (nested anyOf through $ref), so the trial
 * render that compiles and validates it runs in a worker thread with a hard
 * timeout and a heap limit (trialRender, render-worker.ts).
 *
 * Keywords a team's input schema may not use. Ajv runs `pattern` and
 * `patternProperties` with JavaScript's backtracking regex engine, on the one
 * event loop the API has, against values the same team wrote: `^(a+)+$` with a
 * long enough example stalls every request for hours. `format` is refused with
 * them because its validators are regexes too wherever formats are installed.
 * A linear-time engine (re2) would allow them again; it is a native addon this
 * image cannot build, so refusing is the safe default.
 */
const REGEX_KEYWORDS = ["pattern", "patternProperties", "format"];
/** Keywords whose value maps names to subschemas: the names are data. */
const SCHEMA_MAPS = new Set([
  "properties",
  "$defs",
  "definitions",
  "dependentSchemas",
  "dependentRequired",
  "dependencies",
  "patternProperties",
]);
/** The only $ref a team schema may use: a definition in the same schema. */
const REF_KEYWORDS = ["$ref", "$dynamicRef", "$recursiveRef"];
const LOCAL_REF = /^#\/\$defs\/[A-Za-z0-9_-]+$/;
/** Keywords whose value is data, never a schema. */
const DATA = new Set(["enum", "const", "default", "examples", "required"]);

export function checkInputSchema(schema: unknown): string[] {
  const bytes = Buffer.byteLength(JSON.stringify(schema ?? null), "utf8");
  if (bytes > TEAM_STACK_LIMITS.maxSchemaBytes) {
    return [`stack.json inputSchema is ${bytes} bytes; the limit is ${TEAM_STACK_LIMITS.maxSchemaBytes}`];
  }
  return walkSchema(schema, "inputSchema", 0);
}

function walkSchema(schema: unknown, at: string, depth: number): string[] {
  if (depth > TEAM_STACK_LIMITS.maxSchemaDepth) {
    return [`stack.json ${at} nests deeper than ${TEAM_STACK_LIMITS.maxSchemaDepth} levels`];
  }
  if (Array.isArray(schema)) return schema.flatMap((s, i) => walkSchema(s, `${at}/${i}`, depth + 1));
  if (!schema || typeof schema !== "object") return [];
  const errors: string[] = [];
  for (const [k, v] of Object.entries(schema)) {
    if (REGEX_KEYWORDS.includes(k)) errors.push(`stack.json ${at} uses "${k}", which team stacks may not use (regexes run on infralift's servers)`);
    if (REF_KEYWORDS.includes(k) && !(k === "$ref" && typeof v === "string" && LOCAL_REF.test(v))) {
      errors.push(`stack.json ${at} has ${k} ${JSON.stringify(v)}; team stacks may only use $ref "#/$defs/<name>"`);
    }
    if (DATA.has(k)) continue;
    if (SCHEMA_MAPS.has(k) && v && typeof v === "object") {
      for (const [name, sub] of Object.entries(v)) errors.push(...walkSchema(sub, `${at}/${k}/${name}`, depth + 1));
    } else errors.push(...walkSchema(v, `${at}/${k}`, depth + 1));
  }
  return errors;
}

/** The worker's entry: the compiled .js beside this file, or the .ts source
 *  loaded through tsx when this file is itself running as TypeScript
 *  (vitest, `pnpm dev`). */
function renderWorker(): { url: URL; execArgv: string[] } {
  const ts = import.meta.url.endsWith(".ts");
  return {
    url: new URL(ts ? "./render-worker.ts" : "./render-worker.js", import.meta.url),
    execArgv: ts ? ["--import", "tsx"] : [],
  };
}

const TOO_COMPLEX = "input schema too complex to validate";
/** A failure of ours, not the team's schema: worth retrying unchanged. */
const CHECK_FAILED = "the stack check could not run; try again";

let rendersRunning = 0;
const rendersWaiting: (() => void)[] = [];

/** Waits for a render slot, or returns false when the queue is full. */
async function acquireRenderSlot(): Promise<boolean> {
  if (rendersRunning < TEAM_STACK_LIMITS.renderConcurrency) {
    rendersRunning++;
    return true;
  }
  if (rendersWaiting.length >= TEAM_STACK_LIMITS.renderQueue) return false;
  await new Promise<void>((resolve) => rendersWaiting.push(resolve));
  return true; // the releasing render handed its slot straight to us
}

function releaseRenderSlot(): void {
  const next = rendersWaiting.shift();
  if (next) next();
  else rendersRunning--;
}

/**
 * Compiles the team's schema, validates its example and renders it, in a
 * worker thread. The budget starts once the thread has loaded; past it, or
 * past the heap limit, the thread is terminated and the stack refused.
 * `onWorker` lets a test watch the thread exit.
 */
export async function trialRender(
  manifest: StackManifest,
  contents: Map<string, { content: string; mode: StackFile["mode"] }>,
  opts: { timeoutMs?: number; onWorker?: (w: Worker) => void } = {}
): Promise<TrialResult> {
  if (!(await acquireRenderSlot())) {
    return { ok: false, error: "too many stacks are being checked right now; try again in a minute", retry: "busy" };
  }
  try {
    return await runTrialRender(manifest, contents, opts);
  } finally {
    releaseRenderSlot();
  }
}

function runTrialRender(
  manifest: StackManifest,
  contents: Map<string, { content: string; mode: StackFile["mode"] }>,
  opts: { timeoutMs?: number; onWorker?: (w: Worker) => void }
): Promise<TrialResult> {
  const timeoutMs = opts.timeoutMs ?? TEAM_STACK_LIMITS.renderTimeoutMs;
  const { url, execArgv } = renderWorker();
  const worker = new Worker(url, {
    execArgv,
    resourceLimits: { maxOldGenerationSizeMb: TEAM_STACK_LIMITS.renderHeapMb, maxYoungGenerationSizeMb: 32 },
  });
  opts.onWorker?.(worker);
  return new Promise<TrialResult>((resolve) => {
    let timer: NodeJS.Timeout | undefined;
    let settled = false;
    const finish = (result: TrialResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Resolve once the thread is gone, so a render slot is only handed on
      // when its heap is actually freed.
      void worker.terminate().finally(() => resolve(result));
    };
    // Loading the thread is ours to pay for, not the team's: a generous
    // limit for that, then the real budget once it says it is ready.
    timer = setTimeout(() => finish({ ok: false, error: CHECK_FAILED, retry: "failed" }), 30_000);
    worker.on("message", (msg: "ready" | RenderResult) => {
      if (msg === "ready") {
        clearTimeout(timer);
        timer = setTimeout(
          () => finish({ ok: false, error: `${TOO_COMPLEX}: it took over ${timeoutMs} ms` }),
          timeoutMs
        );
        const job: RenderJob = { manifest, contents: Object.fromEntries(contents) };
        worker.postMessage(job);
      } else finish(msg);
    });
    // Running out of heap is the schema's doing; any other thread failure
    // (it failed to load, it crashed) is ours, and says so.
    worker.on("error", (err) =>
      finish(
        /memory/i.test(err.message)
          ? { ok: false, error: `${TOO_COMPLEX}: it ran out of memory` }
          : { ok: false, error: CHECK_FAILED, retry: "failed" }
      )
    );
    worker.on("exit", () => finish({ ok: false, error: CHECK_FAILED, retry: "failed" }));
  });
}

/** Schema errors, plus references the schema cannot see: every output path is
 *  safe, every rendered template is a file in templates/. */
export function checkManifest(raw: unknown, paths: Set<string>): string[] {
  if (!validateManifest(raw)) {
    return (validateManifest.errors ?? []).map((e) => `stack.json${e.instancePath} ${e.message ?? "invalid"}`);
  }
  const m = raw as unknown as StackManifest;
  const errors: string[] = checkInputSchema(m.inputSchema);
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
    let content: string | null;
    try {
      content = await client.readFile({ repo: opts.repo, path: full, ref: sha, maxBytes: TEAM_STACK_LIMITS.maxFileBytes });
    } catch (err) {
      if (!(err instanceof GitFileTooLarge)) throw err;
      errors.push(`${f.path} is over ${TEAM_STACK_LIMITS.maxFileBytes} bytes`);
      continue;
    }
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

  const rendered = await trialRender(manifest, contents);
  if (!rendered.ok && "retry" in rendered) throw new StackCheckUnavailable(rendered.error, rendered.retry);
  if (!rendered.ok) return { valid: false, sha, manifest, files, errors: [rendered.error] };
  const text = Object.fromEntries([...contents].map(([p, f]) => [p, f.content]));
  return { valid: true, sha, manifest, files, contents: text, renderedFiles: rendered.renderedFiles };
}
