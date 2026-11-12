import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

// The import routes against a fake GitHub repository, with Prisma and the job
// runner stubbed: org scoping, what is stored, and when an import is refused.

const h = vi.hoisted(() => ({
  connFindFirst: vi.fn(),
  assessmentFindFirst: vi.fn(),
  projectFindFirst: vi.fn(),
  projectUpdate: vi.fn(),
  jobFindFirst: vi.fn(),
  projectCreate: vi.fn(),
  jobCreate: vi.fn(),
  runJob: vi.fn(async () => {}),
}));

vi.mock("../lib/db.js", () => ({
  prisma: {
    providerConnection: { findFirst: h.connFindFirst },
    tfProject: { create: h.projectCreate, findFirst: h.projectFindFirst, update: h.projectUpdate },
    assessment: { findFirst: h.assessmentFindFirst },
    tfJob: { create: h.jobCreate, findFirst: h.jobFindFirst },
  },
}));
vi.mock("../lib/crypto.js", () => ({ decryptToken: () => "token" }));
vi.mock("../lib/jobs/start.js", () => ({ startJob: h.runJob }));

const { importsRouter } = await import("./imports.js");

const REPO: Record<string, string> = {
  "envs/prod/main.tf":
    'terraform {\n  backend "s3" {\n    bucket = "acme-state"\n    key = "prod.tfstate"\n  }\n}\nresource "aws_instance" "web" {}\n',
  "envs/dev/main.tf": 'terraform {\n  backend "gcs" {}\n}\nresource "google_storage_bucket" "b" {}\n',
  "envs/dev/a.tfbackend": 'bucket = "a"\n',
  "envs/dev/b.tfbackend": 'bucket = "b"\n',
  "laptop/main.tf": 'resource "aws_s3_bucket" "b" {}\n',
  "src/index.ts": "export {};\n",
};

function fakeGitHub(status = 200) {
  const json = (body: unknown, code = 200) => new Response(JSON.stringify(body), { status: code });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const path = url.replace("https://api.github.com", "");
      if (status !== 200) return json({ message: "nope" }, status);
      if (path === "/repos/acme/infra") return json({ default_branch: "trunk" });
      if (path.startsWith("/repos/acme/infra/git/trees/trunk"))
        return json({ truncated: false, tree: Object.keys(REPO).map((p) => ({ path: p, type: "blob" })) });
      if (path.startsWith("/repos/acme/infra/contents/")) {
        const p = decodeURIComponent(path.split("/contents/")[1].split("?")[0]);
        return p in REPO ? new Response(REPO[p]) : json({}, 404);
      }
      return json({ message: `unhandled ${path}` }, 500);
    })
  );
}

type Handler = (req: unknown, res: unknown) => unknown;

async function call(path: string, body: Record<string, unknown>, method = "post", params: Record<string, string> = {}) {
  const layer = (
    importsRouter as unknown as {
      stack: { route?: { path: string; methods: Record<string, boolean>; stack: { handle: Handler }[] } }[];
    }
  ).stack.find((l) => l.route?.path === path && l.route?.methods[method]);
  const out = { status: 200, body: undefined as unknown as Record<string, unknown> };
  const res = {
    status(code: number) {
      out.status = code;
      return this;
    },
    json(payload: Record<string, unknown>) {
      out.body = payload;
      return this;
    },
  };
  await layer!.route!.stack.at(-1)!.handle({ user: { orgId: "org-a" }, params, query: {}, body }, res);
  return out;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.connFindFirst.mockResolvedValue({ id: "conn-1", encryptedToken: "enc" });
  h.projectCreate.mockImplementation(async ({ data }: { data: object }) => ({ id: "p1", ...data }));
  h.jobCreate.mockImplementation(async ({ data }: { data: object }) => ({ id: "job1", ...data }));
  fakeGitHub();
});

describe("POST /tf/imports/scan", () => {
  it("lists root modules with what each needs, scoped to the org's connection", async () => {
    const out = await call("/scan", { repo: "acme/infra" });
    expect(out.status).toBe(200);
    expect(h.connFindFirst.mock.calls[0][0].where).toMatchObject({ orgId: "org-a", provider: "github" });
    expect(out.body.ref).toBe("trunk");
    expect(out.body.filesRead).toBe(5); // src/index.ts is never fetched
    const roots = out.body.roots as { path: string; readiness: string; secrets: string[]; checkFile: string }[];
    expect(roots.map((r) => [r.path, r.readiness])).toEqual([
      ["envs/dev", "ready"],
      ["envs/prod", "ready"],
      ["laptop", "blocked"],
    ]);
    expect(roots[1].secrets).toEqual(["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"]);
    expect(roots[1].checkFile).toBe(".github/workflows/infralift-import-envs-prod.yml");
  });

  it("asks for a GitHub connection when there is none", async () => {
    h.connFindFirst.mockResolvedValue(null);
    expect((await call("/scan", { repo: "acme/infra" })).status).toBe(400);
  });

  it("answers 502 when GitHub refuses", async () => {
    fakeGitHub(403);
    const out = await call("/scan", { repo: "acme/infra" });
    expect(out.status).toBe(502);
    expect(String(out.body.error)).toContain("403");
  });
});

describe("POST /tf/imports", () => {
  it("stores the server's own scan and queues the import job", async () => {
    const out = await call("/", { repo: "acme/infra", path: "envs/prod", name: "acme-prod" });
    expect(out.status).toBe(202);
    const data = h.projectCreate.mock.calls[0][0].data;
    expect(data).toMatchObject({
      orgId: "org-a",
      name: "acme-prod",
      source: "imported",
      gitHost: "github",
      gitConnectionId: "conn-1",
      destRepo: "acme/infra",
      destBranch: "trunk",
      destPath: "envs/prod",
    });
    expect(data.importJson.backend.settings.bucket).toBe("acme-state");
    expect(h.jobCreate.mock.calls[0][0].data).toEqual({
      projectId: "p1",
      kind: "import",
      argumentsJson: { backendConfigFile: null },
    });
    expect(h.runJob).toHaveBeenCalledWith("job1");
  });

  it("409s when the project already has a job going, and starts nothing", async () => {
    h.jobCreate.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "6" }));
    const out = await call("/", { repo: "acme/infra", path: "envs/prod", name: "acme-prod" });
    expect(out.status).toBe(409);
    expect(out.body.error).toBe("a job is already running for this project");
    expect(h.runJob).not.toHaveBeenCalled();
  });

  it("refuses a module that is not ready, without creating anything", async () => {
    const out = await call("/", { repo: "acme/infra", path: "laptop", name: "laptop" });
    expect(out.status).toBe(409);
    expect(String(out.body.error)).toMatch(/No remote backend/);
    expect(h.projectCreate).not.toHaveBeenCalled();
  });

  it("asks which backend config file when there are several", async () => {
    const ask = await call("/", { repo: "acme/infra", path: "envs/dev", name: "acme-dev" });
    expect(ask.status).toBe(400);
    expect(ask.body.configFiles).toEqual(["envs/dev/a.tfbackend", "envs/dev/b.tfbackend"]);
    const wrong = await call("/", { repo: "acme/infra", path: "envs/dev", name: "acme-dev", backendConfigFile: "x" });
    expect(wrong.status).toBe(400);
    const ok = await call("/", { repo: "acme/infra", path: "envs/dev", name: "acme-dev", backendConfigFile: "envs/dev/b.tfbackend" });
    expect(ok.status).toBe(202);
    expect(h.jobCreate.mock.calls[0][0].data.argumentsJson).toEqual({ backendConfigFile: "envs/dev/b.tfbackend" });
  });

  it("404s a path with no root module and 409s a duplicate name", async () => {
    expect((await call("/", { repo: "acme/infra", path: "src", name: "nope-x" })).status).toBe(404);
    h.projectCreate.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "6" })
    );
    expect((await call("/", { repo: "acme/infra", path: "envs/prod", name: "acme-prod" })).status).toBe(409);
  });
});

describe("GET /tf/imports/:projectId/check", () => {
  function fakeChecks(
    opts: { conclusion: string; message: string; level: string } | null,
    prStatus = 200,
    gen?: { parentRun: { conclusion: string; message: string; level: string }; files?: { filename: string }[] }
  ) {
    const json = (body: unknown, code = 200) => new Response(JSON.stringify(body), { status: code });
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const path = url.replace("https://api.github.com", "");
        calls.push(path);
        if (path === "/repos/acme/infra/pulls/4")
          return prStatus === 200
            ? json({ html_url: "https://github.com/acme/infra/pull/4", state: "open", merged_at: null, head: { sha: "head1" } })
            : json({ message: "no" }, prStatus);
        if (path === "/repos/acme/infra/commits/head1")
          return json({
            commit: { message: gen ? "infralift: generated code for imported resources\n\nbody" : "fix the bucket" },
            parents: [{ sha: "parent1" }],
            files: gen?.files ?? [{ filename: "infra/generated.tf" }],
          });
        if (path.startsWith("/repos/acme/infra/commits/parent1/check-runs"))
          return json({
            check_runs: gen
              ? [{ id: 8, status: "completed", conclusion: gen.parentRun.conclusion, html_url: "https://github.com/acme/infra/runs/8", started_at: "2026-11-08T00:00:00Z", completed_at: "2026-11-08T00:01:00Z", output: { annotations_count: 1 } }]
              : [],
          });
        if (path.startsWith("/repos/acme/infra/check-runs/8/annotations"))
          return json([{ annotation_level: gen!.parentRun.level, message: gen!.parentRun.message }]);
        if (path.startsWith("/repos/acme/infra/commits/head1/check-runs"))
          return json({
            check_runs: opts
              ? [{ id: 7, status: "completed", conclusion: opts.conclusion, html_url: "https://github.com/acme/infra/runs/7", started_at: "2026-11-08T00:00:00Z", completed_at: "2026-11-08T00:01:00Z", output: { annotations_count: 1 } }]
              : [],
          });
        if (path.startsWith("/repos/acme/infra/check-runs/7/annotations"))
          return json([{ annotation_level: opts!.level, message: opts!.message }]);
        return json({ message: `unhandled ${path}` }, 500);
      })
    );
    return calls;
  }

  beforeEach(() => {
    h.projectFindFirst.mockResolvedValue({ id: "p1", destRepo: "acme/infra", destPath: "infra", gitConnectionId: "conn-1", importCheckJson: null });
    h.jobFindFirst.mockResolvedValue({ prUrl: "https://github.com/acme/infra/pull/4" });
  });

  it("reads the check on the PR's current head and stores the result", async () => {
    const calls = fakeChecks({ conclusion: "failure", level: "failure", message: "2 of 9 resources would change." });
    const out = await call("/:projectId/check", {}, "get", { projectId: "p1" });
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ state: "changes", message: "2 of 9 resources would change.", headSha: "head1" });
    expect(h.projectFindFirst.mock.calls[0][0].where).toEqual({ id: "p1", orgId: "org-a", source: "imported" });
    expect(calls.some((c) => c.includes("check_name=Plan%20changes%20nothing"))).toBe(true);
    expect(h.projectUpdate.mock.calls[0][0].data.importCheckJson.state).toBe("changes");
  });

  it("takes the result from the run that made the generated-code commit", async () => {
    fakeChecks(null, 200, { parentRun: { conclusion: "success", level: "notice", message: "No changes: all 3 resources match the code." } });
    const out = await call("/:projectId/check", {}, "get", { projectId: "p1" });
    expect(out.body).toMatchObject({ state: "passed", message: "No changes: all 3 resources match the code." });
  });

  it("borrows no result for a commit that touches more than generated.tf", async () => {
    fakeChecks(null, 200, {
      parentRun: { conclusion: "success", level: "notice", message: "No changes: all 3 resources match the code." },
      files: [{ filename: "infra/generated.tf" }, { filename: "infra/main.tf" }],
    });
    expect((await call("/:projectId/check", {}, "get", { projectId: "p1" })).body.state).toBe("waiting");
  });

  it("waits when the check has not run", async () => {
    fakeChecks(null);
    expect((await call("/:projectId/check", {}, "get", { projectId: "p1" })).body.state).toBe("waiting");
  });

  it("answers 502 with the last result when GitHub refuses", async () => {
    fakeChecks(null, 403);
    h.projectFindFirst.mockResolvedValue({ id: "p1", destRepo: "acme/infra", gitConnectionId: "conn-1", importCheckJson: { state: "passed" } });
    const out = await call("/:projectId/check", {}, "get", { projectId: "p1" });
    expect(out.status).toBe(502);
    expect(out.body.last).toEqual({ state: "passed" });
    expect(h.projectUpdate).not.toHaveBeenCalled();
  });

  it("404s another org's project", async () => {
    h.projectFindFirst.mockResolvedValue(null);
    expect((await call("/:projectId/check", {}, "get", { projectId: "p1" })).status).toBe(404);
  });
});

describe("POST /tf/imports/from-assessment", () => {
  const backend = { kind: "r2", bucket: "acme-state", key: "do/terraform.tfstate", accountId: "0123456789abcdef0123456789abcdef" };
  const inventory = [
    { type: "digitalocean:droplet", externalId: "123", name: "web-1", region: "nyc3", monthlyCostCents: 600, metadata: null },
    { type: "digitalocean:database", externalId: "db-uuid", name: "main", region: null, monthlyCostCents: 1500, metadata: null },
    { type: "digitalocean:app", externalId: "app-uuid", name: "site", region: null, monthlyCostCents: 500, metadata: null },
  ];

  beforeEach(() => {
    h.assessmentFindFirst.mockResolvedValue({ id: "as1", provider: "digitalocean", inventory });
    const json = (body: unknown, code = 200) => new Response(JSON.stringify(body), { status: code });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const path = url.replace("https://api.github.com", "");
        if (path === "/repos/acme/infra") return json({ default_branch: "main" });
        if (path.startsWith("/repos/acme/infra/contents/")) return json({}, 404);
        return json({ message: `unhandled ${path}` }, 500);
      })
    );
  });

  it("stores an adoption that generates its code, and queues the import job with the files", async () => {
    const out = await call("/from-assessment", { assessmentId: "as1", repo: "acme/infra", name: "acme-do", path: "infra/do", backend });
    expect(out.status).toBe(202);
    expect(h.assessmentFindFirst.mock.calls[0][0].where).toEqual({ id: "as1", orgId: "org-a", status: "completed" });
    expect(out.body).toMatchObject({ adopted: 2 });
    expect((out.body.skipped as { type: string }[]).map((s) => s.type)).toEqual(["digitalocean:app"]);
    const data = h.projectCreate.mock.calls[0][0].data;
    expect(data).toMatchObject({ source: "imported", assessmentId: "as1", destPath: "infra/do", destBranch: "main" });
    expect(data.importJson.generateConfig).toBe(true);
    expect(data.importJson.credentials).toEqual(["DIGITALOCEAN_TOKEN", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"]);
    const files = h.jobCreate.mock.calls[0][0].data.argumentsJson.adoptFiles as { path: string; content: string }[];
    expect(files.map((f) => f.path)).toEqual(["versions.tf", "provider.tf", "imports.tf"]);
    expect(files[2].content).toContain('to = digitalocean_droplet.web_1');
    expect(files[2].content).toContain('id = "123"');
  });

  it("refuses to write over existing files", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.endsWith("/repos/acme/infra")
          ? new Response(JSON.stringify({ default_branch: "main" }))
          : new Response(JSON.stringify({ sha: "x" }))
      )
    );
    const out = await call("/from-assessment", { assessmentId: "as1", repo: "acme/infra", name: "acme-do", path: "infra/do", backend });
    expect(out.status).toBe(409);
    expect(h.projectCreate).not.toHaveBeenCalled();
  });

  it("rejects a bad backend and an unsafe path before touching GitHub", async () => {
    const bad = await call("/from-assessment", { assessmentId: "as1", repo: "acme/infra", name: "acme-do", path: "infra/do", backend: { ...backend, bucket: "Bad Bucket" } });
    expect(bad.status).toBe(400);
    const unsafe = await call("/from-assessment", { assessmentId: "as1", repo: "acme/infra", name: "acme-do", path: "infra/$(x)", backend });
    expect(unsafe.status).toBe(400);
  });

  it("404s another org's assessment", async () => {
    h.assessmentFindFirst.mockResolvedValue(null);
    expect((await call("/from-assessment", { assessmentId: "as1", repo: "acme/infra", name: "acme-do", path: "x", backend })).status).toBe(404);
  });
});
