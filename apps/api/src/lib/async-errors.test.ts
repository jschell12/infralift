import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express, { Router } from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { format } from "node:util";
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
  app.use(express.json({ limit: "1kb" }));
  const router = Router();
  router.post("/echo", (req, res) => res.json(req.body));
  router.get("/async-throw", async () => {
    throw new Error("boom");
  });
  router.get("/sync-throw", () => {
    throw new Error("boom");
  });
  router.get("/ok", async (_req, res) => {
    res.json({ ok: true });
  });
  router.get("/empty-reject", async () => Promise.reject(undefined), (_req, res) => {
    res.json({ fellThrough: true });
  });
  const sub = express();
  sub.get("/deep", async () => {
    throw new Error("sub-app");
  });
  router.use("/sub", sub);
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
  it.each(["/r/async-throw", "/r/sync-throw", "/r/route-level", "/r/nested/deep", "/r/sub/deep", "/r/empty-reject", "/middleware-throw"])(
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
    // Completeness is asserted on the real app in app.test.ts; here, that the
    // walk found handlers and a second pass changes nothing.
    expect(wrapped).toBeGreaterThan(0);
    const { app } = build();
    const handles = () =>
      ((app as unknown as { _router: { stack: { handle: unknown }[] } })._router.stack).map((l) => l.handle);
    const before = handles();
    catchAsyncErrors(app as never);
    expect(handles()).toEqual(before);
    expect(before.at(-1)).toBe(errorHandler);
  });
});

describe("errorHandler", () => {
  it("keeps a client error's status instead of answering 500", async () => {
    const bad = await fetch(url + "/r/echo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"token":"SECRET-abc123",',
    });
    expect(bad.status).toBe(400);
    const big = await fetch(url + "/r/echo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pad: "x".repeat(4096) }),
    });
    expect(big.status).toBe(413);
  });

  it("never logs a request body, which can carry a token", async () => {
    const logged: string[] = [];
    const orig = console.error;
    // util.format renders arguments the way console.error does, including an
    // Error's own properties such as body-parser's `body`. String() would not.
    console.error = (...args: unknown[]) => void logged.push(format(...args));
    try {
      // A 5xx whose error object carries a body, the way body-parser's do.
      const app = express();
      app.get("/x", async () => {
        throw Object.assign(new Error("wrapped"), { body: '{"token":"SECRET-abc123"}', status: 500 });
      });
      catchAsyncErrors(app as never);
      app.use(errorHandler);
      const { url: u, server: s } = await serve(app);
      expect((await fetch(u + "/x")).status).toBe(500);
      s.close();
      await fetch(url + "/r/echo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: '{"token":"SECRET-abc123",',
      });
    } finally {
      console.error = orig;
    }
    expect(logged.join("\n")).not.toContain("SECRET");
    expect(logged.length).toBe(1);
  });
});

describe("errorHandler and typed request errors", () => {
  it("answers an AppError with its own status and body", async () => {
    const { errorHandler: handler } = await import("./async-errors.js");
    const { Conflict, Upstream } = await import("./errors.js");
    for (const [err, status, body] of [
      [new Conflict("taken", { readiness: "blocked" }), 409, { error: "taken", readiness: "blocked" }],
      [new Upstream("tfc said 500"), 502, { error: "tfc said 500" }],
    ] as const) {
      const out = { status: 0, body: undefined as unknown };
      const res = {
        headersSent: false,
        status(c: number) {
          out.status = c;
          return this;
        },
        json(b: unknown) {
          out.body = b;
          return this;
        },
      };
      handler(err, { method: "GET", path: "/x" } as never, res as never, (() => {}) as never);
      expect([out.status, out.body]).toEqual([status, body]);
    }
  });
});
