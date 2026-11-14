import { commitFiles } from "../../src/lib/git/github.js";
import { STACK } from "./env.js";

// The customer and their CI, talking to the GitHub fake through its GitHub
// REST API (the same calls they would make to github.com).

const auth = { token: STACK.githubToken, apiBase: STACK.githubFake };

export async function gh<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${STACK.githubFake}${path}`, {
    method,
    headers: { authorization: `Bearer ${STACK.githubToken}`, accept: "application/vnd.github+json", ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (res.status === 204 ? null : await res.json()) as T;
}

/** Every file on `ref`, path to text. */
export async function branchFiles(repo: string, ref: string): Promise<Map<string, string>> {
  const tree = await gh<{ tree: { path: string; type: string }[] }>("GET", `/repos/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`);
  const out = new Map<string, string>();
  for (const e of tree.tree.filter((t) => t.type === "blob")) {
    const res = await fetch(`${STACK.githubFake}/repos/${repo}/contents/${e.path}?ref=${encodeURIComponent(ref)}`, {
      headers: { authorization: `Bearer ${STACK.githubToken}`, accept: "application/vnd.github.raw+json" },
    });
    out.set(e.path, await res.text());
  }
  return out;
}

/** One commit on `branch`, as `git push` from the CI runner or a laptop would make. */
export async function pushCommit(repo: string, branch: string, files: { path: string; content: string }[], message: string): Promise<string> {
  const result = await commitFiles({ ...auth, repo, branch, workDir: "", files: files.map((f) => ({ fileName: f.path, content: f.content })), message });
  if (!result.commitSha) throw new Error(`nothing to commit on ${branch}`);
  return result.commitSha;
}

/** A completed check run, as the import check workflow (or Actions itself,
 *  from its ::notice:: and ::error:: lines) records one. */
export async function postCheckRun(repo: string, run: { name: string; headSha: string; conclusion: "success" | "failure"; title: string; annotation?: { level: "notice" | "failure"; message: string; path: string } }) {
  return gh("POST", `/repos/${repo}/check-runs`, {
    name: run.name,
    head_sha: run.headSha,
    status: "completed",
    conclusion: run.conclusion,
    output: {
      title: run.title,
      summary: run.title,
      ...(run.annotation ? { annotations: [{ path: run.annotation.path, start_line: 1, end_line: 1, annotation_level: run.annotation.level, message: run.annotation.message }] } : {}),
    },
  });
}

export async function violations(): Promise<unknown[]> {
  return (await fetch(`${STACK.githubFake}/_fake/violations`)).json() as Promise<unknown[]>;
}
