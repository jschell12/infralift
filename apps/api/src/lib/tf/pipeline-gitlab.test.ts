import { afterEach, describe, expect, it, vi } from "vitest";

// A stack job on GitLab, end to end against a fake GitLab: the GitLab CI
// delivery lands (not the GitHub one), scripts stay executable, and the
// change arrives as a merge request on a branch of its own.

const h = vi.hoisted(() => {
  const state = {
    job: null as Record<string, unknown> | null,
    stages: [] as { stage: string; status: string; statusMessage: string }[],
  };
  const prisma = {
    tfJob: {
      findUniqueOrThrow: vi.fn(async () => state.job),
      findUnique: vi.fn(async () => ({ stage: state.stages.at(-1)?.stage ?? "render" })),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if ("stage" in data) state.stages.push(data as never);
        return {};
      }),
    },
    providerConnection: { findFirst: vi.fn(async () => ({ encryptedToken: "enc" })) },
    tfRendering: { upsert: vi.fn(async () => ({})), updateMany: vi.fn(async () => ({})) },
    tfProject: { update: vi.fn(async () => ({})) },
  };
  return { state, prisma };
});

vi.mock("../db.js", () => ({ prisma: h.prisma }));
vi.mock("../crypto.js", () => ({ decryptToken: () => "token" }));
vi.mock("./workspace.js", () => ({
  getWorkspaceAdapter: () => ({ createWorkspace: vi.fn(), queueRun: vi.fn() }),
}));

const { runJob } = await import("./pipeline.js");
const { getStack } = await import("../stacks/index.js");

const example = getStack("app-foundry-hetzner")!.example;
const P = "/projects/acme%2Fplatform%2Fweb";

function fakeGitLab() {
  const calls: { method: string; path: string; body?: Record<string, unknown> }[] = [];
  const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      const path = u.pathname.replace("/api/v4", "");
      const method = init?.method ?? "GET";
      calls.push({ method, path, body: init?.body ? JSON.parse(init.body as string) : undefined });
      if (path === `${P}/merge_requests` && method === "GET") return json([]);
      if (path.startsWith(`${P}/repository/files/`)) return new Response(null, { status: 404 });
      if (path === `${P}/repository/branches` && method === "POST") return json({}, 201);
      if (path === `${P}/repository/tree`) return json([]);
      if (path === `${P}/repository/commits` && method === "POST") return json({ id: "c9" }, 201);
      if (path === `${P}/merge_requests` && method === "POST")
        return json({ web_url: "https://gitlab.com/acme/platform/web/-/merge_requests/1" }, 201);
      return json({ message: `unhandled ${method} ${path}` }, 500);
    })
  );
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("stack job on GitLab", () => {
  it("lands the GitLab CI delivery as a merge request", async () => {
    h.state.stages = [];
    h.state.job = {
      id: "job_abcdefgh12345678",
      kind: "stack",
      argumentsJson: { ...example, delivery: "gitlab-ci" },
      project: {
        id: "p1",
        orgId: "o1",
        name: "web",
        stackSlug: "app-foundry-hetzner",
        gitHost: "gitlab",
        gitConnectionId: null,
        createRepo: false,
        destRepo: "acme/platform/web",
        destPath: "",
        destBranch: "main",
      },
    };
    const calls = fakeGitLab();
    await runJob("job_abcdefgh12345678");

    expect(h.state.stages.at(-1)).toMatchObject({ stage: "complete", status: "success" });
    expect(h.state.stages.at(-1)!.statusMessage).toContain("merge_requests/1");

    const actions = calls.find((c) => c.path.endsWith("/repository/commits"))!.body!.actions as {
      action: string;
      file_path: string;
      content?: string;
      execute_filemode?: boolean;
    }[];
    const paths = actions.filter((a) => a.action === "create").map((a) => a.file_path);
    expect(paths).toContain(".gitlab-ci.yml");
    expect(paths).toContain("deploy/infra/generated/gitlab.tf");
    expect(paths.some((p) => p.startsWith(".github/"))).toBe(false);
    expect(paths).not.toContain("deploy/infra/generated/github.tf");
    expect(actions).toContainEqual({ action: "chmod", file_path: "deploy/box/bin/deploy.sh", execute_filemode: true });

    const main = actions.find((a) => a.file_path === "deploy/infra/main.tf")!.content!;
    expect(main).toContain('gitlab_project        = "acme/platform/web"');
    expect(main).toContain('provider "gitlab" {}');
    expect(main).not.toContain("github");

    const mr = calls.find((c) => c.method === "POST" && c.path === `${P}/merge_requests`)!;
    expect(mr.body).toMatchObject({ target_branch: "main", remove_source_branch: true });
    expect(String(mr.body!.source_branch)).toMatch(/^infralift\/web-[a-z0-9]{8}$/);
  });
});
