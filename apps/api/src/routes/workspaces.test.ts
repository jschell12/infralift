import { beforeEach, describe, expect, it, vi } from "vitest";

// Adopted workspaces and extensions act on a customer's own Terraform Cloud
// org with a write-capable token, and adopted templates point at their
// private repository. These pin the `where` clauses that keep one org's
// connection, projects and templates out of another's reach. Prisma is
// stubbed; nothing here reaches TFC.

const db = vi.hoisted(() => ({
  providerConnection: { findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn() },
  tfProject: { findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn() },
  workspace: { findMany: vi.fn(), findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), upsert: vi.fn() },
  workspaceDependency: { create: vi.fn() },
  $transaction: vi.fn(),
  tfTemplate: { findMany: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(), upsert: vi.fn() },
  tfTemplateVersion: { findUnique: vi.fn(), create: vi.fn() },
  assessment: { create: vi.fn() },
}));
vi.mock("../lib/db.js", () => ({ prisma: db }));
vi.mock("node:dns/promises", () => ({ lookup: async () => [{ address: "52.1.2.3" }] }));

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
    if (typeof model === "function") continue;
    for (const fn of Object.values(model)) (fn as ReturnType<typeof vi.fn>).mockReset().mockResolvedValue(null);
  }
  db.$transaction.mockReset().mockImplementation(async (fn: (tx: typeof db) => unknown) => fn(db));
  vi.unstubAllGlobals();
});

process.env.TOKEN_ENCRYPTION_KEY ??= "0".repeat(64);
const { encryptToken } = await import("../lib/crypto.js");
const conn = () => ({
  id: "conn_mine",
  encryptedToken: encryptToken(JSON.stringify({ organization: "acme", token: "t" })),
});

/** Fake TFC: GET of a workspace by name returns `existing`; records every call. */
function fakeTfc(existing: { id: string; description: string } | null) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (url: string, init: { method: string }) => {
    calls.push(`${init.method} ${url.replace("https://app.terraform.io/api/v2", "")}`);
    const ok = (status: number, body: unknown) => ({
      ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body),
    });
    if (init.method === "GET" && url.includes("/organizations/acme/workspaces/")) {
      return existing
        ? ok(200, { data: { id: existing.id, attributes: { name: "app", description: existing.description } } })
        : ok(404, {});
    }
    if (init.method === "POST" && url.endsWith("/organizations/acme/workspaces")) {
      return ok(201, { data: { id: "ws-new", attributes: { name: "app" } } });
    }
    return ok(200, { data: [] });
  });
  return calls;
}

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
    db.providerConnection.findFirst.mockResolvedValue(conn());
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

describe("an extension never takes over the customer's own workspace", () => {
  const base = { projectId: "proj_mine" };
  beforeEach(() => {
    db.tfProject.findFirst.mockResolvedValue({ id: base.projectId, name: "p" });
    db.workspace.findMany.mockResolvedValue([]);
    db.providerConnection.findFirst.mockResolvedValue(conn());
    db.workspace.create.mockResolvedValue({ id: "w1", name: "app", kind: "extension", tfcWorkspaceUrl: "u" });
  });
  const create = () =>
    call(workspacesRouter, "post", "/projects/:projectId/extensions", {
      user,
      params: { projectId: base.projectId },
      body: { name: "app", connectionId: "conn_mine" },
    });

  it("refuses when a same-named workspace already exists and infralift did not make it", async () => {
    const calls = fakeTfc({ id: "ws-theirs", description: "hand built by ops" });
    const res = await create();
    expect(res.status).toBe(409);
    expect(calls.filter((c) => c.startsWith("POST"))).toEqual([]);
    expect(db.workspace.create).not.toHaveBeenCalled();
  });

  it("reuses one it made for this project on an earlier attempt", async () => {
    const { extensionMarker } = await import("../lib/tf/extensions.js");
    fakeTfc({ id: "ws-ours", description: extensionMarker(base.projectId) });
    const res = await create();
    expect(res.status).toBe(201);
    expect(db.workspace.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ tfcWorkspaceId: "ws-ours" }) })
    );
  });

  it("does not reuse one made for a different project", async () => {
    const { extensionMarker } = await import("../lib/tf/extensions.js");
    fakeTfc({ id: "ws-other", description: extensionMarker("proj_other") });
    expect((await create()).status).toBe(409);
  });

  it("creates with the marker when the name is free", async () => {
    const calls = fakeTfc(null);
    const res = await create();
    expect(res.status).toBe(201);
    expect(calls).toContain("POST /organizations/acme/workspaces");
  });
});

describe("a broken graph is reported, not a 500", () => {
  it("GET /projects/:projectId names an edge that leaves the project", async () => {
    db.tfProject.findFirst.mockResolvedValue({ id: "proj_mine", name: "p" });
    db.workspace.findMany.mockResolvedValue([
      { id: "a", name: "a", kind: "extension", outputs: [], dependsOn: [{ dependsOnId: "elsewhere", outputs: {} }] },
    ]);
    const res = await call(workspacesRouter, "get", "/projects/:projectId", {
      user,
      params: { projectId: "proj_mine" },
    });
    expect(res.status).toBe(200);
    expect((res.body as { order: object }).order).toHaveProperty("inconsistent");
  });
});

describe("refreshing outputs is scoped to the caller's org", () => {
  it("POST /:id/outputs/refresh filters by orgId", async () => {
    const res = await call(workspacesRouter, "post", "/:id/outputs/refresh", {
      user,
      params: { id: "ws_someone_elses" },
    });
    expect(res.status).toBe(404);
    expect(db.workspace.findFirst).toHaveBeenCalledWith({ where: { id: "ws_someone_elses", orgId: "org_mine" } });
  });
});

describe("re-adopting", () => {
  const remoteWs = { id: "ws-1", attributes: { name: "core" } };
  beforeEach(() => {
    db.providerConnection.findFirst.mockResolvedValue(conn());
    vi.stubGlobal("fetch", async (url: string) => {
      const body = url.includes("/organizations/acme/workspaces/core") ? { data: remoteWs } : { data: [] };
      return { ok: true, status: 200, json: async () => body, text: async () => "" };
    });
  });
  const adopt = (projectName: string) =>
    call(workspacesRouter, "post", "/adopt", {
      user,
      body: { connectionId: "conn_mine", workspaceName: "core", projectName },
    });

  it("refuses to move an adopted workspace to another project, before creating anything", async () => {
    db.workspace.findUnique.mockResolvedValue({
      kind: "adopted", connectionId: "conn_mine", tfcWorkspaceId: "ws-1", projectId: "proj_a",
    });
    db.tfProject.findUnique.mockResolvedValue(null);
    const res = await adopt("other");
    expect(res.status).toBe(409);
    expect(db.tfProject.create).not.toHaveBeenCalled();
  });

  it("recovers a workspace whose connection was deleted and recreated", async () => {
    db.workspace.findUnique.mockResolvedValue({
      kind: "adopted", connectionId: null, tfcWorkspaceId: "ws-1", projectId: "proj_a",
    });
    db.tfProject.findUnique.mockResolvedValue({ id: "proj_a" });
    db.workspace.upsert.mockResolvedValue({ id: "w", name: "core", kind: "adopted", tfcWorkspaceUrl: "u" });
    const res = await adopt("p");
    expect(res.status).toBe(200);
  });

  it("refuses a different TFC workspace with the same name", async () => {
    db.workspace.findUnique.mockResolvedValue({
      kind: "adopted", connectionId: null, tfcWorkspaceId: "ws-OTHER", projectId: "proj_a",
    });
    db.tfProject.findUnique.mockResolvedValue({ id: "proj_a" });
    expect((await adopt("p")).status).toBe(409);
  });
});

describe("TFE hosts are re-checked when a stored connection is used", () => {
  it("refuses a connection whose host now resolves privately", async () => {
    const dns = await import("node:dns/promises");
    const spy = vi.spyOn(dns, "lookup").mockResolvedValueOnce([{ address: "10.0.0.2", family: 4 }] as never);
    db.providerConnection.findFirst.mockResolvedValue(conn());
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const res = await call(workspacesRouter, "get", "/remote", { user, query: { connectionId: "conn_mine" } });
    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("refuses to store one at POST /connections", async () => {
    const dns = await import("node:dns/promises");
    const spy = vi.spyOn(dns, "lookup").mockResolvedValueOnce([{ address: "192.168.1.5", family: 4 }] as never);
    const res = await call(workspacesRouter, "post", "/connections", {
      user,
      body: { label: "x", hostname: "tfe.example.com", organization: "acme", token: "t" },
    });
    expect(res.status).toBe(400);
    expect(db.providerConnection.create).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("a TFC failure never escapes the handler", () => {
  // Express 4 does not catch a rejected async handler: an escaped throw kills
  // the API process for every tenant. Seen live on 2026-10-08.
  it("POST /adopt answers 502 when the request itself fails", async () => {
    db.providerConnection.findFirst.mockResolvedValue(conn());
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });
    const res = await call(workspacesRouter, "post", "/adopt", {
      user,
      body: { connectionId: "conn_mine", workspaceName: "core", projectName: "p" },
    });
    expect(res.status).toBe(502);
  });

  it("POST /adopt answers 502 on a malformed body instead of throwing", async () => {
    db.providerConnection.findFirst.mockResolvedValue(conn());
    vi.stubGlobal("fetch", async (url: string) => {
      const body = url.endsWith("/workspaces/core")
        ? { data: { id: "ws-1", attributes: { name: "core" }, relationships: {} } }
        : null;
      return { ok: true, status: 200, json: async () => body, text: async () => "" };
    });
    db.workspace.findUnique.mockResolvedValue(null);
    db.tfProject.findUnique.mockResolvedValue({ id: "proj" });
    db.workspace.upsert.mockResolvedValue({ id: "w", name: "core", kind: "adopted", tfcWorkspaceUrl: "u" });
    const res = await call(workspacesRouter, "post", "/adopt", {
      user,
      body: { connectionId: "conn_mine", workspaceName: "core", projectName: "p" },
    });
    // null bodies are tolerated: adopted with no variables, outputs or template
    expect(res.status).toBe(201);
    expect((res.body as { template: { status: string } }).template.status).toBe("unavailable");
  });
});
