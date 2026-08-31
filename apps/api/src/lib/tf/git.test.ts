import { afterEach, describe, expect, it, vi } from "vitest";
import { commitFiles, ensureRepo, GitCommitError } from "./git.js";

// A GitHub stand-in that records calls and answers the handful of endpoints
// the git data API walk touches. The sequence (ref -> commit -> blobs -> tree
// -> commit -> ref) is intricate enough that exercising it against a fake is
// worth more than trusting it by inspection.
interface Call {
  method: string;
  path: string;
  body: Record<string, unknown> | undefined;
}

function fakeGitHub(opts: {
  repoExists?: boolean;
  headTreeSha?: string;
  /** tree sha the server returns when a new tree is created */
  newTreeSha?: string;
  createRepoStatus?: number;
  orgCreateStatus?: number;
}) {
  const calls: Call[] = [];
  const headTreeSha = opts.headTreeSha ?? "tree-head";
  const newTreeSha = opts.newTreeSha ?? "tree-new";
  let blobCounter = 0;

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const path = url.replace("https://api.github.com", "");
    const method = init?.method ?? "GET";
    const body = init?.body
      ? (JSON.parse(init.body as string) as Record<string, unknown>)
      : undefined;
    calls.push({ method, path, body });

    if (method === "GET" && /^\/repos\/[^/]+\/[^/]+$/.test(path)) {
      return opts.repoExists === false
        ? json({ message: "Not Found" }, 404)
        : json({ full_name: "acme/infra", default_branch: "main" });
    }
    if (method === "POST" && path.startsWith("/orgs/")) {
      const status = opts.orgCreateStatus ?? 404;
      if (status >= 400) return json({ message: "Not Found" }, status);
      return json({ full_name: "acme/infra", default_branch: "main" }, 201);
    }
    if (method === "POST" && path === "/user/repos") {
      const status = opts.createRepoStatus ?? 201;
      if (status >= 400) return json({ message: "nope" }, status);
      return json({ full_name: "acme/infra", default_branch: "main" }, 201);
    }
    if (method === "GET" && path.includes("/git/ref/heads/")) {
      return json({ object: { sha: "commit-head" } });
    }
    if (method === "GET" && path.includes("/git/commits/")) {
      return json({ tree: { sha: headTreeSha } });
    }
    if (method === "POST" && path.endsWith("/git/blobs")) {
      blobCounter += 1;
      return json({ sha: `blob-${blobCounter}` }, 201);
    }
    if (method === "POST" && path.endsWith("/git/trees")) {
      return json({ sha: newTreeSha }, 201);
    }
    if (method === "POST" && path.endsWith("/git/commits")) {
      return json({ sha: "commit-new" }, 201);
    }
    if (method === "PATCH" && path.includes("/git/refs/heads/")) {
      return json({ object: { sha: "commit-new" } });
    }
    return json({ message: `unhandled ${method} ${path}` }, 500);
  });

  vi.stubGlobal("fetch", fetchMock);
  return { calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const FILES = [
  { fileName: "versions.tf", content: "terraform {}\n" },
  { fileName: "main.tf", content: "resource {}\n" },
  { fileName: "README.md", content: "# infra\n" },
];

describe("commitFiles", () => {
  it("writes every file in a single commit", () => {
    const { calls } = fakeGitHub({});

    return commitFiles({
      token: "t",
      repo: "acme/infra",
      branch: "main",
      workDir: "infrastructure",
      files: FILES,
      message: "infralift: infrastructure",
    }).then((result) => {
      expect(result.noop).toBe(false);
      expect(result.commitSha).toBe("commit-new");

      // One blob per file, but only one tree, one commit and one ref update.
      const count = (m: string, suffix: string) =>
        calls.filter((c) => c.method === m && c.path.endsWith(suffix)).length;
      expect(count("POST", "/git/blobs")).toBe(3);
      expect(count("POST", "/git/trees")).toBe(1);
      expect(count("POST", "/git/commits")).toBe(1);
      expect(calls.filter((c) => c.method === "PATCH").length).toBe(1);
    });
  });

  it("layers onto the existing tree so unrelated files survive", async () => {
    const { calls } = fakeGitHub({ headTreeSha: "tree-head" });

    await commitFiles({
      token: "t",
      repo: "acme/infra",
      branch: "main",
      workDir: "infrastructure",
      files: FILES,
      message: "m",
    });

    const treeCall = calls.find((c) => c.path.endsWith("/git/trees"))!;
    // Without base_tree the commit would delete everything else in the repo.
    expect(treeCall.body?.base_tree).toBe("tree-head");
  });

  it("prefixes paths with the working directory", async () => {
    const { calls } = fakeGitHub({});

    await commitFiles({
      token: "t",
      repo: "acme/infra",
      branch: "main",
      workDir: "infrastructure",
      files: FILES,
      message: "m",
    });

    const treeCall = calls.find((c) => c.path.endsWith("/git/trees"))!;
    const paths = (treeCall.body?.tree as { path: string }[]).map((t) => t.path);
    expect(paths).toEqual([
      "infrastructure/versions.tf",
      "infrastructure/main.tf",
      "infrastructure/README.md",
    ]);
  });

  it("writes to the repo root when no working directory is set", async () => {
    const { calls } = fakeGitHub({});

    await commitFiles({
      token: "t",
      repo: "acme/infra",
      branch: "main",
      workDir: "",
      files: [FILES[0]],
      message: "m",
    });

    const treeCall = calls.find((c) => c.path.endsWith("/git/trees"))!;
    const paths = (treeCall.body?.tree as { path: string }[]).map((t) => t.path);
    expect(paths).toEqual(["versions.tf"]);
  });

  it("is a no-op when the resulting tree matches the branch", async () => {
    // Server returns the same tree sha the head commit already points at.
    const { calls } = fakeGitHub({ headTreeSha: "same", newTreeSha: "same" });

    const result = await commitFiles({
      token: "t",
      repo: "acme/infra",
      branch: "main",
      workDir: "infrastructure",
      files: FILES,
      message: "m",
    });

    expect(result.noop).toBe(true);
    expect(result.commitSha).toBeNull();
    // Nothing was committed and the branch was not moved.
    expect(calls.some((c) => c.path.endsWith("/git/commits") && c.method === "POST")).toBe(false);
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("does nothing at all for an empty file list", async () => {
    const { calls } = fakeGitHub({});
    const result = await commitFiles({
      token: "t",
      repo: "acme/infra",
      branch: "main",
      workDir: "",
      files: [],
      message: "m",
    });
    expect(result).toEqual({ commitSha: null, noop: true, paths: [] });
    expect(calls).toHaveLength(0);
  });
});

describe("ensureRepo", () => {
  it("leaves an existing repo alone", async () => {
    const { calls } = fakeGitHub({ repoExists: true });

    const result = await ensureRepo({ token: "t", repo: "acme/infra" });

    expect(result.created).toBe(false);
    expect(result.defaultBranch).toBe("main");
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("creates a missing repo, initialized so there is a branch to commit onto", async () => {
    const { calls } = fakeGitHub({ repoExists: false });

    const result = await ensureRepo({
      token: "t",
      repo: "acme/infra",
      description: "d",
    });

    expect(result.created).toBe(true);
    expect(result.repo).toBe("acme/infra");

    const create = calls.find((c) => c.method === "POST")!;
    expect(create.body?.private).toBe(true);
    // Without auto_init the repo has no ref, and the first commitFiles would
    // fail looking up the branch head.
    expect(create.body?.auto_init).toBe(true);
  });

  it("falls back to the user endpoint when the owner is not an org", async () => {
    const { calls } = fakeGitHub({ repoExists: false, orgCreateStatus: 404 });

    await ensureRepo({ token: "t", repo: "someuser/infra" });

    const posts = calls.filter((c) => c.method === "POST").map((c) => c.path);
    expect(posts).toEqual(["/orgs/someuser/repos", "/user/repos"]);
  });

  it("rejects a repo reference that is not owner/name", async () => {
    fakeGitHub({});
    await expect(ensureRepo({ token: "t", repo: "infra" })).rejects.toBeInstanceOf(
      GitCommitError
    );
  });

  it("surfaces a creation failure rather than continuing", async () => {
    fakeGitHub({ repoExists: false, createRepoStatus: 422 });
    await expect(
      ensureRepo({ token: "t", repo: "acme/infra" })
    ).rejects.toBeInstanceOf(GitCommitError);
  });
});
