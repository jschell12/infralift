import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { HttpTimeoutError, httpFetch } from "./http.js";

// Against a real local HTTP server, so the deadline is exercised through
// Node's fetch rather than a stub of it.

let server: Server | null = null;

async function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
  server = createServer(handler);
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return `127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  if (!server) return;
  server.closeAllConnections();
  await new Promise((resolve) => server!.close(resolve));
  server = null;
});

describe("httpFetch", () => {
  it("gives up at the deadline with an error naming the host and nothing else of the URL", async () => {
    const host = await listen(() => {
      /* accepts the request and never answers */
    });
    const err = await httpFetch(`http://${host}/v1/secret-path?token=abc`, {}, { timeoutMs: 50 }).catch((e) => e);
    expect(err).toBeInstanceOf(HttpTimeoutError);
    expect(err.message).toBe(`${host} did not answer within 50ms`);
    expect(err.message).not.toMatch(/secret|token/);
    expect(err.status).toBeUndefined();
  });

  it("returns the response when the host answers inside the deadline", async () => {
    const host = await listen((_req, res) => res.end(JSON.stringify({ ok: true })));
    const res = await httpFetch(`http://${host}/`, {}, { timeoutMs: 2_000 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("rethrows a refused connection as fetch threw it, not as a timeout", async () => {
    const host = await listen(() => {});
    server!.close();
    server = null;
    const err = await httpFetch(`http://${host}/`, {}, { timeoutMs: 2_000 }).catch((e) => e);
    expect(err).toBeInstanceOf(TypeError);
    expect(err).not.toBeInstanceOf(HttpTimeoutError);
  });

  it("still honours a caller's own abort, which is not a timeout", async () => {
    const host = await listen(() => {});
    const caller = new AbortController();
    const pending = httpFetch(`http://${host}/`, { signal: caller.signal }, { timeoutMs: 2_000 }).catch((e) => e);
    caller.abort();
    const err = await pending;
    expect(err).not.toBeInstanceOf(HttpTimeoutError);
    expect(err.name).toBe("AbortError");
  });
});
