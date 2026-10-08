import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express, { Router } from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { catchAsyncErrors, errorHandler } from "./async-errors.js";

// Real Express, real sockets. Without the wrapper each of these rejections is
// an unhandledRejection, which exits the process under vitest too, so the
// suite itself is the crash test.

async function serve(app: express.Express): Promise<{ url: string; server: Server }> {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}`, server });
    });
  });
}

function build() {
  const app = express();
  const router = Router();
  router.get("/async-throw", async () => {
    throw new Error("boom");
  });
  router.get("/sync-throw", () => {
    throw new Error("boom");
  });
  router.get("/ok", async (_req, res) => {
    res.json({ ok: true });
  });
  router.get("/route-level", async (_req, _res, next) => next(), async () => {
    throw new Error("second handler");
  });
  const nested = Router();
  nested.get("/deep", async () => {
    throw new Error("nested");
  });
  router.use("/nested", nested);
  app.use(async (req, _res, next) => {
    if (req.path === "/middleware-throw") throw new Error("auth blip");
    next();
  });
  app.use("/r", router);
  const wrapped = catchAsyncErrors(app as never);
  app.use(errorHandler);
  return { app, wrapped };
}

let url: string;
let server: Server;
let wrapped: number;

beforeAll(async () => {
  const built = build();
  wrapped = built.wrapped;
  ({ url, server } = await serve(built.app));
});
afterAll(() => server.close());

describe("catchAsyncErrors", () => {
  it.each(["/r/async-throw", "/r/sync-throw", "/r/route-level", "/r/nested/deep", "/middleware-throw"])(
    "%s answers 500 and the server keeps serving",
    async (path) => {
      const res = await fetch(url + path);
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "internal error" });
      const ok = await fetch(url + "/r/ok");
      expect(ok.status).toBe(200);
    }
  );

  it("does not leak the error message to the caller", async () => {
    const body = await (await fetch(url + "/r/async-throw")).text();
    expect(body).not.toContain("boom");
  });

  it("wraps every handler once, however often it is called, and skips error handlers", () => {
    // 7 of ours plus Express 4's own query and expressInit middleware.
    expect(wrapped).toBe(9);
    const { app } = build();
    const handles = () =>
      ((app as unknown as { _router: { stack: { handle: unknown }[] } })._router.stack).map((l) => l.handle);
    const before = handles();
    catchAsyncErrors(app as never);
    expect(handles()).toEqual(before);
    expect(before.at(-1)).toBe(errorHandler);
  });
});
