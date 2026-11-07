import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

// The import routes against a fake GitHub repository, with Prisma and the job
// runner stubbed: org scoping, what is stored, and when an import is refused.

const h = vi.hoisted(() => ({
  connFindFirst: vi.fn(),
  projectCreate: vi.fn(),
  jobCreate: vi.fn(),
  runJob: vi.fn(async () => {}),
}));

vi.mock("../lib/db.js", () => ({
  prisma: {
    providerConnection: { findFirst: h.connFindFirst },
    tfProject: { create: h.projectCreate },
    tfJob: { create: h.jobCreate },
  },
}));
vi.mock("../lib/crypto.js", () => ({ decryptToken: () => "token" }));
vi.mock("../lib/tf/pipeline.js", () => ({ runJob: h.runJob }));

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

async function call(path: string, body: Record<string, unknown>) {
  const layer = (
    importsRouter as unknown as {
      stack: { route?: { path: string; methods: Record<string, boolean>; stack: { handle: Handler }[] } }[];
    }
  ).stack.find((l) => l.route?.path === path && l.route?.methods.post);
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
  await layer!.route!.stack.at(-1)!.handle({ user: { orgId: "org-a" }, params: {}, query: {}, body }, res);
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
