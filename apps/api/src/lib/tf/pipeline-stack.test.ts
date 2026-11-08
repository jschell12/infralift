import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// runStackJob end to end against a fake GitHub, with the database and the
// workspace adapter stubbed. What matters here is the sequence the customer's
// repository sees: a branch, one commit, a pull request, and nothing pushed to
// their default branch.

const h = vi.hoisted(() => {
  const state = {
    job: null as Record<string, unknown> | null,
    stages: [] as { stage: string; status: string; statusMessage: string }[],
    jobUpdates: [] as Record<string, unknown>[],
    workspaces: [] as Record<string, unknown>[],
    tfcLookups: [] as { orgId: string; connectionId: string }[],
  };
  const prisma = {
    tfJob: {
      findUniqueOrThrow: vi.fn(async () => state.job),
      findUnique: vi.fn(async () => ({ stage: state.stages.at(-1)?.stage ?? "render" })),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if ("stage" in data) state.stages.push(data as never);
        else state.jobUpdates.push(data);
        return {};
      }),
    },
    providerConnection: { findFirst: vi.fn(async () => ({ encryptedToken: "enc" })) },
    tfRendering: { upsert: vi.fn(async () => ({})), updateMany: vi.fn(async () => ({})) },
    tfProject: { update: vi.fn(async () => ({})) },
  };
  const adapter = {
    createWorkspace: vi.fn(async (opts: Record<string, unknown>) => {
      state.workspaces.push(opts);
    }),
    queueRun: vi.fn(async () => ({ id: "run", status: "pending" })),
  };
  return { state, prisma, adapter };
});

vi.mock("../db.js", () => ({ prisma: h.prisma }));
vi.mock("../crypto.js", () => ({ decryptToken: () => "token" }));
vi.mock("./tfc-connection.js", () => ({
  tfcAdapterFor: vi.fn(async (orgId: string, connectionId: string) => {
    h.state.tfcLookups.push({ orgId, connectionId });
    return { adapter: h.adapter, cred: { organization: "acme", hostname: "app.terraform.io", token: "t" } };
  }),
}));

const { runJob, stackBranchName, isStackBranch } = await import("./pipeline.js");
const { REPO_READY } = await import("../git/hosts.js");
REPO_READY.intervalMs = 0;
const { getStack } = await import("../stacks/index.js");

interface Call {
  method: string;
  path: string;
  body: Record<string, unknown> | undefined;
}

function fakeGitHub(
  opts: {
    existingPaths?: string[];
    /** "<branch>:<path>" pairs; existingPaths count on every branch */
    existingOn?: string[];
    unchanged?: boolean;
    openPrBranch?: string;
    failCommit?: boolean;
    /** the destination repo does not exist yet (greenfield) */
    noRepo?: boolean;
  } = {}
) {
  const calls: Call[] = [];
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = url.replace("https://api.github.com", "");
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      calls.push({ method, path, body });
      if (method === "GET" && path.includes("/contents/")) {
        const p = decodeURIComponent(path.split("/contents/")[1].split("?")[0]);
        const ref = decodeURIComponent(path.split("?ref=")[1] ?? "");
        return (opts.existingPaths ?? []).includes(p) || (opts.existingOn ?? []).includes(`${ref}:${p}`)
          ? json({ sha: "s", content: "" })
          : json({}, 404);
      }
      if (method === "GET" && path.includes("/pulls?"))
        return json(
          opts.openPrBranch
            ? [
                { number: 9, html_url: "https://github.com/acme/app/pull/9", head: { ref: "someone/else", repo: { full_name: "acme/app" } } },
                { number: 2, html_url: "https://github.com/acme/app/pull/2", head: { ref: opts.openPrBranch, repo: { full_name: "acme/app" } } },
              ]
            : []
        );
      if (method === "GET" && path === "/repos/acme/app") return opts.noRepo ? json({}, 404) : json({});
      if (method === "POST" && path === "/repos/jschell12/app-foundry/generate")
        return json({ full_name: "acme/app", default_branch: "trunk", html_url: "https://github.com/acme/app" }, 201);
      if (method === "GET" && path.includes("/git/ref/heads/")) return json({ object: { sha: "head" } });
      if (method === "POST" && path.endsWith("/git/refs")) return json({}, 201);
      if (method === "GET" && path.includes("/git/commits/")) return json({ tree: { sha: "tree-head" } });
      if (method === "POST" && path.endsWith("/git/blobs")) return json({ sha: "blob" }, 201);
      if (method === "POST" && path.endsWith("/git/trees"))
        return json({ sha: opts.unchanged ? "tree-head" : "tree-new" }, 201);
      if (method === "POST" && path.endsWith("/git/commits"))
        return opts.failCommit ? json({ message: "boom" }, 500) : json({ sha: "commit-new" }, 201);
      if (method === "PATCH" && path.includes("/git/refs/heads/")) return json({});
      if (method === "DELETE" && path.includes("/git/refs/heads/")) return new Response(null, { status: 204 });
      if (method === "POST" && path.endsWith("/pulls"))
        return json({ number: 3, html_url: "https://github.com/acme/app/pull/3" }, 201);
      return json({ message: `unhandled ${method} ${path}` }, 500);
    })
  );
  return calls;
}

const example = getStack("app-foundry-hetzner")!.example;

function stackJob(
  args: Record<string, unknown>,
  stackSlug = "app-foundry-hetzner",
  extra: Record<string, unknown> = {}
) {
  h.state.job = {
    id: "job_abcdefgh12345678",
    kind: "stack",
    argumentsJson: args,
    project: {
      id: "p1",
      orgId: "o1",
      name: "acme",
      stackSlug,
      gitHost: "github",
      gitConnectionId: null,
      createRepo: false,
      destRepo: "acme/app",
      destPath: "",
      destBranch: "main",
      ...extra,
    },
  };
}

beforeEach(() => {
  h.state.stages = [];
  h.state.jobUpdates = [];
  h.state.workspaces = [];
});
afterEach(() => vi.unstubAllGlobals());

describe("stack job", () => {
  it("lands the stack as a pull request, never a push to the default branch", async () => {
    stackJob(example);
    const calls = fakeGitHub();
    await runJob("job_abcdefgh12345678");

    const last = h.state.stages.at(-1)!;
    expect(last.stage).toBe("complete");
    expect(last.status).toBe("success");
    expect(last.statusMessage).toContain("https://github.com/acme/app/pull/3");

    const branch = stackBranchName("acme", "job_abcdefgh12345678");
    const refCreate = calls.find((c) => c.method === "POST" && c.path.endsWith("/git/refs"))!;
    expect(refCreate.body).toEqual({ ref: `refs/heads/${branch}`, sha: "head" });
    const pushes = calls.filter((c) => c.method === "PATCH");
    expect(pushes.map((c) => c.path)).toEqual([
      `/repos/acme/app/git/refs/heads/${encodeURIComponent(branch)}`,
    ]);
    const pr = calls.find((c) => c.path.endsWith("/pulls"))!;
    expect(pr.body).toMatchObject({ head: branch, base: "main" });
    expect(h.state.jobUpdates).toContainEqual({
      commitSha: "commit-new",
      prUrl: "https://github.com/acme/app/pull/3",
    });
    expect(h.state.workspaces).toEqual([]); // R2 backend: nothing to create
  });

  it("writes overrides.tf only when the repo does not have one", async () => {
    stackJob(example);
    let calls = fakeGitHub();
    await runJob("job_abcdefgh12345678");
    let tree = calls.find((c) => c.path.endsWith("/git/trees"))!.body!.tree as { path: string }[];
    expect(tree.map((t) => t.path)).toContain("deploy/infra/overrides.tf");

    calls = fakeGitHub({ existingPaths: ["deploy/infra/overrides.tf"] });
    await runJob("job_abcdefgh12345678");
    tree = calls.find((c) => c.path.endsWith("/git/trees"))!.body!.tree as { path: string }[];
    expect(tree.map((t) => t.path)).not.toContain("deploy/infra/overrides.tf");
    expect(tree.map((t) => t.path)).toContain("deploy/infra/generated/server.tf");
  });

  it("commits the box scripts as executable", async () => {
    stackJob(example);
    const calls = fakeGitHub();
    await runJob("job_abcdefgh12345678");
    const tree = calls.find((c) => c.path.endsWith("/git/trees"))!.body!.tree as {
      path: string;
      mode: string;
    }[];
    expect(tree.find((t) => t.path === "deploy/box/bin/deploy.sh")!.mode).toBe("100755");
  });

  it("creates the workspace in the project's own Terraform Cloud connection", async () => {
    h.state.tfcLookups = [];
    stackJob({ ...example, backend: "tfc", tfc_organization: "acme" }, "app-foundry-hetzner", { tfcConnectionId: "tfc-1" });
    fakeGitHub();
    await runJob("job_abcdefgh12345678");
    expect(h.state.workspaces).toEqual([
      expect.objectContaining({
        workspaceName: "app-foundry-demo",
        repo: "acme/app",
        branch: "main",
        workingDirectory: "deploy/infra",
        autoApply: false,
      }),
    ]);
    expect(h.adapter.queueRun).not.toHaveBeenCalled();
    expect(h.state.tfcLookups).toEqual([{ orgId: "o1", connectionId: "tfc-1" }]);
  });

  it("creates no workspace anywhere when a tfc project has no connection", async () => {
    h.state.workspaces = [];
    stackJob({ ...example, backend: "tfc", tfc_organization: "acme" });
    fakeGitHub();
    await runJob("job_abcdefgh12345678");
    expect(h.state.workspaces).toEqual([]);
    expect(h.state.stages.at(-1)).toMatchObject({ stage: "workspace", status: "errored" });
    expect(h.state.stages.at(-1)?.statusMessage).toMatch(/no Terraform Cloud connection is set/);
  });

  it("opens no pull request when the repo already matches, and removes its branch", async () => {
    stackJob(example);
    const calls = fakeGitHub({ unchanged: true });
    await runJob("job_abcdefgh12345678");
    expect(calls.some((c) => c.path.endsWith("/pulls"))).toBe(false);
    expect(calls.some((c) => c.method === "DELETE")).toBe(true);
    expect(h.state.stages.at(-1)).toMatchObject({ stage: "complete", status: "success" });
  });

  it("errors at render for an unknown stack or bad settings", async () => {
    stackJob(example, "no-such-stack");
    fakeGitHub();
    await runJob("job_abcdefgh12345678");
    expect(h.state.stages.at(-1)).toMatchObject({ stage: "render", status: "errored" });

    h.state.stages = [];
    stackJob({ ...example, server_type: "huge" });
    await runJob("job_abcdefgh12345678");
    expect(h.state.stages.at(-1)).toMatchObject({ stage: "render", status: "errored" });
  });

  it("a re-run while its PR is open pushes to that PR instead of opening another", async () => {
    stackJob(example);
    const calls = fakeGitHub({ openPrBranch: "infralift/acme-0ldj0b12" });
    await runJob("job_abcdefgh12345678");
    expect(calls.some((c) => c.method === "POST" && c.path.endsWith("/git/refs"))).toBe(false);
    expect(calls.some((c) => c.method === "POST" && c.path.endsWith("/pulls"))).toBe(false);
    const push = calls.find((c) => c.method === "PATCH")!;
    expect(push.path).toBe(`/repos/acme/app/git/refs/heads/${encodeURIComponent("infralift/acme-0ldj0b12")}`);
    expect(h.state.stages.at(-1)!.statusMessage).toContain("updated https://github.com/acme/app/pull/2");
  });

  it("removes the branch it created when a later step fails", async () => {
    stackJob(example);
    const calls = fakeGitHub({ failCommit: true });
    await runJob("job_abcdefgh12345678");
    expect(h.state.stages.at(-1)).toMatchObject({ stage: "commit", status: "errored" });
    const branch = stackBranchName("acme", "job_abcdefgh12345678");
    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.path)).toEqual([
      `/repos/acme/app/git/refs/heads/${encodeURIComponent(branch)}`,
    ]);
  });

  it("never deletes an existing PR's branch on failure", async () => {
    stackJob(example);
    const calls = fakeGitHub({ openPrBranch: "infralift/acme-0ldj0b12", failCommit: true });
    await runJob("job_abcdefgh12345678");
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("does not take over another project's PR whose name shares a prefix", async () => {
    stackJob(example); // project "acme"
    const calls = fakeGitHub({ openPrBranch: "infralift/acme-staging-0ldj0b12" });
    await runJob("job_abcdefgh12345678");
    expect(calls.some((c) => c.method === "POST" && c.path.endsWith("/pulls"))).toBe(true);
    const push = calls.find((c) => c.method === "PATCH")!;
    expect(push.path).toContain(encodeURIComponent(stackBranchName("acme", "job_abcdefgh12345678")));
  });

  it("keeps an overrides.tf the customer edited on the open PR's branch", async () => {
    stackJob(example);
    const calls = fakeGitHub({
      openPrBranch: "infralift/acme-0ldj0b12",
      existingOn: ["infralift/acme-0ldj0b12:deploy/infra/overrides.tf"],
    });
    await runJob("job_abcdefgh12345678");
    const tree = calls.find((c) => c.path.endsWith("/git/trees"))!.body!.tree as { path: string }[];
    expect(tree.map((t) => t.path)).not.toContain("deploy/infra/overrides.tf");
  });
});

describe("stack job: hosts and greenfield", () => {
  it("creates the repo from the app template, then branches off its default branch", async () => {
    stackJob(example, "app-foundry-hetzner", { createRepo: true });
    const calls = fakeGitHub({ noRepo: true });
    await runJob("job_abcdefgh12345678");
    expect(h.state.stages.map((x) => x.stage)).toContain("repo");
    const gen = calls.find((c) => c.path.endsWith("/generate"))!;
    expect(gen.body).toMatchObject({ owner: "acme", name: "app", private: true });
    expect(h.prisma.tfProject.update).toHaveBeenCalledWith({
      where: { id: "p1" },
      data: { createRepo: false, destBranch: "trunk" },
    });
    const pr = calls.find((c) => c.path.endsWith("/pulls") && c.method === "POST")!;
    expect(pr.body).toMatchObject({ base: "trunk" });
    expect(h.state.stages.at(-1)!.statusMessage).toContain("created https://github.com/acme/app");
  });

  it("does not create a repo that already exists", async () => {
    stackJob(example, "app-foundry-hetzner", { createRepo: true });
    const calls = fakeGitHub();
    await runJob("job_abcdefgh12345678");
    expect(calls.some((c) => c.path.endsWith("/generate"))).toBe(false);
    expect(h.state.stages.at(-1)).toMatchObject({ stage: "complete", status: "success" });
  });

  it("refuses a delivery that does not run on the project's host before touching anything", async () => {
    stackJob({ ...example, delivery: "github-actions" }, "app-foundry-hetzner", {
      gitHost: "gitlab",
      destRepo: "acme/platform/web",
    });
    const calls = fakeGitHub();
    await runJob("job_abcdefgh12345678");
    expect(h.state.stages.at(-1)).toMatchObject({ stage: "render", status: "errored" });
    expect(h.state.stages.at(-1)!.statusMessage).toContain("does not run on GitLab; use GitLab CI");
    expect(calls).toEqual([]);
  });
});

describe("isStackBranch", () => {
  it("matches only branches made for exactly this project", () => {
    expect(isStackBranch("app", "infralift/app-abc12345")).toBe(true);
    expect(isStackBranch("app", "infralift/app-staging-abc12345")).toBe(false);
    expect(isStackBranch("app", "infralift/app-abc123456")).toBe(false);
    expect(isStackBranch("app", "infralift/apps-abc12345")).toBe(false);
    expect(isStackBranch("app", "feature/app-abc12345")).toBe(false);
  });
});
