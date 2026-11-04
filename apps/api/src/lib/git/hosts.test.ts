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
      execute_filemode: boolean;
    }[];
    expect(actions.map((a) => [a.action, a.file_path, a.execute_filemode])).toEqual([
      ["update", "changed.txt", false],
      ["chmod", "deploy.sh", true],
      ["create", "new.txt", false],
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
