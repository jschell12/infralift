// ---------------------------------------------------------------------------
// A small, stateful GitHub: only the REST operations infralift's adopt path
// calls, plus the ones the e2e harness needs to play the customer and their
// CI (create a repository, post a check run, merge or close a pull request).
//
// Why a fake and not Prism or Gitea: Prism serves canned examples, so a
// branch created by one call does not exist for the next, and the adopt flow
// could never read back the check result on the commit it pushed. Gitea and
// Forgejo keep state but serve /api/v1 with their own shapes, not GitHub's.
//
// Why it cannot drift silently from GitHub: every request body is validated
// against the operation's schema in github.openapi.json (GitHub's own
// description at a pinned commit, see ../specs/extract.ts) and refused with
// 422 if GitHub would refuse it; every response is filled out to and checked
// against the documented response schema. Any mismatch either way is
// recorded in `violations`, which the e2e suite asserts is empty.
//
// The fake sets the fields infralift reads; fillRequired() supplies every
// other required field from the schema, so responses have GitHub's shape
// without this file spelling out a hundred fields of a repository.
// ---------------------------------------------------------------------------

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  fillRequired,
  requestSchema,
  responseSchema,
  SpecValidator,
  type OpenApiDocument,
  type OperationRef,
} from "../specs/openapi.js";
import { GitObjectStore, type FileMode, type FlatFile } from "./git-objects.js";

const here = dirname(fileURLToPath(import.meta.url));
export const FAKE_LOGIN = "e2e-user";
const NOW = () => new Date().toISOString();

interface Pull {
  number: number;
  title: string;
  body: string;
  head: string;
  base: string;
  state: "open" | "closed";
  mergedAt: string | null;
  mergeSha: string | null;
  createdAt: string;
}
interface CheckRun {
  id: number;
  name: string;
  headSha: string;
  status: string;
  conclusion: string | null;
  title: string | null;
  summary: string | null;
  annotations: { path: string; start_line: number; end_line: number; annotation_level: string; message: string }[];
  startedAt: string;
  completedAt: string | null;
}
interface Repo {
  id: number;
  owner: string;
  name: string;
  private: boolean;
  defaultBranch: string;
  refs: Map<string, string>;
  pulls: Pull[];
  checkRuns: CheckRun[];
}

export interface Violation {
  operation: string;
  direction: "request" | "response" | "unimplemented";
  detail: string;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly extra: Record<string, unknown> = {}) {
    super(message);
  }
}

interface Ctx {
  op: OperationRef;
  params: Record<string, string>;
  query: URLSearchParams;
  body: any;
  accept: string;
}
type Handler = (ctx: Ctx) => { status: number; body?: unknown; raw?: string };

export class GithubFake {
  readonly git = new GitObjectStore();
  readonly repos = new Map<string, Repo>();
  readonly violations: Violation[] = [];
  private nextId = 1000;
  private readonly validator: SpecValidator;
  private readonly routes: { op: OperationRef; pattern: RegExp; names: string[]; handler: Handler; greedy: boolean }[] = [];

  constructor(readonly doc: OpenApiDocument, readonly baseUrl: string) {
    this.validator = new SpecValidator(doc);
    this.register();
  }

  // -- repositories and refs ---------------------------------------------------

  private repo(params: Record<string, string>): Repo {
    const repo = this.repos.get(`${params.owner}/${params.repo}`.toLowerCase());
    if (!repo) throw new HttpError(404, "Not Found");
    return repo;
  }

  createRepo(owner: string, name: string, opts: { private?: boolean; autoInit?: boolean } = {}): Repo {
    const key = `${owner}/${name}`.toLowerCase();
    if (this.repos.has(key)) throw new HttpError(422, "Repository creation failed.", { errors: [{ resource: "Repository", code: "custom", field: "name", message: "name already exists on this account" }] });
    const repo: Repo = { id: this.nextId++, owner, name, private: opts.private ?? true, defaultBranch: "main", refs: new Map(), pulls: [], checkRuns: [] };
    if (opts.autoInit !== false) {
      const tree = this.git.buildTree([{ path: "README.md", mode: "100644", sha: this.git.putBlob(Buffer.from(`# ${name}\n`)) }]);
      repo.refs.set("heads/main", this.commit(tree, [], "Initial commit"));
    }
    this.repos.set(key, repo);
    return repo;
  }

  private commit(tree: string, parents: string[], message: string): string {
    return this.git.putCommit({ tree, parents, message, author: { name: FAKE_LOGIN, email: `${FAKE_LOGIN}@users.noreply.github.com`, date: NOW() } });
  }

  /** A branch, tag or commit sha to a commit sha, or null. */
  resolve(repo: Repo, ref: string): string | null {
    for (const r of [ref, `heads/${ref}`, `tags/${ref}`, ref.replace(/^refs\//, "")]) {
      const sha = repo.refs.get(r);
      if (sha) return sha;
    }
    return this.git.commit(ref) ? ref : null;
  }

  /** The files on `ref`, for a test or the harness to read a branch. */
  files(owner: string, name: string, ref: string): Map<string, string> {
    const repo = this.repo({ owner, repo: name });
    const sha = this.resolve(repo, ref);
    if (!sha) throw new HttpError(404, `no ref ${ref}`);
    const out = new Map<string, string>();
    for (const f of this.git.flatten(this.git.commit(sha)!.tree)) out.set(f.path, this.git.blob(f.sha)!.toString("utf8"));
    return out;
  }

  // -- response shapes ----------------------------------------------------------

  private url(path: string): string {
    return `${this.baseUrl}${path}`;
  }

  private user() {
    return { login: FAKE_LOGIN, id: 1, node_id: "U_fake", type: "User", site_admin: false, html_url: `https://github.example.invalid/${FAKE_LOGIN}` };
  }

  private repoJson(repo: Repo) {
    const full = `${repo.owner}/${repo.name}`;
    return {
      id: repo.id,
      node_id: `R_${repo.id}`,
      name: repo.name,
      full_name: full,
      owner: { ...this.user(), login: repo.owner },
      private: repo.private,
      visibility: repo.private ? "private" : "public",
      default_branch: repo.defaultBranch,
      html_url: `https://github.example.invalid/${full}`,
      url: this.url(`/repos/${full}`),
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      pushed_at: "2026-01-01T00:00:00Z",
    };
  }

  private refJson(repo: Repo, ref: string, sha: string) {
    return { ref: `refs/${ref}`, node_id: `REF_${sha.slice(0, 8)}`, url: this.url(`/repos/${repo.owner}/${repo.name}/git/refs/${ref}`), object: { type: "commit", sha, url: this.url(`/repos/${repo.owner}/${repo.name}/git/commits/${sha}`) } };
  }

  private gitCommitJson(repo: Repo, sha: string) {
    const c = this.git.commit(sha)!;
    const who = { ...c.author };
    const base = `/repos/${repo.owner}/${repo.name}`;
    return {
      sha,
      node_id: `C_${sha.slice(0, 8)}`,
      url: this.url(`${base}/git/commits/${sha}`),
      html_url: `https://github.example.invalid/${repo.owner}/${repo.name}/commit/${sha}`,
      author: who,
      committer: who,
      message: c.message,
      tree: { sha: c.tree, url: this.url(`${base}/git/trees/${c.tree}`) },
      parents: c.parents.map((p) => ({ sha: p, url: this.url(`${base}/git/commits/${p}`), html_url: `https://github.example.invalid/${repo.owner}/${repo.name}/commit/${p}` })),
      verification: { verified: false, reason: "unsigned", signature: null, payload: null, verified_at: null },
    };
  }

  /** GET /repos/{o}/{r}/commits/{ref}: the commit plus the files it changed
   *  against its first parent, which readImportCheck reads. */
  private commitJson(repo: Repo, sha: string) {
    const c = this.git.commit(sha)!;
    const parent = c.parents[0] ? this.git.commit(c.parents[0]) : null;
    const before = new Map((parent ? this.git.flatten(parent.tree) : []).map((f) => [f.path, f.sha]));
    const after = new Map(this.git.flatten(c.tree).map((f) => [f.path, f.sha]));
    const files: { filename: string; status: string; sha: string }[] = [];
    for (const [path, blob] of after) {
      if (!before.has(path)) files.push({ filename: path, status: "added", sha: blob });
      else if (before.get(path) !== blob) files.push({ filename: path, status: "modified", sha: blob });
    }
    for (const [path, blob] of before) if (!after.has(path)) files.push({ filename: path, status: "removed", sha: blob });
    const git = this.gitCommitJson(repo, sha);
    return {
      sha,
      node_id: git.node_id,
      url: this.url(`/repos/${repo.owner}/${repo.name}/commits/${sha}`),
      html_url: git.html_url,
      comments_url: this.url(`/repos/${repo.owner}/${repo.name}/commits/${sha}/comments`),
      commit: { ...git, comment_count: 0 },
      author: this.user(),
      committer: this.user(),
      parents: git.parents,
      files: files.map((f) => ({ ...f, additions: 0, deletions: 0, changes: 0 })),
    };
  }

  private pullJson(repo: Repo, pr: Pull) {
    const full = `${repo.owner}/${repo.name}`;
    const headSha = this.resolve(repo, pr.head) ?? pr.mergeSha ?? "";
    const side = (ref: string, sha: string) => ({ label: `${repo.owner}:${ref}`, ref, sha, user: this.user(), repo: this.repoJson(repo) });
    return {
      id: repo.id * 1000 + pr.number,
      number: pr.number,
      state: pr.state,
      title: pr.title,
      body: pr.body,
      html_url: `https://github.example.invalid/${full}/pull/${pr.number}`,
      url: this.url(`/repos/${full}/pulls/${pr.number}`),
      user: this.user(),
      created_at: pr.createdAt,
      updated_at: pr.createdAt,
      closed_at: pr.state === "closed" ? pr.mergedAt ?? NOW() : null,
      merged_at: pr.mergedAt,
      merged: pr.mergedAt !== null,
      merge_commit_sha: pr.mergeSha,
      head: side(pr.head, headSha),
      base: side(pr.base, this.resolve(repo, pr.base) ?? ""),
    };
  }

  private checkRunJson(repo: Repo, run: CheckRun) {
    const full = `${repo.owner}/${repo.name}`;
    return {
      id: run.id,
      node_id: `CR_${run.id}`,
      name: run.name,
      head_sha: run.headSha,
      status: run.status,
      conclusion: run.conclusion,
      started_at: run.startedAt,
      completed_at: run.completedAt,
      url: this.url(`/repos/${full}/check-runs/${run.id}`),
      html_url: `https://github.example.invalid/${full}/runs/${run.id}`,
      details_url: null,
      external_id: null,
      output: {
        title: run.title,
        summary: run.summary,
        text: null,
        annotations_count: run.annotations.length,
        annotations_url: this.url(`/repos/${full}/check-runs/${run.id}/annotations`),
      },
      check_suite: { id: run.id },
      app: null,
      pull_requests: [],
    };
  }

  // -- operations -----------------------------------------------------------------

  private on(method: OperationRef["method"], path: string, handler: Handler): void {
    const names: string[] = [];
    // A trailing {path} or {ref} may hold slashes (a file path, heads/a/b).
    const greedy = /\{(path|ref)\}$/.test(path) ? path.match(/\{(path|ref)\}$/)![1] : null;
    const source = path.replace(/\{(\w+)\}/g, (_, name) => {
      names.push(name);
      return name === greedy ? "(.+)" : "([^/]+)";
    });
    this.routes.push({ op: { method, path }, pattern: new RegExp(`^${source}$`), names, handler, greedy: greedy !== null });
    // A greedy route (commits/{ref}) would swallow commits/{ref}/check-runs,
    // so routes without one are always tried first.
    this.routes.sort((a, b) => Number(a.greedy) - Number(b.greedy));
  }

  private register(): void {
    this.on("get", "/user", () => ({ status: 200, body: this.user() }));

    this.on("post", "/user/repos", ({ body }) => ({ status: 201, body: this.repoJson(this.createRepo(FAKE_LOGIN, body.name, { private: body.private, autoInit: body.auto_init })) }));
    // Only one user exists and it belongs to no organization. GitHub
    // documents 403 here (not 404), which ensureRepo also falls back on.
    this.on("post", "/orgs/{org}/repos", () => {
      throw new HttpError(403, "You need admin access to the organization before adding a repository to it.");
    });
    this.on("get", "/repos/{owner}/{repo}", ({ params }) => ({ status: 200, body: this.repoJson(this.repo(params)) }));

    this.on("get", "/repos/{owner}/{repo}/contents/{path}", ({ params, query, accept }) => {
      const repo = this.repo(params);
      const sha = this.resolve(repo, query.get("ref") ?? repo.defaultBranch);
      const entry = sha ? this.git.lookup(this.git.commit(sha)!.tree, params.path) : null;
      if (!entry || entry.type !== "blob") throw new HttpError(404, "Not Found");
      const content = this.git.blob(entry.sha)!;
      if (accept.includes("raw")) return { status: 200, raw: content.toString("utf8") };
      const full = `${repo.owner}/${repo.name}`;
      return {
        status: 200,
        body: {
          type: "file",
          encoding: "base64",
          size: content.length,
          name: params.path.split("/").pop(),
          path: params.path,
          content: content.toString("base64"),
          sha: entry.sha,
          url: this.url(`/repos/${full}/contents/${params.path}`),
          git_url: this.url(`/repos/${full}/git/blobs/${entry.sha}`),
          html_url: null,
          download_url: null,
          _links: { self: this.url(`/repos/${full}/contents/${params.path}`), git: null, html: null },
        },
      };
    });

    this.on("get", "/repos/{owner}/{repo}/git/ref/{ref}", ({ params }) => {
      const repo = this.repo(params);
      const sha = repo.refs.get(params.ref);
      if (!sha) throw new HttpError(404, "Not Found");
      return { status: 200, body: this.refJson(repo, params.ref, sha) };
    });
    this.on("post", "/repos/{owner}/{repo}/git/refs", ({ params, body }) => {
      const repo = this.repo(params);
      const ref = String(body.ref).replace(/^refs\//, "");
      if (repo.refs.has(ref)) throw new HttpError(422, "Reference already exists");
      if (!this.git.commit(body.sha)) throw new HttpError(422, "Object does not exist");
      repo.refs.set(ref, body.sha);
      return { status: 201, body: this.refJson(repo, ref, body.sha) };
    });
    this.on("patch", "/repos/{owner}/{repo}/git/refs/{ref}", ({ params, body }) => {
      const repo = this.repo(params);
      const current = repo.refs.get(params.ref);
      if (!current) throw new HttpError(422, "Reference does not exist");
      if (!this.git.commit(body.sha)) throw new HttpError(422, "Object does not exist");
      // Without force, only a fast-forward: the new commit must descend from the old.
      if (!body.force && !this.descends(body.sha, current)) throw new HttpError(422, "Update is not a fast forward");
      repo.refs.set(params.ref, body.sha);
      return { status: 200, body: this.refJson(repo, params.ref, body.sha) };
    });
    this.on("delete", "/repos/{owner}/{repo}/git/refs/{ref}", ({ params }) => {
      const repo = this.repo(params);
      if (!repo.refs.delete(params.ref)) throw new HttpError(422, "Reference does not exist");
      return { status: 204 };
    });

    this.on("post", "/repos/{owner}/{repo}/git/blobs", ({ params, body }) => {
      const repo = this.repo(params);
      const sha = this.git.putBlob(Buffer.from(body.content, body.encoding === "base64" ? "base64" : "utf8"));
      return { status: 201, body: { sha, url: this.url(`/repos/${repo.owner}/${repo.name}/git/blobs/${sha}`) } };
    });
    this.on("post", "/repos/{owner}/{repo}/git/trees", ({ params, body }) => {
      const repo = this.repo(params);
      const files = new Map<string, FlatFile>();
      if (body.base_tree) {
        if (!this.git.tree(body.base_tree)) throw new HttpError(422, "base_tree is not a valid tree");
        for (const f of this.git.flatten(body.base_tree)) files.set(f.path, f);
      }
      for (const e of body.tree as { path: string; mode: FileMode; sha?: string | null; content?: string }[]) {
        if (e.sha === null) files.delete(e.path);
        else files.set(e.path, { path: e.path, mode: e.mode, sha: e.sha ?? this.git.putBlob(Buffer.from(e.content ?? "")) });
      }
      const sha = this.git.buildTree([...files.values()]);
      return { status: 201, body: this.treeJson(repo, sha, false) };
    });
    this.on("get", "/repos/{owner}/{repo}/git/trees/{tree_sha}", ({ params, query }) => {
      const repo = this.repo(params);
      let sha = params.tree_sha;
      if (!this.git.tree(sha)) {
        const commit = this.resolve(repo, sha);
        if (!commit) throw new HttpError(404, "Not Found");
        sha = this.git.commit(commit)!.tree;
      }
      return { status: 200, body: this.treeJson(repo, sha, query.has("recursive")) };
    });
    this.on("post", "/repos/{owner}/{repo}/git/commits", ({ params, body }) => {
      const repo = this.repo(params);
      if (!this.git.tree(body.tree)) throw new HttpError(422, "Tree SHA does not exist");
      for (const p of body.parents ?? []) if (!this.git.commit(p)) throw new HttpError(422, "Parent SHA does not exist");
      const sha = this.commit(body.tree, body.parents ?? [], body.message);
      return { status: 201, body: this.gitCommitJson(repo, sha) };
    });
    this.on("get", "/repos/{owner}/{repo}/git/commits/{commit_sha}", ({ params }) => {
      const repo = this.repo(params);
      if (!this.git.commit(params.commit_sha)) throw new HttpError(404, "Not Found");
      return { status: 200, body: this.gitCommitJson(repo, params.commit_sha) };
    });

    this.on("get", "/repos/{owner}/{repo}/commits", ({ params, query }) => {
      const repo = this.repo(params);
      const limit = Number(query.get("per_page") ?? 30);
      let sha = this.resolve(repo, query.get("sha") ?? repo.defaultBranch);
      const out: unknown[] = [];
      while (sha && out.length < limit) {
        out.push(this.commitJson(repo, sha));
        sha = this.git.commit(sha)!.parents[0] ?? null;
      }
      return { status: 200, body: out };
    });
    this.on("get", "/repos/{owner}/{repo}/commits/{ref}", ({ params }) => {
      const repo = this.repo(params);
      const sha = this.resolve(repo, params.ref);
      if (!sha) throw new HttpError(422, `No commit found for SHA: ${params.ref}`);
      return { status: 200, body: this.commitJson(repo, sha) };
    });

    this.on("get", "/repos/{owner}/{repo}/commits/{ref}/check-runs", ({ params, query }) => {
      const repo = this.repo(params);
      const sha = this.resolve(repo, params.ref);
      let runs = repo.checkRuns.filter((r) => r.headSha === sha);
      const name = query.get("check_name");
      if (name) runs = runs.filter((r) => r.name === name);
      // filter=latest (GitHub's default): the newest run of each name.
      if (query.get("filter") !== "all") runs = runs.filter((r) => !runs.some((o) => o.name === r.name && o.id > r.id));
      return { status: 200, body: { total_count: runs.length, check_runs: runs.map((r) => this.checkRunJson(repo, r)) } };
    });
    this.on("post", "/repos/{owner}/{repo}/check-runs", ({ params, body }) => {
      const repo = this.repo(params);
      if (!this.git.commit(body.head_sha)) throw new HttpError(422, "No commit found for SHA");
      const run: CheckRun = {
        id: this.nextId++,
        name: body.name,
        headSha: body.head_sha,
        status: body.conclusion ? "completed" : body.status ?? "queued",
        conclusion: body.conclusion ?? null,
        title: body.output?.title ?? null,
        summary: body.output?.summary ?? null,
        annotations: body.output?.annotations ?? [],
        startedAt: body.started_at ?? NOW(),
        completedAt: body.conclusion ? body.completed_at ?? NOW() : null,
      };
      repo.checkRuns.push(run);
      return { status: 201, body: this.checkRunJson(repo, run) };
    });
    this.on("get", "/repos/{owner}/{repo}/check-runs/{check_run_id}/annotations", ({ params }) => {
      const repo = this.repo(params);
      const run = repo.checkRuns.find((r) => String(r.id) === params.check_run_id);
      if (!run) throw new HttpError(404, "Not Found");
      return { status: 200, body: run.annotations.map((a) => ({ ...a, start_column: null, end_column: null, title: null, raw_details: null, blob_href: "" })) };
    });

    this.on("get", "/repos/{owner}/{repo}/pulls", ({ params, query }) => {
      const repo = this.repo(params);
      const state = query.get("state") ?? "open";
      const base = query.get("base");
      const pulls = repo.pulls.filter((p) => (state === "all" || p.state === state) && (!base || p.base === base));
      return { status: 200, body: pulls.map((p) => this.pullJson(repo, p)) };
    });
    this.on("post", "/repos/{owner}/{repo}/pulls", ({ params, body }) => {
      const repo = this.repo(params);
      if (!repo.refs.has(`heads/${body.head}`) || !repo.refs.has(`heads/${body.base}`)) throw new HttpError(422, "Validation Failed", { errors: [{ resource: "PullRequest", code: "invalid", field: "head" }] });
      if (repo.pulls.some((p) => p.state === "open" && p.head === body.head && p.base === body.base)) throw new HttpError(422, "A pull request already exists");
      const pr: Pull = { number: repo.pulls.length + 1, title: body.title, body: body.body ?? "", head: body.head, base: body.base, state: "open", mergedAt: null, mergeSha: null, createdAt: NOW() };
      repo.pulls.push(pr);
      return { status: 201, body: this.pullJson(repo, pr) };
    });
    this.on("get", "/repos/{owner}/{repo}/pulls/{pull_number}", ({ params }) => {
      const repo = this.repo(params);
      return { status: 200, body: this.pullJson(repo, this.pull(repo, params.pull_number)) };
    });
    this.on("patch", "/repos/{owner}/{repo}/pulls/{pull_number}", ({ params, body }) => {
      const repo = this.repo(params);
      const pr = this.pull(repo, params.pull_number);
      if (body.state === "closed" || body.state === "open") pr.state = body.state;
      if (typeof body.title === "string") pr.title = body.title;
      return { status: 200, body: this.pullJson(repo, pr) };
    });
    // A merge commit of head onto base: base's tree replaced by head's, which
    // is right for the branches infralift opens (cut from base, never rebased).
    this.on("put", "/repos/{owner}/{repo}/pulls/{pull_number}/merge", ({ params }) => {
      const repo = this.repo(params);
      const pr = this.pull(repo, params.pull_number);
      if (pr.state !== "open") throw new HttpError(405, "Pull Request is not mergeable");
      const head = this.resolve(repo, pr.head)!;
      const base = this.resolve(repo, pr.base)!;
      const sha = this.commit(this.git.commit(head)!.tree, [base, head], `Merge pull request #${pr.number} from ${repo.owner}/${pr.head}`);
      repo.refs.set(`heads/${pr.base}`, sha);
      Object.assign(pr, { state: "closed", mergedAt: NOW(), mergeSha: sha });
      return { status: 200, body: { sha, merged: true, message: "Pull Request successfully merged" } };
    });
  }

  private pull(repo: Repo, number: string): Pull {
    const pr = repo.pulls.find((p) => String(p.number) === number);
    if (!pr) throw new HttpError(404, "Not Found");
    return pr;
  }

  private descends(sha: string, ancestor: string): boolean {
    const seen = new Set<string>();
    const queue = [sha];
    while (queue.length) {
      const s = queue.shift()!;
      if (s === ancestor) return true;
      if (seen.has(s)) continue;
      seen.add(s);
      queue.push(...(this.git.commit(s)?.parents ?? []));
    }
    return false;
  }

  private treeJson(repo: Repo, sha: string, recursive: boolean) {
    const base = `/repos/${repo.owner}/${repo.name}`;
    const entries = recursive ? this.git.walk(sha) : (this.git.tree(sha) ?? []).map((entry) => ({ path: entry.name, entry }));
    return {
      sha,
      url: this.url(`${base}/git/trees/${sha}`),
      truncated: false,
      tree: entries.map(({ path, entry }) => ({
        path,
        mode: entry.mode,
        type: entry.type,
        sha: entry.sha,
        ...(entry.type === "blob" ? { size: this.git.blob(entry.sha)!.length } : {}),
        url: this.url(`${base}/git/${entry.type === "tree" ? "trees" : "blobs"}/${entry.sha}`),
      })),
    };
  }

  // -- HTTP ---------------------------------------------------------------------------

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://fake");
    const method = (req.method ?? "GET").toLowerCase() as OperationRef["method"];
    const raw = await new Promise<string>((resolve) => {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => resolve(data));
    });
    const send = (status: number, body?: unknown, text?: string) => {
      res.statusCode = status;
      if (text !== undefined) {
        res.setHeader("content-type", "text/plain; charset=utf-8");
        res.end(text);
      } else if (body === undefined) res.end();
      else {
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.end(JSON.stringify(body));
      }
    };

    if (url.pathname === "/_fake/violations") return send(200, this.violations);
    if (!req.headers.authorization?.startsWith("Bearer ")) return send(401, { message: "Requires authentication", documentation_url: "https://docs.github.com/rest" });

    let route: (typeof this.routes)[number] | undefined;
    let match: RegExpMatchArray | null = null;
    for (const r of this.routes) {
      if (r.op.method !== method) continue;
      match = url.pathname.match(r.pattern);
      if (match) {
        route = r;
        break;
      }
    }
    if (!route || !match) {
      this.violations.push({ operation: `${method.toUpperCase()} ${url.pathname}`, direction: "unimplemented", detail: "the fake does not implement this call" });
      return send(501, { message: `the GitHub fake does not implement ${method.toUpperCase()} ${url.pathname}` });
    }
    const name = `${method.toUpperCase()} ${route.op.path}`;
    const params: Record<string, string> = {};
    route.names.forEach((n, i) => (params[n] = match![i + 1].split("/").map(decodeURIComponent).join("/")));
    const body = raw ? JSON.parse(raw) : {};

    const reqSchema = requestSchema(this.doc, route.op);
    if (reqSchema && raw) {
      const error = this.validator.check(reqSchema, body);
      if (error) {
        this.violations.push({ operation: name, direction: "request", detail: error });
        return send(422, { message: "Invalid request.", errors: [error], documentation_url: "https://docs.github.com/rest", status: "422" });
      }
    }

    let out: { status: number; body?: unknown; raw?: string };
    try {
      out = route.handler({ op: route.op, params, query: url.searchParams, body, accept: String(req.headers.accept ?? "") });
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      out = { status: err.status, body: { message: err.message, documentation_url: "https://docs.github.com/rest", ...err.extra } };
    }
    if (out.raw !== undefined) return send(out.status, undefined, out.raw);

    let schema = null;
    try {
      schema = responseSchema(this.doc, route.op, out.status);
    } catch (err) {
      this.violations.push({ operation: name, direction: "response", detail: (err as Error).message });
    }
    let payload = out.body;
    if (schema && payload !== undefined) {
      payload = fillRequired(this.doc, schema, payload);
      const error = this.validator.check(schema, payload);
      if (error) this.violations.push({ operation: name, direction: "response", detail: `${out.status}: ${error}` });
    }
    send(out.status, payload);
  }
}

export interface RunningFake {
  fake: GithubFake;
  url: string;
  server: Server;
  close(): Promise<void>;
}

export function loadGithubDescription(): OpenApiDocument {
  return JSON.parse(readFileSync(join(here, "../specs/github.openapi.json"), "utf8"));
}

/** Starts the fake on `port` (0: any free port). */
export async function startGithubFake(port = 0, host = "127.0.0.1"): Promise<RunningFake> {
  let fake!: GithubFake;
  const server = createServer((req, res) => {
    fake.handle(req, res).catch((err) => {
      console.error("github fake:", err);
      res.statusCode = 500;
      res.end(JSON.stringify({ message: String(err) }));
    });
  });
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const address = server.address();
  const url = `http://${host}:${typeof address === "object" && address ? address.port : port}`;
  fake = new GithubFake(loadGithubDescription(), url);
  return { fake, url, server, close: () => new Promise((resolve) => server.close(() => resolve())) };
}
