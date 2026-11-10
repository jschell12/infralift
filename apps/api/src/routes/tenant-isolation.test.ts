import { describe, expect, it, vi } from "vitest";

// Signup on *.infralift.dev is self-serve as of 2026-08-31: any Google or
// GitHub account gets an Access JWT, and cfAuth turns that into a User and an
// Org. "Authenticated" therefore no longer means "the owner", and these are
// the routes where that distinction was load-bearing and unenforced.
//
// Prisma is stubbed so the assertions are about the `where` clause each
// handler builds, which is the part that was wrong.

const findFirst = vi.fn(async (): Promise<unknown> => null);
const update = vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => ({
  id: args.where.id,
  ...args.data,
}));

vi.mock("../lib/db.js", () => ({
  prisma: {
    assessment: { findFirst, findUnique: async () => null, update },
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

describe("reported spend is scoped to the caller's org", () => {
  const user = { orgId: "org_mine", userId: "u1", email: "a@b.c", name: null };

  it("refuses PATCH /:id/spend on another org's assessment, and writes nothing", async () => {
    findFirst.mockClear();
    update.mockClear();

    const res = await call(assessmentsRouter, "patch", "/:id/spend", {
      params: { id: "asm_someone_elses" },
      body: { monthlyUsd: 1200 },
      user,
    });

    // A bill the customer entered changes the savings every viewer of that
    // assessment sees, so a stranger with the id must not be able to set it.
    expect(res.status).toBe(404);
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "asm_someone_elses", orgId: "org_mine" },
      })
    );
    expect(update).not.toHaveBeenCalled();
  });

  it("stores dollars as cents on the caller's own assessment", async () => {
    findFirst.mockClear();
    update.mockClear();
    findFirst.mockResolvedValueOnce({ id: "asm_mine" });

    const res = await call(assessmentsRouter, "patch", "/:id/spend", {
      params: { id: "asm_mine" },
      body: { monthlyUsd: 755.49 },
      user,
    });

    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "asm_mine" },
        data: { reportedMonthlySpendCents: 75549 },
      })
    );
    expect(res.body).toEqual({ id: "asm_mine", reportedMonthlySpendCents: 75549 });
  });

  it("clears the reported bill with null", async () => {
    update.mockClear();
    findFirst.mockResolvedValueOnce({ id: "asm_mine" });

    const res = await call(assessmentsRouter, "patch", "/:id/spend", {
      params: { id: "asm_mine" },
      body: { monthlyUsd: null },
      user,
    });

    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { reportedMonthlySpendCents: null } })
    );
  });

  it("rejects a negative, absurd, missing or non-numeric bill before any lookup", async () => {
    for (const body of [
      { monthlyUsd: -1 },
      { monthlyUsd: 10_000_001 },
      {},
      { monthlyUsd: "1200" },
    ]) {
      findFirst.mockClear();
      update.mockClear();
      const res = await call(assessmentsRouter, "patch", "/:id/spend", {
        params: { id: "asm_mine" },
        body,
        user,
      });
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(findFirst).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
    }
  });

  it("accepts both ends of the range", async () => {
    for (const monthlyUsd of [0, 10_000_000]) {
      findFirst.mockResolvedValueOnce({ id: "asm_mine" });
      const res = await call(assessmentsRouter, "patch", "/:id/spend", {
        params: { id: "asm_mine" },
        body: { monthlyUsd },
        user,
      });
      expect(res.status).toBe(200);
    }
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
