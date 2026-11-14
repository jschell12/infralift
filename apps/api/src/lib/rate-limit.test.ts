import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { TooManyRequests } from "./errors.js";
import { catchAsyncErrors, errorHandler } from "./async-errors.js";
import {
  RATE_LIMITS,
  RateLimiter,
  createMemoryRateLimitStore,
  rateLimit,
  retryAfterSeconds,
  type RateLimitPolicy,
  type RateLimitStore,
} from "./rate-limit.js";

const MINUTE = 60_000;
const T0 = Date.parse("2026-11-14T12:00:00Z");

const policy: RateLimitPolicy = {
  name: "test",
  perOrg: { max: 3, windowMs: 10 * MINUTE },
  perIp: { max: 5, windowMs: 10 * MINUTE },
  message: "Too many tests. Wait a few minutes.",
};

describe("the in-memory store, a sliding window", () => {
  let store: RateLimitStore;
  beforeEach(() => {
    store = createMemoryRateLimitStore();
  });
  const rule = { max: 2, windowMs: 10 * MINUTE };

  it("allows max calls in the window and refuses the next, saying when the oldest leaves it", async () => {
    expect(await store.consume("k", rule, T0)).toEqual({ allowed: true, retryAfterMs: 0 });
    expect(await store.consume("k", rule, T0 + MINUTE)).toEqual({ allowed: true, retryAfterMs: 0 });
    expect(await store.consume("k", rule, T0 + 2 * MINUTE)).toEqual({ allowed: false, retryAfterMs: 8 * MINUTE });
  });

  it("does not count a refused call, so waiting out the window is enough", async () => {
    await store.consume("k", rule, T0);
    await store.consume("k", rule, T0);
    for (let i = 0; i < 5; i++) await store.consume("k", rule, T0 + MINUTE);
    expect((await store.consume("k", rule, T0 + 10 * MINUTE)).allowed).toBe(true);
  });

  it("sweeps each key by its own window, so a short policy cannot cut a long one's count", async () => {
    const hour = { max: 1, windowMs: 60 * MINUTE };
    const short = { max: 100, windowMs: 10 * MINUTE };
    await store.consume("lead:ip:a", hour, T0);
    // Past the sweep threshold, then a sweep triggered by the short policy 11 minutes on.
    for (let i = 0; i < 5001; i++) await store.consume(`lead:ip:${i}`, hour, T0);
    await store.consume("inventory:org:x", short, T0 + 11 * MINUTE);
    expect((await store.consume("lead:ip:a", hour, T0 + 11 * MINUTE)).allowed).toBe(false);
  });

  it("keeps keys apart, and forgets everything on reset", async () => {
    await store.consume("a", rule, T0);
    await store.consume("a", rule, T0);
    expect((await store.consume("b", rule, T0)).allowed).toBe(true);
    await store.reset();
    expect((await store.consume("a", rule, T0)).allowed).toBe(true);
  });
});

describe("RateLimiter", () => {
  it("limits per org, and another org has its own allowance", async () => {
    const limiter = new RateLimiter(policy, createMemoryRateLimitStore());
    for (let i = 0; i < 3; i++) await limiter.check({ orgId: "org-a", ip: `198.51.100.${i}` }, T0);
    await expect(limiter.check({ orgId: "org-a", ip: "198.51.100.9" }, T0)).rejects.toBeInstanceOf(TooManyRequests);
    await expect(limiter.check({ orgId: "org-b", ip: "198.51.100.9" }, T0)).resolves.toBeUndefined();
  });

  it("limits per IP across orgs, so one client cannot spend several orgs' allowances", async () => {
    const limiter = new RateLimiter(policy, createMemoryRateLimitStore());
    for (let i = 0; i < 5; i++) await limiter.check({ orgId: `org-${i}`, ip: "203.0.113.7" }, T0);
    await expect(limiter.check({ orgId: "org-new", ip: "203.0.113.7" }, T0)).rejects.toMatchObject({ status: 429 });
  });

  it("never lets two policies share a count, even in one store", async () => {
    const store = createMemoryRateLimitStore();
    const one = new RateLimiter(policy, store);
    const two = new RateLimiter({ ...policy, name: "other" }, store);
    for (let i = 0; i < 3; i++) await one.check({ orgId: "org-a" }, T0);
    await expect(two.check({ orgId: "org-a" }, T0)).resolves.toBeUndefined();
  });

  it("refuses with the policy's sentence, a 429 and Retry-After in whole seconds", async () => {
    const limiter = new RateLimiter(policy, createMemoryRateLimitStore());
    for (let i = 0; i < 3; i++) await limiter.check({ orgId: "org-a" }, T0);
    const err = (await limiter.check({ orgId: "org-a" }, T0 + 1500).catch((e) => e)) as TooManyRequests;
    expect(err.status).toBe(429);
    expect(err.message).toBe(policy.message);
    // 10 minutes minus 1.5s, rounded up.
    expect(err.retryAfterSeconds).toBe(599);
    expect(err.headers()).toEqual({ "Retry-After": "599" });
    expect(err.body()).toEqual({ error: policy.message, retryAfterSeconds: 599 });
  });

  it("uses whatever store it is given (the Strategy a shared store plugs into)", async () => {
    const calls: string[] = [];
    const refuseAll: RateLimitStore = {
      async consume(key) {
        calls.push(key);
        return { allowed: false, retryAfterMs: 30_000 };
      },
      async reset() {},
    };
    const err = await new RateLimiter(policy, refuseAll).check({ orgId: "org-a", ip: "192.0.2.1" }).catch((e) => e);
    expect(err).toMatchObject({ status: 429, retryAfterSeconds: 30 });
    // IP first: refused there, the org's count is not touched.
    expect(calls).toEqual(["test:ip:192.0.2.1"]);
  });
});

describe("retryAfterSeconds", () => {
  it.each([
    [1, 1],
    [999, 1],
    [1000, 1],
    [1001, 2],
    [0, 1],
  ])("%ims is %is, never 0", (ms, s) => {
    expect(retryAfterSeconds(ms)).toBe(s);
  });
});

describe("every policy", () => {
  it.each(Object.entries(RATE_LIMITS))("%s has a rule, a unique name and a sentence", (_key, p) => {
    const rules = [("perOrg" in p ? p.perOrg : undefined), ("perIp" in p ? p.perIp : undefined)].filter(Boolean);
    expect(rules.length).toBeGreaterThan(0);
    expect(p.message).toMatch(/\.$/);
    expect(Object.values(RATE_LIMITS).filter((q) => q.name === p.name)).toHaveLength(1);
  });
});

describe("rateLimit() as route middleware, on real Express", () => {
  let url: string;
  let server: Server;
  let handled = 0;

  beforeAll(async () => {
    const app = express();
    // Stands in for cfAuth: the org comes from the authenticated user.
    app.use((req, _res, next) => {
      req.user = { userId: "u1", orgId: String(req.headers["x-test-org"]), email: "a@example.com", name: null };
      next();
    });
    app.post("/expensive", rateLimit(policy, createMemoryRateLimitStore()), (_req, res) => {
      handled++;
      res.json({ ok: true });
    });
    catchAsyncErrors(app as never);
    app.use(errorHandler);
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server?.close());

  const post = (org: string) => fetch(url + "/expensive", { method: "POST", headers: { "x-test-org": org } });

  it("runs the handler under the limit and answers 429 with Retry-After past it, without running it", async () => {
    for (let i = 0; i < 3; i++) expect((await post("org-a")).status).toBe(200);
    const refused = await post("org-a");
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await refused.json()).toMatchObject({ error: policy.message });
    expect(handled).toBe(3);
  });
});
