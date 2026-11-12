import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

// Every list endpoint is bounded and reads only what it returns. What is
// asserted is the Prisma call each one makes (take, select), since that is
// where an unbounded read or a heavy column would come from. Also the leads
// routes' input checks: a non-numeric ?days= is a 400, and an update of a
// missing lead is a 404 recognized by Prisma's code, not its message text.

const h = vi.hoisted(() => ({
  connectionFindMany: vi.fn(async () => []),
  workspaceFindMany: vi.fn(async () => []),
  migrationFindMany: vi.fn(async () => []),
  projectFindMany: vi.fn(async () => []),
  projectFindFirst: vi.fn(async () => ({ id: "p1" })),
  renderingFindMany: vi.fn(async () => []),
  leadFindMany: vi.fn(async () => []),
  leadUpdate: vi.fn(),
  inboundUpdate: vi.fn(),
}));

vi.mock("../lib/db.js", () => ({
  prisma: {
    providerConnection: { findMany: h.connectionFindMany },
    workspace: { findMany: h.workspaceFindMany },
    migration: { findMany: h.migrationFindMany },
    tfProject: { findMany: h.projectFindMany, findFirst: h.projectFindFirst },
    tfRendering: { findMany: h.renderingFindMany },
    communityLead: { findMany: h.leadFindMany, update: h.leadUpdate },
    inboundLead: { update: h.inboundUpdate },
  },
}));

const { connectionsRouter } = await import("./connections.js");
const { workspacesRouter } = await import("./workspaces.js");
const { migrationsRouter } = await import("./migrations.js");
const { tfRouter } = await import("./tf.js");
const { leadsRouter } = await import("./leads.js");

type Handler = (req: unknown, res: unknown) => Promise<unknown>;
type Layer = { route?: { path: string; methods: Record<string, boolean>; stack: { handle: Handler }[] } };

/** Calls a route's final handler with a stub req/res. */
async function call(router: unknown, method: string, path: string, req: Record<string, unknown> = {}) {
  const layer = (router as { stack: Layer[] }).stack.find((l) => l.route?.path === path && l.route.methods[method]);
  if (!layer?.route) throw new Error(`no ${method} ${path}`);
  const out = { status: 200, body: undefined as unknown };
  const res = {
    headersSent: false,
    status: (code: number) => ((out.status = code), res),
    json: (payload: unknown) => ((out.body = payload), res),
    setHeader: () => res,
  };
  await layer.route.stack.at(-1)!.handle({ user: { orgId: "org_1" }, params: {}, query: {}, body: {}, ...req }, res);
  return out;
}

const firstArg = (fn: { mock: { calls: unknown[][] } }) => fn.mock.calls[0]![0] as Record<string, any>;
const notFound = () => new Prisma.PrismaClientKnownRequestError("No record was found for an update.", { code: "P2025", clientVersion: "test" });

beforeEach(() => vi.clearAllMocks());

describe("list endpoints are capped and read only listed columns", () => {
  it("connections: never selects the encrypted token", async () => {
    await call(connectionsRouter, "get", "/");
    const args = firstArg(h.connectionFindMany);
    expect(args.take).toBe(200);
    expect(args.select.encryptedToken).toBeUndefined();
    expect(args.select).toMatchObject({ id: true, provider: true, label: true, status: true });
  });

  it("workspaces: leaves out the inputs and outputs snapshots", async () => {
    await call(workspacesRouter, "get", "/");
    const args = firstArg(h.workspaceFindMany);
    expect(args.take).toBe(500);
    expect(args.select.inputs).toBeUndefined();
    expect(args.select.outputs).toBeUndefined();
  });

  it("migrations: newest 100", async () => {
    await call(migrationsRouter, "get", "/");
    expect(firstArg(h.migrationFindMany)).toMatchObject({ take: 100, orderBy: { createdAt: "desc" } });
  });

  it("projects: at most 200, with the newest 20 renderings' metadata and no bodies", async () => {
    await call(tfRouter, "get", "/projects");
    const args = firstArg(h.projectFindMany);
    expect(args.take).toBe(200);
    expect(args.include.renderings.take).toBe(20);
    expect(args.include.renderings.select.renderedBody).toBeUndefined();
  });

  it("renderings: newest 50, without renderedBody", async () => {
    await call(tfRouter, "get", "/projects/:id/renderings", { params: { id: "p1" } });
    const args = firstArg(h.renderingFindMany);
    expect(args.take).toBe(50);
    expect(args.select.renderedBody).toBeUndefined();
    expect(args.select).toMatchObject({ id: true, fileName: true, commitSha: true });
  });
});

describe("leads input checks", () => {
  it.each(["abc", "0", "-1"])("400s ?days=%s instead of querying with an Invalid Date", async (days) => {
    const out = await call(leadsRouter, "get", "/", { query: { days } });
    expect(out.status).toBe(400);
    expect(h.leadFindMany).not.toHaveBeenCalled();
  });

  it("400s ?limit= above 500 and accepts the admin page's 200", async () => {
    expect((await call(leadsRouter, "get", "/", { query: { limit: "501" } })).status).toBe(400);
    expect((await call(leadsRouter, "get", "/", { query: { days: "30", limit: "200" } })).status).toBe(200);
    expect(firstArg(h.leadFindMany).take).toBe(200);
  });

  it("404s an update of a lead that does not exist (P2025)", async () => {
    h.leadUpdate.mockRejectedValueOnce(notFound());
    const out = await call(leadsRouter, "patch", "/:id", { params: { id: "x" }, body: { status: "contacted" } });
    expect(out).toMatchObject({ status: 404, body: { error: "Lead not found" } });
  });

  it("404s an update of an inbound lead that does not exist (P2025)", async () => {
    h.inboundUpdate.mockRejectedValueOnce(notFound());
    const out = await call(leadsRouter, "patch", "/inbound/:id", { params: { id: "x" }, body: { status: "contacted" } });
    expect(out).toMatchObject({ status: 404, body: { error: "lead not found" } });
  });

  it("does not turn a different database error into a 404", async () => {
    h.leadUpdate.mockRejectedValueOnce(new Error("connection reset"));
    await expect(call(leadsRouter, "patch", "/:id", { params: { id: "x" }, body: { status: "contacted" } })).rejects.toThrow("connection reset");
  });
});
