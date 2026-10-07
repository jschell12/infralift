import { beforeEach, describe, expect, it, vi } from "vitest";

// Adopted workspaces and extensions act on a customer's own Terraform Cloud
// org with a write-capable token, and adopted templates point at their
// private repository. These pin the `where` clauses that keep one org's
// connection, projects and templates out of another's reach. Prisma is
// stubbed; nothing here reaches TFC.

const db = vi.hoisted(() => ({
  providerConnection: { findFirst: vi.fn(), findUnique: vi.fn() },
  tfProject: { findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn() },
  workspace: { findMany: vi.fn(), findUnique: vi.fn() },
  tfTemplate: { findMany: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(), upsert: vi.fn() },
  tfTemplateVersion: { findUnique: vi.fn(), create: vi.fn() },
  assessment: { create: vi.fn() },
}));
vi.mock("../lib/db.js", () => ({ prisma: db }));

const { workspacesRouter } = await import("./workspaces.js");
const { tfRouter } = await import("./tf.js");
const { assessmentsRouter } = await import("./assessments.js");

type Handler = (req: unknown, res: unknown, next?: unknown) => unknown;
interface Layer {
  route?: { path: string; methods: Record<string, boolean>; stack: { handle: Handler }[] };
}

async function call(router: unknown, method: string, path: string, req: Record<string, unknown>) {
  const layer = (router as { stack: Layer[] }).stack.find(
    (l) => l.route?.path === path && l.route?.methods[method]
  );
  if (!layer?.route) throw new Error(`no ${method} ${path}`);
  const out = { status: 200, body: undefined as unknown };
  const res = {
    status(code: number) {
      out.status = code;
      return this;
    },
    json(payload: unknown) {
      out.body = payload;
      return this;
    },
  };
  const stack = layer.route.stack;
  await stack[stack.length - 1].handle({ query: {}, params: {}, body: {}, ...req }, res);
  return out;
}

const user = { orgId: "org_mine", userId: "u1", email: "a@b.c", name: null };

beforeEach(() => {
  for (const model of Object.values(db)) {
    for (const fn of Object.values(model)) (fn as ReturnType<typeof vi.fn>).mockReset().mockResolvedValue(null);
  }
});

describe("a Terraform Cloud connection is only usable by its own org", () => {
  it("POST /adopt looks the connection up by org and provider, not by id alone", async () => {
    const res = await call(workspacesRouter, "post", "/adopt", {
      user,
      body: { connectionId: "conn_someone_elses", workspaceName: "core", projectName: "p" },
    });
    expect(res.status).toBe(404);
    expect(db.providerConnection.findFirst).toHaveBeenCalledWith({
      where: { id: "conn_someone_elses", orgId: "org_mine", provider: "tfc" },
    });
  });

  it("GET /remote does the same", async () => {
    const res = await call(workspacesRouter, "get", "/remote", {
      user,
      query: { connectionId: "conn_someone_elses" },
    });
    expect(res.status).toBe(404);
    expect(db.providerConnection.findFirst).toHaveBeenCalledWith({
      where: { id: "conn_someone_elses", orgId: "org_mine", provider: "tfc" },
    });
  });
});

describe("project workspace graphs are scoped to the caller's org", () => {
  it("GET /projects/:projectId filters by orgId", async () => {
    const res = await call(workspacesRouter, "get", "/projects/:projectId", {
      user,
      params: { projectId: "proj_someone_elses" },
    });
    expect(res.status).toBe(404);
    expect(db.tfProject.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "proj_someone_elses", orgId: "org_mine" } })
    );
  });

  it("POST extensions refuses before touching the connection when the project is not ours", async () => {
    const res = await call(workspacesRouter, "post", "/projects/:projectId/extensions", {
      user,
      params: { projectId: "proj_someone_elses" },
      body: { name: "app", connectionId: "conn_x", dependsOn: [] },
    });
    expect(res.status).toBe(404);
    expect(db.providerConnection.findFirst).not.toHaveBeenCalled();
  });

  it("POST extensions only accepts bases from this project's workspace list", async () => {
    db.tfProject.findFirst.mockResolvedValue({ id: "proj_mine", name: "p" });
    db.workspace.findMany.mockResolvedValue([]);
    const enc = (await import("../lib/crypto.js")).encryptToken;
    process.env.TOKEN_ENCRYPTION_KEY ??= "0".repeat(64);
    db.providerConnection.findFirst.mockResolvedValue({
      id: "conn_mine",
      encryptedToken: enc(JSON.stringify({ organization: "acme", token: "t" })),
    });
    const res = await call(workspacesRouter, "post", "/projects/:projectId/extensions", {
      user,
      params: { projectId: "proj_mine" },
      body: { name: "app", connectionId: "conn_mine", dependsOn: [{ workspaceId: "ws_other_org" }] },
    });
    expect(res.status).toBe(422);
    expect(db.workspace.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { orgId: "org_mine", projectId: "proj_mine" } })
    );
  });
});

describe("org-private templates stay private", () => {
  const visible = { OR: [{ orgId: null }, { orgId: "org_mine" }] };

  it("GET /templates lists the shared catalog plus the caller's own", async () => {
    db.tfTemplate.findMany.mockResolvedValue([]);
    await call(tfRouter, "get", "/templates", { user });
    expect(db.tfTemplate.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: visible }));
  });

  it("preview by slug cannot reach another org's adopted template", async () => {
    const res = await call(tfRouter, "post", "/templates/:slug/versions/:tag/preview", {
      user,
      params: { slug: "adopted-org_theirs-core", tag: "abc" },
      body: { arguments: {} },
    });
    expect(res.status).toBe(404);
    expect(db.tfTemplate.findFirst).toHaveBeenCalledWith({
      where: { slug: "adopted-org_theirs-core", ...visible },
    });
  });

  it("creating a project from a slug applies the same filter", async () => {
    const res = await call(tfRouter, "post", "/projects", {
      user,
      body: {
        name: "p",
        templateSlug: "adopted-org_theirs-core",
        releaseTag: "abc",
        destRepo: "acme/infra",
        providerConfig: { name: "aws", source: "hashicorp/aws", version: "~> 5.0" },
      },
    });
    expect(res.status).toBe(404);
    expect(db.tfTemplate.findFirst).toHaveBeenCalledWith({
      where: { slug: "adopted-org_theirs-core", ...visible },
    });
  });

  it("an admin catalog write cannot take over a private template's slug", async () => {
    db.tfTemplate.findUnique.mockResolvedValue({ id: "t1", orgId: "org_theirs" });
    const res = await call(tfRouter, "post", "/templates", {
      user,
      body: {
        slug: "adopted-org-theirs-core",
        name: "x",
        releaseTag: "v1",
        templateBody: "x",
        inputSchema: {},
      },
    });
    expect(res.status).toBe(409);
    expect(db.tfTemplate.upsert).not.toHaveBeenCalled();
  });
});

describe("a TFC connection is not an assessment source", () => {
  it("POST /assessments/run refuses it without creating an assessment", async () => {
    db.providerConnection.findUnique.mockResolvedValue({
      id: "conn_mine",
      orgId: "org_mine",
      provider: "tfc",
      encryptedToken: "x",
    });
    const res = await call(assessmentsRouter, "post", "/run", {
      user,
      body: { connectionId: "conn_mine" },
    });
    expect(res.status).toBe(400);
    expect(db.assessment.create).not.toHaveBeenCalled();
  });
});
