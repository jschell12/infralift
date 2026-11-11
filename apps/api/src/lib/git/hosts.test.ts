import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gitBlobSha, gitHostClient, REPO_READY } from "./hosts.js";

// The GitLab client and GitHub's create-from-template, against fakes that
// answer only the endpoints each call should touch.

interface Call {
  method: string;
  path: string;
  body: Record<string, unknown> | undefined;
}

type Route = (call: Call, query: URLSearchParams) => Response | undefined;

function fake(base: string, routes: Route[]) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      const basePath = new URL(base).pathname.replace(/\/$/, "");
      const path = basePath ? u.pathname.replace(basePath, "") : u.pathname;
      const call = {
        method: init?.method ?? "GET",
        path,
        body: init?.body ? JSON.parse(init.body as string) : undefined,
      };
      calls.push(call);
      for (const r of routes) {
        const res = r(call, u.searchParams);
        if (res) return res;
      }
      return new Response(JSON.stringify({ message: `unhandled ${call.method} ${path}` }), { status: 500 });
    })
  );
  return calls;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

beforeEach(() => {
  REPO_READY.intervalMs = 0;
});
afterEach(() => vi.unstubAllGlobals());

describe("gitBlobSha", () => {
  it("matches git hash-object", () => {
    // printf 'echo hi\n' | git hash-object --stdin
    expect(gitBlobSha("echo hi\n")).toBe("8b2fe5434fec16870a71cd8b272c7fcf6d352536");
  });
});

describe("GitLab", () => {
  const GL = "https://gitlab.com/api/v4";
  const P = "/projects/acme%2Fplatform%2Fweb";

  it("commits only what changed: create, update, chmod, and leaves identical files out", async () => {
    const calls = fake(GL, [
      (c) =>
        c.method === "GET" && c.path.startsWith(`${P}/repository/tree`)
          ? json([
              { path: "same.txt", type: "blob", id: gitBlobSha("same\n"), mode: "100644" },
              { path: "changed.txt", type: "blob", id: gitBlobSha("old\n"), mode: "100644" },
              { path: "deploy.sh", type: "blob", id: gitBlobSha("#!/bin/sh\n"), mode: "100644" },
              { path: "deploy", type: "tree", id: "t", mode: "040000" },
            ])
          : undefined,
      (c) => (c.method === "POST" && c.path === `${P}/repository/commits` ? json({ id: "c1" }, 201) : undefined),
    ]);
    const gl = gitHostClient("gitlab", "t");
    const out = await gl.commitFiles({
      repo: "acme/platform/web",
      branch: "infralift/web-abc12345",
      workDir: "",
      message: "m",
      files: [
        { fileName: "same.txt", content: "same\n" },
        { fileName: "changed.txt", content: "new\n" },
        { fileName: "deploy.sh", content: "#!/bin/sh\n", mode: "100755" },
        { fileName: "new.txt", content: "x\n" },
      ],
    });
    expect(out).toEqual({ commitSha: "c1", noop: false });
    const actions = calls.find((c) => c.path.endsWith("/repository/commits"))!.body!.actions as {
      action: string;
      file_path: string;
      execute_filemode?: boolean;
    }[];
    expect(actions.map((a) => [a.action, a.file_path, a.execute_filemode])).toEqual([
      ["update", "changed.txt", undefined],
      ["chmod", "deploy.sh", true],
      ["create", "new.txt", undefined],
    ]);
  });

  it("makes no commit when nothing changed", async () => {
    const calls = fake(GL, [
      (c) =>
        c.path.startsWith(`${P}/repository/tree`)
          ? json([{ path: "a.txt", type: "blob", id: gitBlobSha("a\n"), mode: "100644" }])
          : undefined,
    ]);
    const out = await gitHostClient("gitlab", "t").commitFiles({
      repo: "acme/platform/web",
      branch: "b",
      workDir: "",
      message: "m",
      files: [{ fileName: "a.txt", content: "a\n" }],
    });
    expect(out).toEqual({ commitSha: null, noop: true });
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("reads every page of the tree", async () => {
    fake(GL, [
      (c, q) =>
        c.path.startsWith(`${P}/repository/tree`) && q.get("page") === "1"
          ? json([{ path: "a.txt", type: "blob", id: gitBlobSha("a\n"), mode: "100644" }], 200, { "x-next-page": "2" })
          : undefined,
      (c, q) =>
        c.path.startsWith(`${P}/repository/tree`) && q.get("page") === "2"
          ? json([{ path: "b.txt", type: "blob", id: gitBlobSha("b\n"), mode: "100644" }])
          : undefined,
    ]);
    const out = await gitHostClient("gitlab", "t").commitFiles({
      repo: "acme/platform/web",
      branch: "b",
      workDir: "",
      message: "m",
      files: [{ fileName: "b.txt", content: "b\n" }],
    });
    expect(out.noop).toBe(true); // b.txt was on page 2 and unchanged
  });

  it("creates a project from the template by import and waits for it", async () => {
    let polls = 0;
    const calls = fake(GL, [
      (c) => (c.method === "GET" && c.path === "/namespaces/acme%2Fplatform" ? json({ id: 42 }) : undefined),
      (c) =>
        c.method === "POST" && c.path === "/projects"
          ? json({ id: 7, path_with_namespace: "acme/platform/web", web_url: "https://gitlab.com/acme/platform/web" }, 201)
          : undefined,
      (c) =>
        c.method === "GET" && c.path === "/projects/7"
          ? json(
              ++polls < 3
                ? { import_status: "started", default_branch: null }
                : { import_status: "finished", default_branch: "main" }
            )
          : undefined,
    ]);
    const out = await gitHostClient("gitlab", "t").createFromTemplate({
      template: "jschell12/app-foundry",
      repo: "acme/platform/web",
      private: true,
    });
    expect(out).toEqual({
      repo: "acme/platform/web",
      defaultBranch: "main",
      url: "https://gitlab.com/acme/platform/web",
    });
    expect(calls.find((c) => c.method === "POST")!.body).toMatchObject({
      name: "web",
      path: "web",
      namespace_id: 42,
      visibility: "private",
      import_url: "https://github.com/jschell12/app-foundry.git",
    });
  });

  it("reports a failed import", async () => {
    fake(GL, [
      (c) => (c.path.startsWith("/namespaces/") ? json({ id: 1 }) : undefined),
      (c) => (c.method === "POST" && c.path === "/projects" ? json({ id: 7, path_with_namespace: "a/b", web_url: "u" }, 201) : undefined),
      (c) => (c.path === "/projects/7" ? json({ import_status: "failed", import_error: "boom" }) : undefined),
    ]);
    await expect(
      gitHostClient("gitlab", "t").createFromTemplate({ template: "x/y", repo: "a/b", private: true })
    ).rejects.toThrow(/boom/);
  });

  it("finds only its own same-project merge request", async () => {
    fake(GL, [
      (c) =>
        c.path === `${P}/merge_requests`
          ? json([
              { source_branch: "infralift/web-abc12345", web_url: "fork", source_project_id: 9, target_project_id: 1 },
              { source_branch: "feature/x", web_url: "other", source_project_id: 1, target_project_id: 1 },
              { source_branch: "infralift/web-abc12345", web_url: "mine", source_project_id: 1, target_project_id: 1 },
            ])
          : undefined,
    ]);
    const mr = await gitHostClient("gitlab", "t").findOpenChangeRequest({
      repo: "acme/platform/web",
      base: "main",
      isMine: (b) => b.startsWith("infralift/web-"),
    });
    expect(mr).toEqual({ url: "mine", branch: "infralift/web-abc12345" });
  });

  it("opens a merge request that deletes its branch on merge", async () => {
    const calls = fake(GL, [
      (c) => (c.method === "POST" && c.path === `${P}/merge_requests` ? json({ web_url: "https://gitlab.com/mr/1" }, 201) : undefined),
    ]);
    const out = await gitHostClient("gitlab", "t").openChangeRequest({
      repo: "acme/platform/web",
      head: "infralift/web-abc12345",
      base: "main",
      title: "t",
      body: "b",
    });
    expect(out.url).toBe("https://gitlab.com/mr/1");
    expect(calls[0].body).toMatchObject({
      source_branch: "infralift/web-abc12345",
      target_branch: "main",
      remove_source_branch: true,
    });
  });
});

describe("GitLab executable files", () => {
  it("creates an executable as create + chmod, since GitLab ignores the mode on create", async () => {
    const calls = fake("https://gitlab.com/api/v4", [
      (c) => (c.path.includes("/repository/tree") ? json([]) : undefined),
      (c) => (c.method === "POST" && c.path.endsWith("/repository/commits") ? json({ id: "c" }, 201) : undefined),
    ]);
    await gitHostClient("gitlab", "t").commitFiles({
      repo: "a/b",
      branch: "x",
      workDir: "",
      message: "m",
      files: [{ fileName: "deploy.sh", content: "#!/bin/sh\n", mode: "100755" }],
    });
    const actions = calls.find((c) => c.path.endsWith("/repository/commits"))!.body!.actions as {
      action: string;
      execute_filemode?: boolean;
    }[];
    expect(actions.map((a) => [a.action, a.execute_filemode])).toEqual([
      ["create", undefined],
      ["chmod", true],
    ]);
  });
});

describe("GitHub createFromTemplate", () => {
  it("generates from the template and waits for the first commit", async () => {
    let refPolls = 0;
    const calls = fake("https://api.github.com", [
      (c) =>
        c.method === "POST" && c.path === "/repos/jschell12/app-foundry/generate"
          ? json({ full_name: "acme/web", default_branch: "main", html_url: "https://github.com/acme/web" }, 201)
          : undefined,
      (c) =>
        c.method === "GET" && c.path === "/repos/acme/web/git/ref/heads/main"
          ? ++refPolls < 2
            ? json({ message: "Not Found" }, 404)
            : json({ object: { sha: "s" } })
          : undefined,
    ]);
    const out = await gitHostClient("github", "t").createFromTemplate({
      template: "jschell12/app-foundry",
      repo: "acme/web",
      private: true,
    });
    expect(out).toEqual({ repo: "acme/web", defaultBranch: "main", url: "https://github.com/acme/web" });
    expect(calls[0].body).toEqual({ owner: "acme", name: "web", private: true, include_all_branches: false });
  });
});

describe("resolveRef and listTree", () => {
  // Tree entries exactly as GitHub returned them on 2026-11-10: a symlink and
  // a file from jschell12/shopping-mawl@7860ad3, a submodule (no size field)
  // from jschell12/schellout-engineering-team@9ad901d, and a directory.
  const githubTree = {
    tree: [
      { mode: "120000", path: "godot/assets/models/cooler.glb", sha: "ae30c9f08ab320a3a4ee56aa0be8c6ed99176503", size: 36, type: "blob" },
      { mode: "100644", path: "godot/project.godot", sha: "183a293ac4310d306c96d9076fcecc5124818831", size: 584, type: "blob" },
      { mode: "160000", path: "examples/agent-comparison/swe-af-minimax/todo-app-benchmark", sha: "d5fbea402cd490e36d57a5d588aa91e58768f11a", type: "commit" },
      { mode: "040000", path: "godot", sha: "t", type: "tree" },
    ],
    truncated: false,
  };

  it("GitHub: resolves a ref to its commit and lists files with their modes", async () => {
    fake("https://api.github.com", [
      (c) => (c.path === "/repos/acme/stacks/commits/v1" ? json({ sha: "aa3858b185ce340c2256d03e58992df3977eb348" }) : undefined),
      (c) => (c.path === "/repos/acme/stacks/commits/nope" ? json({ message: "No commit found for SHA: nope" }, 422) : undefined),
      (c) => (c.path.startsWith("/repos/acme/stacks/git/trees/") ? json(githubTree) : undefined),
    ]);
    const gh = gitHostClient("github", "t");
    expect(await gh.resolveRef({ repo: "acme/stacks", ref: "v1" })).toBe("aa3858b185ce340c2256d03e58992df3977eb348");
    expect(await gh.resolveRef({ repo: "acme/stacks", ref: "nope" })).toBeNull();
    expect(await gh.listTree({ repo: "acme/stacks", ref: "aa3858b" })).toEqual({
      entries: [
        { path: "godot/assets/models/cooler.glb", type: "blob", mode: "120000", size: 36 },
        { path: "godot/project.godot", type: "blob", mode: "100644", size: 584 },
        { path: "examples/agent-comparison/swe-af-minimax/todo-app-benchmark", type: "commit", mode: "160000", size: null },
      ],
      truncated: false,
    });
  });

  // Not a live capture: the tree items have the shape the GitLab fakes above
  // use, and the commit is the documented { id }.
  it("GitLab: resolves a ref through the commits API and keeps modes", async () => {
    const P = "/projects/acme%2Fstacks";
    fake("https://gitlab.com/api/v4", [
      (c) => (c.path === `${P}/repository/commits/v1` ? json({ id: "c0ffee" }) : undefined),
      (c) => (c.path === `${P}/repository/commits/nope` ? json({ message: "404 Commit Not Found" }, 404) : undefined),
      (c) =>
        c.path.startsWith(`${P}/repository/tree`)
          ? json([
              { path: "s/stack.json", type: "blob", id: "1", mode: "100644" },
              { path: "s/files/link", type: "blob", id: "2", mode: "120000" },
              { path: "s/files", type: "tree", id: "3", mode: "040000" },
            ])
          : undefined,
    ]);
    const gl = gitHostClient("gitlab", "t");
    expect(await gl.resolveRef({ repo: "acme/stacks", ref: "v1" })).toBe("c0ffee");
    expect(await gl.resolveRef({ repo: "acme/stacks", ref: "nope" })).toBeNull();
    expect((await gl.listTree({ repo: "acme/stacks", ref: "c0ffee" })).entries).toEqual([
      { path: "s/stack.json", type: "blob", mode: "100644", size: null },
      { path: "s/files/link", type: "blob", mode: "120000", size: null },
    ]);
  });
});
