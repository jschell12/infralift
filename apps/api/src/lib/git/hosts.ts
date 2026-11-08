import { createHash } from "node:crypto";
import type { GitHost } from "@infralift/shared";
import {
  commitFiles as githubCommitFiles,
  createBranch as githubCreateBranch,
  deleteBranch as githubDeleteBranch,
  fileExists as githubFileExists,
  findOpenPullRequest,
  GitCommitError,
  openPullRequest,
} from "../tf/git.js";
import { GITLAB_API } from "../../connectors/gitlab.js";

// ---------------------------------------------------------------------------
// One interface over GitHub and GitLab for what a stack job does to a
// repository: create it from a template, branch, commit a tree of files, and
// open a pull request (GitHub) or merge request (GitLab).
//
// `repo` is always "<owner or group path>/<name>". On GitLab the owner may be a
// nested group ("acme/platform/web").
// ---------------------------------------------------------------------------

export interface HostFile {
  fileName: string;
  content: string;
  mode?: "100644" | "100755";
}

export interface CreatedRepo {
  repo: string;
  defaultBranch: string;
  url: string;
}

export interface ChangeRequest {
  url: string;
  branch: string;
}

export interface ChangeRequestState {
  url: string;
  headSha: string;
  state: "open" | "closed" | "merged";
}

export interface CheckRun {
  status: "queued" | "in_progress" | "completed" | string;
  /** success | failure | cancelled | timed_out | ... ; null until completed */
  conclusion: string | null;
  url: string;
  completedAt: string | null;
  annotations: { level: string; message: string }[];
}

export interface GitHostClient {
  host: GitHost;
  /** What the host calls the thing a stack job opens. */
  changeRequestNoun: "pull request" | "merge request";
  repoExists(repo: string): Promise<boolean>;
  /** The repository's default branch. */
  defaultBranch(repo: string): Promise<string>;
  /** Every file path on `ref`. `truncated` when the host cut the listing short. */
  listFiles(opts: { repo: string; ref: string }): Promise<{ paths: string[]; truncated: boolean }>;
  /** A file's text on `ref`, or null when it does not exist. */
  readFile(opts: { repo: string; path: string; ref: string }): Promise<string | null>;
  /** A pull request's current head and state, by number. */
  getChangeRequest(opts: { repo: string; number: number }): Promise<ChangeRequestState | null>;
  /** The newest check run called `name` on `sha`, with its annotations. */
  getCheckRun(opts: { repo: string; sha: string; name: string }): Promise<CheckRun | null>;
  /** New repository holding a copy of `template` (a GitHub "owner/repo"). */
  createFromTemplate(opts: { template: string; repo: string; private: boolean }): Promise<CreatedRepo>;
  fileExists(opts: { repo: string; path: string; branch: string }): Promise<boolean>;
  createBranch(opts: { repo: string; from: string; branch: string }): Promise<void>;
  deleteBranch(opts: { repo: string; branch: string }): Promise<void>;
  commitFiles(opts: {
    repo: string;
    branch: string;
    workDir: string;
    files: HostFile[];
    message: string;
  }): Promise<{ commitSha: string | null; noop: boolean }>;
  findOpenChangeRequest(opts: {
    repo: string;
    base: string;
    isMine: (branch: string) => boolean;
  }): Promise<ChangeRequest | null>;
  openChangeRequest(opts: {
    repo: string;
    head: string;
    base: string;
    title: string;
    body: string;
  }): Promise<{ url: string }>;
}

export function gitHostClient(host: GitHost, token: string): GitHostClient {
  return host === "gitlab" ? gitlabClient(token) : githubClient(token);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** How long to wait for a just-created repository to have its default
 *  branch. GitHub generates from a template asynchronously; GitLab imports. */
export const REPO_READY = { attempts: 40, intervalMs: 1500 };

// -- GitHub ------------------------------------------------------------------

function githubClient(token: string): GitHostClient {
  const gh = (method: string, path: string, body?: object) =>
    fetch(`https://api.github.com${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

  return {
    host: "github",
    changeRequestNoun: "pull request",

    async repoExists(repo) {
      const res = await gh("GET", `/repos/${repo}`);
      if (res.status === 404) return false;
      if (!res.ok) throw new GitCommitError(`GitHub repo lookup failed (${res.status}) for ${repo}`);
      return true;
    },

    async defaultBranch(repo) {
      const res = await gh("GET", `/repos/${repo}`);
      if (!res.ok) throw new GitCommitError(`GitHub repo lookup failed (${res.status}) for ${repo}`);
      return ((await res.json()) as { default_branch: string }).default_branch;
    },

    async listFiles({ repo, ref }) {
      const res = await gh("GET", `/repos/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`);
      if (!res.ok) throw new GitCommitError(`GitHub tree listing failed (${res.status}) for ${repo}@${ref}`);
      const body = (await res.json()) as { tree: { path: string; type: string }[]; truncated: boolean };
      return { paths: body.tree.filter((t) => t.type === "blob").map((t) => t.path), truncated: body.truncated };
    },

    async readFile({ repo, path, ref }) {
      const res = await fetch(
        `https://api.github.com/repos/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github.raw+json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
        }
      );
      if (res.status === 404) return null;
      if (!res.ok) throw new GitCommitError(`GitHub file read failed (${res.status}) for ${repo}/${path}`);
      return res.text();
    },

    async getChangeRequest({ repo, number }) {
      const res = await gh("GET", `/repos/${repo}/pulls/${number}`);
      if (res.status === 404) return null;
      if (!res.ok) throw new GitCommitError(`GitHub pull request lookup failed (${res.status}) for ${repo}#${number}`);
      const pr = (await res.json()) as { html_url: string; state: string; merged_at: string | null; head: { sha: string } };
      return {
        url: pr.html_url,
        headSha: pr.head.sha,
        state: pr.merged_at ? "merged" : pr.state === "open" ? "open" : "closed",
      };
    },

    async getCheckRun({ repo, sha, name }) {
      const res = await gh(
        "GET",
        `/repos/${repo}/commits/${sha}/check-runs?check_name=${encodeURIComponent(name)}&filter=latest&per_page=10`
      );
      if (!res.ok) throw new GitCommitError(`GitHub check-run lookup failed (${res.status}) for ${repo}@${sha}`);
      const body = (await res.json()) as {
        check_runs: {
          id: number;
          status: string;
          conclusion: string | null;
          html_url: string;
          started_at: string | null;
          completed_at: string | null;
          output: { annotations_count: number };
        }[];
      };
      const run = [...body.check_runs].sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)))[0];
      if (!run) return null;
      let annotations: CheckRun["annotations"] = [];
      if (run.output.annotations_count > 0) {
        const a = await gh("GET", `/repos/${repo}/check-runs/${run.id}/annotations?per_page=50`);
        if (a.ok) {
          annotations = ((await a.json()) as { annotation_level: string; message: string }[]).map((x) => ({
            level: x.annotation_level,
            message: x.message,
          }));
        }
      }
      return {
        status: run.status,
        conclusion: run.conclusion,
        url: run.html_url,
        completedAt: run.completed_at,
        annotations,
      };
    },

    async createFromTemplate({ template, repo, private: isPrivate }) {
      const [owner, name] = repo.split("/");
      const res = await gh("POST", `/repos/${template}/generate`, {
        owner,
        name,
        private: isPrivate,
        include_all_branches: false,
      });
      if (!res.ok) {
        const text = await res.text();
        throw new GitCommitError(
          `GitHub could not create ${repo} from ${template} (${res.status}): ${text.slice(0, 200)}`
        );
      }
      const created = (await res.json()) as {
        full_name: string;
        default_branch: string;
        html_url: string;
      };
      // Generation is asynchronous: the repository exists before its first
      // commit does, and branching off it fails until then.
      for (let i = 0; i < REPO_READY.attempts; i++) {
        const ref = await gh(
          "GET",
          `/repos/${created.full_name}/git/ref/heads/${encodeURIComponent(created.default_branch)}`
        );
        if (ref.ok) {
          return { repo: created.full_name, defaultBranch: created.default_branch, url: created.html_url };
        }
        await sleep(REPO_READY.intervalMs);
      }
      throw new GitCommitError(`${created.full_name} was created but its first commit never appeared`);
    },

    fileExists: (o) => githubFileExists({ token, ...o }),
    createBranch: async (o) => {
      await githubCreateBranch({ token, ...o });
    },
    deleteBranch: (o) => githubDeleteBranch({ token, ...o }),
    commitFiles: (o) => githubCommitFiles({ token, ...o }),
    findOpenChangeRequest: async ({ repo, base, isMine }) => {
      const pr = await findOpenPullRequest({ token, repo, base, isMine });
      return pr ? { url: pr.url, branch: pr.branch } : null;
    },
    openChangeRequest: async (o) => {
      const pr = await openPullRequest({ token, ...o });
      return { url: pr.url };
    },
  };
}

// -- GitLab ------------------------------------------------------------------

/** git's blob id: sha1("blob <bytes>\0<content>"). GitLab's tree listing
 *  reports it, so unchanged files can be left out of a commit without
 *  downloading them. */
export function gitBlobSha(content: string): string {
  const body = Buffer.from(content, "utf8");
  return createHash("sha1")
    .update(Buffer.concat([Buffer.from(`blob ${body.length}\0`), body]))
    .digest("hex");
}

function gitlabClient(token: string): GitHostClient {
  const gl = (method: string, path: string, body?: object) =>
    fetch(`${GITLAB_API}${path}`, {
      method,
      headers: {
        "PRIVATE-TOKEN": token,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  const pid = (repo: string) => encodeURIComponent(repo);
  const fail = async (what: string, res: Response): Promise<never> => {
    const text = await res.text().catch(() => "");
    throw new GitCommitError(`GitLab ${what} failed (${res.status}): ${text.slice(0, 200)}`);
  };

  /** path -> { blob sha, mode } for every file on `branch`. */
  async function tree(repo: string, branch: string) {
    const out = new Map<string, { sha: string; mode: string }>();
    for (let page = 1; page < 100; page++) {
      const res = await gl(
        "GET",
        `/projects/${pid(repo)}/repository/tree?ref=${encodeURIComponent(branch)}&recursive=true&per_page=100&page=${page}`
      );
      if (!res.ok) return fail(`tree listing for ${repo}@${branch}`, res);
      const items = (await res.json()) as { path: string; type: string; id: string; mode: string }[];
      for (const it of items) if (it.type === "blob") out.set(it.path, { sha: it.id, mode: it.mode });
      if (!res.headers.get("x-next-page")) break;
    }
    return out;
  }

  return {
    host: "gitlab",
    changeRequestNoun: "merge request",

    async repoExists(repo) {
      const res = await gl("GET", `/projects/${pid(repo)}`);
      if (res.status === 404) return false;
      if (!res.ok) return fail(`project lookup for ${repo}`, res);
      return true;
    },

    async defaultBranch(repo) {
      const res = await gl("GET", `/projects/${pid(repo)}`);
      if (!res.ok) return fail(`project lookup for ${repo}`, res);
      return ((await res.json()) as { default_branch: string }).default_branch;
    },

    async listFiles({ repo, ref }) {
      return { paths: [...(await tree(repo, ref)).keys()], truncated: false };
    },

    async readFile({ repo, path, ref }) {
      const res = await gl(
        "GET",
        `/projects/${pid(repo)}/repository/files/${encodeURIComponent(path)}/raw?ref=${encodeURIComponent(ref)}`
      );
      if (res.status === 404) return null;
      if (!res.ok) return fail(`file read for ${repo}/${path}`, res);
      return res.text();
    },

    // Import checks are GitHub Actions workflows; GitLab follows later.
    async getChangeRequest() {
      throw new GitCommitError("reading a merge request's checks is not built for GitLab yet");
    },
    async getCheckRun() {
      throw new GitCommitError("reading a merge request's checks is not built for GitLab yet");
    },

    async createFromTemplate({ template, repo, private: isPrivate }) {
      const slash = repo.lastIndexOf("/");
      const namespacePath = repo.slice(0, slash);
      const name = repo.slice(slash + 1);
      const ns = await gl("GET", `/namespaces/${encodeURIComponent(namespacePath)}`);
      if (!ns.ok) return fail(`namespace lookup for ${namespacePath}`, ns);
      const { id: namespaceId } = (await ns.json()) as { id: number };
      // GitLab has no cross-host template, so the template is imported by URL.
      // Templates are public GitHub repositories.
      const res = await gl("POST", "/projects", {
        name,
        path: name,
        namespace_id: namespaceId,
        visibility: isPrivate ? "private" : "public",
        import_url: `https://github.com/${template}.git`,
      });
      if (!res.ok) return fail(`project creation for ${repo}`, res);
      const created = (await res.json()) as { id: number; path_with_namespace: string; web_url: string };
      for (let i = 0; i < REPO_READY.attempts; i++) {
        const p = await gl("GET", `/projects/${created.id}`);
        if (!p.ok) return fail(`import status for ${repo}`, p);
        const proj = (await p.json()) as { import_status: string; default_branch: string | null; import_error?: string };
        if (proj.import_status === "failed") {
          throw new GitCommitError(`GitLab could not import ${template} into ${repo}: ${proj.import_error ?? "unknown error"}`);
        }
        if (proj.import_status === "finished" && proj.default_branch) {
          return { repo: created.path_with_namespace, defaultBranch: proj.default_branch, url: created.web_url };
        }
        await sleep(REPO_READY.intervalMs);
      }
      throw new GitCommitError(`${repo} was created but its import never finished`);
    },

    async fileExists({ repo, path, branch }) {
      const res = await gl(
        "HEAD",
        `/projects/${pid(repo)}/repository/files/${encodeURIComponent(path)}?ref=${encodeURIComponent(branch)}`
      );
      if (res.status === 404) return false;
      if (!res.ok) return fail(`file lookup for ${repo}/${path}`, res);
      return true;
    },

    async createBranch({ repo, from, branch }) {
      const res = await gl(
        "POST",
        `/projects/${pid(repo)}/repository/branches?branch=${encodeURIComponent(branch)}&ref=${encodeURIComponent(from)}`
      );
      if (!res.ok) await fail(`branch creation for ${repo}@${branch}`, res);
    },

    async deleteBranch({ repo, branch }) {
      const res = await gl("DELETE", `/projects/${pid(repo)}/repository/branches/${encodeURIComponent(branch)}`);
      if (!res.ok && res.status !== 404) await fail(`branch delete for ${repo}@${branch}`, res);
    },

    async commitFiles({ repo, branch, workDir, files, message }) {
      const prefix = workDir ? `${workDir.replace(/^\/+|\/+$/g, "")}/` : "";
      const existing = await tree(repo, branch);
      // GitLab's commit API has no upsert, so each file is a create, an update
      // or (mode only) a chmod, and unchanged files are left out entirely.
      const actions: Record<string, unknown>[] = [];
      for (const f of files) {
        const path = `${prefix}${f.fileName}`;
        const executable = f.mode === "100755";
        const have = existing.get(path);
        // GitLab only honours execute_filemode on a chmod action, so the mode
        // is set by its own action after the content one.
        const wasExecutable = have?.mode === "100755";
        if (!have) {
          actions.push({ action: "create", file_path: path, content: f.content });
        } else if (have.sha !== gitBlobSha(f.content)) {
          actions.push({ action: "update", file_path: path, content: f.content });
        }
        if (executable !== wasExecutable && (executable || have)) {
          actions.push({ action: "chmod", file_path: path, execute_filemode: executable });
        }
      }
      if (actions.length === 0) return { commitSha: null, noop: true };
      const res = await gl("POST", `/projects/${pid(repo)}/repository/commits`, {
        branch,
        commit_message: message,
        actions,
      });
      if (!res.ok) return fail(`commit to ${repo}@${branch}`, res);
      const commit = (await res.json()) as { id: string };
      return { commitSha: commit.id, noop: false };
    },

    async findOpenChangeRequest({ repo, base, isMine }) {
      const res = await gl(
        "GET",
        `/projects/${pid(repo)}/merge_requests?state=opened&target_branch=${encodeURIComponent(base)}&per_page=100`
      );
      if (!res.ok) return fail(`merge request list for ${repo}`, res);
      const mrs = (await res.json()) as {
        source_branch: string;
        web_url: string;
        source_project_id: number;
        target_project_id: number;
      }[];
      // Same-project branches only, as on GitHub: never a fork's.
      const hit = mrs.find((m) => m.source_project_id === m.target_project_id && isMine(m.source_branch));
      return hit ? { url: hit.web_url, branch: hit.source_branch } : null;
    },

    async openChangeRequest({ repo, head, base, title, body }) {
      const res = await gl("POST", `/projects/${pid(repo)}/merge_requests`, {
        source_branch: head,
        target_branch: base,
        title,
        description: body,
        remove_source_branch: true,
      });
      if (!res.ok) return fail(`merge request creation for ${repo}`, res);
      const mr = (await res.json()) as { web_url: string };
      return { url: mr.web_url };
    },
  };
}
