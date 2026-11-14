import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { catchAsyncErrors, errorHandler } from "./async-errors.js";
import { captureLogs, log } from "./log.js";
import { requireJsonBody } from "./json-body.js";
import {
  REQUEST_ID_SHAPE,
  bindUserToRequestContext,
  chooseRequestId,
  requestContext,
  restoreRequestContext,
} from "./request-context.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SECRET = "tfc-opaque-credential-7f3a9c";

/** The middleware in app.ts's order, around a few routes. */
function build(trustProxyRequestId: boolean) {
  const app = express();
  app.use(requestContext({ trustProxyRequestId }));
  app.use(requireJsonBody);
  app.use(express.json({ limit: "1mb" }));
  app.use(restoreRequestContext);
  app.get("/health", (_req, res) => res.json({ ok: true }));
  // Stands in for cfAuth.
  app.use((req, _res, next) => {
    req.user = { userId: "user-1", orgId: "org-a", email: "a@example.com", name: null };
    next();
  });
  app.use(bindUserToRequestContext);
  const router = express.Router();
  router.post("/:id/verify", (req, res) => {
    // Written after the body parser ran: must still carry the request's ids.
    log.info({ connectionId: req.params.id }, "verifying");
    res.json({ ok: true });
  });
  router.post("/:id/fail", async () => {
    throw new Error("provider exploded");
  });
  app.use("/connections", router);
  catchAsyncErrors(app as never);
  app.use(errorHandler);
  return app;
}

async function serve(app: express.Express): Promise<{ url: string; server: Server }> {
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server }));
  });
}

let untrusted: { url: string; server: Server };
let trusted: { url: string; server: Server };
let logs: ReturnType<typeof captureLogs> | undefined;

beforeAll(async () => {
  untrusted = await serve(build(false));
  trusted = await serve(build(true));
});
afterAll(() => {
  untrusted.server.close();
  trusted.server.close();
});
afterEach(() => logs?.restore());

const postJson = (base: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

describe("the request id", () => {
  it("is generated and echoed when the caller sends none", async () => {
    const res = await fetch(untrusted.url + "/health");
    expect(res.headers.get("x-request-id")).toMatch(UUID);
  });

  it("ignores a caller's X-Request-Id unless the proxy is trusted", async () => {
    const res = await fetch(untrusted.url + "/health", { headers: { "X-Request-Id": "chosen-by-client-1" } });
    expect(res.headers.get("x-request-id")).toMatch(UUID);
  });

  it("uses a trusted proxy's id when it is well formed, and replaces one that is not", async () => {
    const ok = await fetch(trusted.url + "/health", { headers: { "X-Request-Id": "edge-abc12345" } });
    expect(ok.headers.get("x-request-id")).toBe("edge-abc12345");
    const bad = await fetch(trusted.url + "/health", { headers: { "X-Request-Id": 'x"}{"level":"fatal"' } });
    expect(bad.headers.get("x-request-id")).toMatch(UUID);
  });

  it.each([
    ["edge-abc12345", true],
    ["0f9a9a7c-1111-2222-3333-444455556666", true],
    ["short", false],
    ["has space in it", false],
    ["x".repeat(129), false],
  ])("shape check: %s is %s", (id, ok) => {
    expect(REQUEST_ID_SHAPE.test(id)).toBe(ok);
    expect(chooseRequestId(id, true) === id).toBe(ok);
  });
});

describe("log lines and the access line", () => {
  it("stamp the request id, org and user on lines written after the body was parsed", async () => {
    logs = captureLogs();
    const res = await postJson(untrusted.url, "/connections/c1/verify", { label: "x" });
    const id = res.headers.get("x-request-id");
    await new Promise((r) => setTimeout(r, 10)); // the access line is written on 'finish'
    const verifying = logs.lines.find((l) => l.msg === "verifying");
    expect(verifying).toMatchObject({ requestId: id, orgId: "org-a", userId: "user-1", connectionId: "c1" });
    const access = logs.lines.find((l) => l.msg === "request");
    expect(access).toMatchObject({
      requestId: id,
      orgId: "org-a",
      userId: "user-1",
      method: "POST",
      route: "/connections/:id/verify",
      status: 200,
    });
    expect(typeof access?.latencyMs).toBe("number");
  });

  it("logs probes at debug, and an unmatched path without its raw URL", async () => {
    logs = captureLogs();
    await fetch(untrusted.url + "/health");
    await fetch(untrusted.url + "/nothing/here?cursor=abc");
    await new Promise((r) => setTimeout(r, 10));
    const access = logs.lines.filter((l) => l.msg === "request");
    expect(access[0]).toMatchObject({ level: "debug", route: "/health" });
    expect(access[1]).toMatchObject({ level: "info", route: "(unmatched)", status: 404 });
    expect(logs.raw.join("\n")).not.toContain("cursor=abc");
  });

  it("answers a 500 with the request id, logs it under that id, and never logs the body's secret", async () => {
    logs = captureLogs();
    const res = await postJson(untrusted.url, "/connections/c1/fail", { token: SECRET });
    const body = (await res.json()) as { error: string; requestId: string };
    expect(res.status).toBe(500);
    expect(body).toEqual({ error: "internal error", requestId: res.headers.get("x-request-id") });
    await new Promise((r) => setTimeout(r, 10));
    const unhandled = logs.lines.find((l) => l.msg === "unhandled error");
    expect(unhandled).toMatchObject({ requestId: body.requestId, err: { message: "provider exploded" } });
    expect(logs.raw.join("\n")).not.toContain(SECRET);
  });
});

describe("request bodies", () => {
  it("answer 415 to a body that is not JSON, before any route runs", async () => {
    const res = await fetch(untrusted.url + "/connections/c1/verify", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "token=abc",
    });
    expect(res.status).toBe(415);
    expect(((await res.json()) as { error: string }).error).toMatch(/JSON/);
  });

  it("let a POST with no body through whatever its content type", async () => {
    const res = await fetch(untrusted.url + "/connections/c1/verify", { method: "POST" });
    expect(res.status).toBe(200);
  });

  it("answer 413 to a JSON body over the limit", async () => {
    const res = await postJson(untrusted.url, "/connections/c1/verify", { pad: "x".repeat(1024 * 1024 + 10) });
    expect(res.status).toBe(413);
  });
});
