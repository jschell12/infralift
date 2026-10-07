import { describe, expect, it, vi } from "vitest";

// Signup on *.infralift.dev is self-serve as of 2026-08-31: any Google or
// GitHub account gets an Access JWT, and cfAuth turns that into a User and an
// Org. "Authenticated" therefore no longer means "the owner", and these are
// the routes where that distinction was load-bearing and unenforced.
//
// Prisma is stubbed so the assertions are about the `where` clause each
// handler builds, which is the part that was wrong.

const findFirst = vi.fn(async () => null);

vi.mock("../lib/db.js", () => ({
  prisma: {
    assessment: { findFirst, findUnique: async () => null },
    migration: { findFirst },
  },
}));

const { assessmentsRouter } = await import("./assessments.js");
const { migrationsRouter } = await import("./migrations.js");
const { tfRouter } = await import("./tf.js");
const { requireAdmin } = await import("../lib/cf-auth.js");

type Handler = (req: unknown, res: unknown, next?: unknown) => unknown;

interface Layer {
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: { handle: Handler }[];
  };
}

function route(router: unknown, method: string, path: string) {
  const layer = (router as { stack: Layer[] }).stack.find(
    (l) => l.route?.path === path && l.route?.methods[method]
  );
  if (!layer?.route) throw new Error(`no ${method} ${path} on router`);
  return layer.route;
}

/** Call a route's final handler with a stub req/res and report the status. */
async function call(
  router: unknown,
  method: string,
  path: string,
  req: Record<string, unknown>
): Promise<{ status: number; body: unknown }> {
  const stack = route(router, method, path).stack;
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
  await stack[stack.length - 1].handle(req, res);
  return out;
}

describe("assessment reports are scoped to the caller's org", () => {
  it("filters GET /:id by orgId, not by id alone", async () => {
    findFirst.mockClear();

    const res = await call(assessmentsRouter, "get", "/:id", {
      params: { id: "asm_someone_elses" },
      user: { orgId: "org_mine", userId: "u1", email: "a@b.c", name: null },
    });

    // The report is inventory, findings and costs. An id lifted from a shared
    // dashboard URL must not be enough to read another org's.
    expect(res.status).toBe(404);
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "asm_someone_elses", orgId: "org_mine" },
      })
    );
  });
});

describe("migration plans are scoped to the caller's org", () => {
  it("filters GET /:id by orgId, not by id alone", async () => {
    findFirst.mockClear();

    const res = await call(migrationsRouter, "get", "/:id", {
      params: { id: "mig_someone_elses" },
      user: { orgId: "org_mine", userId: "u1", email: "a@b.c", name: null },
    });

    expect(res.status).toBe(404);
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "mig_someone_elses", orgId: "org_mine" },
      })
    );
  });
});

describe("shared-catalog and internal /tf routes stay admin-only", () => {
  // Templates with a null orgId are one shared catalog, keyed on slug, and
  // templateBody is Terraform the pipeline commits and applies, so a write is
  // not a per-tenant action however scoped the caller feels. Org-private
  // templates (adopted workspaces) are covered in workspaces.test.ts.
  it("guards POST /templates with requireAdmin", () => {
    const handlers = route(tfRouter, "post", "/templates").stack.map(
      (l) => l.handle
    );
    expect(handlers).toContain(requireAdmin);
  });

  it("guards GET /tfc-status with requireAdmin", () => {
    const handlers = route(tfRouter, "get", "/tfc-status").stack.map(
      (l) => l.handle
    );
    expect(handlers).toContain(requireAdmin);
  });

  it("leaves GET /templates readable, since the dashboard lists it", () => {
    const handlers = route(tfRouter, "get", "/templates").stack.map(
      (l) => l.handle
    );
    expect(handlers).not.toContain(requireAdmin);
  });
});
