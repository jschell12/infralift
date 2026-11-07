import { beforeEach, describe, expect, it, vi } from "vitest";

// runImportJob against a fake GitHub: the customer's repository gets one file,
// the read-only check, on a branch of its own with a pull request, and nothing
// in their Terraform is touched.

const h = vi.hoisted(() => {
  const state = {
    job: null as Record<string, unknown> | null,
    stages: [] as { stage: string; status: string; statusMessage: string }[],
    jobUpdates: [] as Record<string, unknown>[],
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
    tfRendering: { upsert: vi.fn(async () => ({})) },
  };
  return { state, prisma };
});

vi.mock("../db.js", () => ({ prisma: h.prisma }));
vi.mock("../crypto.js", () => ({ decryptToken: () => "token" }));

const { runJob } = await import("./pipeline.js");
const { scanRepo } = await import("../import/scan.js");

const ROOT = scanRepo([
  {
    path: "infra/main.tf",
    content: 'terraform {\n  backend "s3" {\n    bucket = "b"\n    key = "k"\n  }\n}\nresource "hcloud_server" "s" {}\n',
  },
]).roots[0];

interface Call {
  method: string;
  path: string;
  body: Record<string, unknown> | undefined;
}

function fakeGitHub(opts: { unchanged?: boolean; failCommit?: boolean } = {}) {
  const calls: Call[] = [];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = url.replace("https://api.github.com", "");
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      calls.push({ method, path, body });
      if (method === "GET" && path.includes("/pulls?")) return json([]);
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
        return json({ number: 4, html_url: "https://github.com/acme/infra/pull/4" }, 201);
      return json({ message: `unhandled ${method} ${path}` }, 500);
    })
  );
  return calls;
}

function importJob(extra: Record<string, unknown> = {}) {
  h.state.job = {
    id: "job_abcdefgh12345678",
    kind: "import",
    argumentsJson: { backendConfigFile: null },
    project: {
      id: "p1",
      orgId: "o1",
      name: "acme-infra",
      source: "imported",
      gitHost: "github",
      gitConnectionId: "c1",
      destRepo: "acme/infra",
      destPath: "infra",
      destBranch: "main",
      importJson: ROOT,
      ...extra,
    },
  };
}

beforeEach(() => {
  h.state.stages = [];
  h.state.jobUpdates = [];
  vi.clearAllMocks();
});

describe("import job", () => {
  it("adds only the check workflow, on its own branch, as a pull request", async () => {
    const calls = fakeGitHub();
    importJob();
    await runJob("job_abcdefgh12345678");
    expect(h.state.stages.at(-1)).toMatchObject({ stage: "complete", status: "success" });
    const tree = calls.find((c) => c.method === "POST" && c.path.endsWith("/git/trees"))!;
    const paths = (tree.body!.tree as { path: string }[]).map((t) => t.path);
    // The workflow lives at the repository root, not under the module.
    expect(paths).toEqual([".github/workflows/infralift-import-infra.yml"]);
    const ref = calls.find((c) => c.method === "POST" && c.path.endsWith("/git/refs"))!;
    expect(ref.body!.ref).toBe("refs/heads/infralift/acme-infra-12345678");
    expect(calls.some((c) => c.method === "PATCH" && c.path.includes("/git/refs/heads/main"))).toBe(false);
    const pr = calls.find((c) => c.method === "POST" && c.path.endsWith("/pulls"))!;
    expect(pr.body!.base).toBe("main");
    expect(String(pr.body!.body)).toContain("read-only");
    expect(String(pr.body!.body)).toContain("`HCLOUD_TOKEN`");
    expect(h.state.jobUpdates).toContainEqual({ commitSha: "commit-new", prUrl: "https://github.com/acme/infra/pull/4" });
  });

  it("removes its branch when the check is already there", async () => {
    const calls = fakeGitHub({ unchanged: true });
    importJob();
    await runJob("job_abcdefgh12345678");
    expect(h.state.stages.at(-1)).toMatchObject({ stage: "complete", status: "success" });
    expect(calls.some((c) => c.method === "DELETE" && decodeURIComponent(c.path).includes("infralift/acme-infra-12345678"))).toBe(true);
    expect(calls.some((c) => c.method === "POST" && c.path.endsWith("/pulls"))).toBe(false);
  });

  it("cleans up its branch when the commit fails", async () => {
    const calls = fakeGitHub({ failCommit: true });
    importJob();
    await runJob("job_abcdefgh12345678");
    expect(h.state.stages.at(-1)?.status).toBe("errored");
    expect(calls.some((c) => c.method === "DELETE" && decodeURIComponent(c.path).includes("infralift/acme-infra-12345678"))).toBe(true);
  });

  it("refuses a project with no scan", async () => {
    fakeGitHub();
    importJob({ importJson: null });
    await runJob("job_abcdefgh12345678");
    expect(h.state.stages.at(-1)).toMatchObject({ status: "errored" });
  });
});
