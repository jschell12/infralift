// GitHub commit adapter (REST contents API). Idempotent: committing content
// identical to what is already on the branch is a no-op.

const GITHUB_API = "https://api.github.com";

export class GitCommitError extends Error {}

interface ExistingFile {
  sha: string;
  content: string;
}

async function gh(
  token: string,
  method: string,
  path: string,
  body?: object
): Promise<Response> {
  return fetch(`${GITHUB_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function getExistingFile(
  token: string,
  repo: string,
  filePath: string,
  branch: string
): Promise<ExistingFile | null> {
  const res = await gh(
    token,
    "GET",
    `/repos/${repo}/contents/${encodeURIComponent(filePath).replace(/%2F/g, "/")}?ref=${encodeURIComponent(branch)}`
  );
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new GitCommitError(`GitHub read failed (${res.status}) for ${repo}/${filePath}`);
  }
  const json = (await res.json()) as { sha: string; content?: string };
  const content = json.content
    ? Buffer.from(json.content, "base64").toString("utf8")
    : "";
  return { sha: json.sha, content };
}

export interface CommitResult {
  commitSha: string | null; // null when content was already up to date
  noop: boolean;
}

export async function commitFile(opts: {
  token: string;
  repo: string; // owner/repo
  workDir: string; // "" = repo root
  fileName: string;
  content: string;
  message: string;
  branch: string;
}): Promise<CommitResult> {
  const filePath = opts.workDir
    ? `${opts.workDir.replace(/\/+$/, "")}/${opts.fileName}`
    : opts.fileName;
  const existing = await getExistingFile(
    opts.token,
    opts.repo,
    filePath,
    opts.branch
  );
  if (existing && existing.content === opts.content) {
    return { commitSha: null, noop: true };
  }
  const res = await gh(
    opts.token,
    "PUT",
    `/repos/${opts.repo}/contents/${encodeURIComponent(filePath).replace(/%2F/g, "/")}`,
    {
      message: opts.message,
      content: Buffer.from(opts.content, "utf8").toString("base64"),
      branch: opts.branch,
      ...(existing ? { sha: existing.sha } : {}),
    }
  );
  if (!res.ok) {
    const text = await res.text();
    throw new GitCommitError(
      `GitHub commit failed (${res.status}) for ${opts.repo}/${filePath}: ${text.slice(0, 200)}`
    );
  }
  const json = (await res.json()) as { commit: { sha: string } };
  return { commitSha: json.commit.sha, noop: false };
}
