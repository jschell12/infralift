import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

// The real app, with a database that refuses connections. cfAuth in dev mode
// upserts a user on every request, so every authenticated route rejects
// inside async middleware. Before catchAsyncErrors that exited the process.

process.env.DATABASE_URL = "postgresql://nobody:x@127.0.0.1:1/none?connect_timeout=1";
delete process.env.CF_ACCESS_TEAM_DOMAIN;

let url: string;
let server: Server;

beforeAll(async () => {
  const { app } = await import("./app.js");
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server?.close());

describe("the API survives a database outage", () => {
  it("answers 500 on an authenticated route and keeps serving", async () => {
    const res = await fetch(url + "/workspaces");
    expect(res.status).toBe(500);
    const health = await fetch(url + "/health");
    expect(await health.json()).toEqual({ ok: true });
  }, 20000);
});

describe("every handler on the real app is wrapped", () => {
  // A router mounted after catchAsyncErrors(app) in app.ts would be skipped
  // silently. This walks the same tree and fails on any unwrapped handler.
  it("finds no unwrapped handler", async () => {
    const { app } = await import("./app.js");
    const { errorHandler } = await import("./lib/async-errors.js");
    type L = { handle: any; route?: { stack: L[] } };
    const unwrapped: string[] = [];
    const visit = (stack: L[], at: string) => {
      for (const l of stack) {
        if (l.route) visit(l.route.stack, at);
        else if (Array.isArray(l.handle.stack)) visit(l.handle.stack, at + "/");
        else if (l.handle._router) visit(l.handle._router.stack, at + "/");
        else if (l.handle === errorHandler) continue;
        else if (!Object.getOwnPropertySymbols(l.handle).length) unwrapped.push(`${at} ${l.handle.name}`);
      }
    };
    visit((app as any)._router.stack, "");
    expect(unwrapped).toEqual([]);
  });
});
