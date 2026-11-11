import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

// The real app in dev mode, where every request is dev@infralift.dev. That
// user is not in ADMIN_EMAILS, so the review routes must refuse it before the
// service runs, while the customer routes still answer.

process.env.ADMIN_EMAILS = "admin@example.com";
delete process.env.CF_ACCESS_TEAM_DOMAIN;

const updateMany = vi.fn(async () => ({ count: 0 }));
const findMany = vi.fn(async () => []);
vi.mock("../lib/db.js", () => ({
  prisma: {
    user: { findUnique: async () => ({ id: "u1", orgId: "org_dev", email: "dev@infralift.dev", name: "Dev" }) },
    stackSource: { findMany, updateMany, findFirst: async () => null },
  },
}));

let url: string;
let server: Server;
beforeAll(async () => {
  const { app } = await import("../app.js");
  await new Promise<void>((resolve) => (server = app.listen(0, () => resolve())));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server?.close());

describe("team stack review is admin-only", () => {
  it.each([
    ["GET", "/admin/stacks/pending"],
    ["POST", "/admin/stacks/src_1/approve"],
    ["POST", "/admin/stacks/src_1/revoke"],
  ])("%s %s answers 403 to a customer and touches nothing", async (method, path) => {
    const res = await fetch(url + path, {
      method,
      headers: { "content-type": "application/json" },
      body: method === "POST" ? JSON.stringify({ versionId: "ver_1" }) : undefined,
    });
    expect(res.status).toBe(403);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("a customer still lists stacks, scoped to its org", async () => {
    findMany.mockClear();
    const res = await fetch(url + "/stacks");
    expect(res.status).toBe(200);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { OR: [{ orgId: "org_dev" }, { visibility: "public", publishedVersionId: { not: null } }] } })
    );
    expect(findMany.mock.calls.flat().some((c) => JSON.stringify(c).includes("pending_public"))).toBe(false);
  });

  it("a customer cannot withdraw a stack outside its org", async () => {
    const res = await fetch(url + "/stacks/src_elsewhere/withdraw", { method: "POST" });
    expect(res.status).toBe(404);
    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: "src_elsewhere", orgId: "org_dev" }) }));
  });
});
