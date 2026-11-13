import { beforeEach, describe, expect, it, vi } from "vitest";

// The automatic checks' scheduling: which connections a sweep picks, how many
// provider calls run at once, and what an on-demand request claims. The check
// itself (claim, verify, record) is services/connections.ts and is tested in
// connections.test.ts; here it is stubbed so the assertions are about order
// and concurrency.

const h = vi.hoisted(() => ({
  findMany: vi.fn(),
  runCheck: vi.fn(),
  claimCheck: vi.fn(),
  runClaimedCheck: vi.fn(),
}));

vi.mock("../lib/db.js", () => ({ prisma: { providerConnection: { findMany: h.findMany } } }));
vi.mock("./connections.js", () => ({
  CHECK_CLAIM_MS: 10 * 60 * 1000,
  runCheck: h.runCheck,
  claimCheck: h.claimCheck,
  runClaimedCheck: h.runClaimedCheck,
}));

const checks = await import("./connection-checks.js");
const { AppError } = await import("../lib/errors.js");

const NOW = new Date("2026-11-13T12:00:00Z");
const row = (id: string, orgId = "org-a") => ({ id, orgId, provider: "github" });

beforeEach(() => {
  vi.clearAllMocks();
  checks.resetConnectionCheckState();
});

describe("dueForCheck", () => {
  it("asks for never-checked or day-old connections without a live claim, never-checked first", async () => {
    h.findMany.mockResolvedValue([]);
    await checks.dueForCheck(NOW);
    expect(h.findMany).toHaveBeenCalledWith({
      where: {
        demo: false,
        AND: [
          { OR: [{ lastCheckedAt: null }, { lastCheckedAt: { lt: new Date("2026-11-12T12:00:00Z") } }] },
          { OR: [{ verifyingSince: null }, { verifyingSince: { lt: new Date("2026-11-13T11:50:00Z") } }] },
        ],
      },
      orderBy: { lastCheckedAt: { sort: "asc", nulls: "first" } },
      take: checks.SWEEP_BATCH,
    });
  });

  it("scopes to one org when asked", async () => {
    h.findMany.mockResolvedValue([]);
    await checks.dueForCheck(NOW, 5, "org-a");
    expect(h.findMany.mock.calls[0][0]).toMatchObject({ where: { orgId: "org-a" }, take: 5 });
  });
});

/** Applies dueForCheck's where clause to rows, as Postgres would: the demo
 *  flag, the staleness cutoff and the claim cutoff. */
function applyWhere(rows: Record<string, unknown>[], args: { where: Record<string, unknown> }) {
  const where = args.where as {
    demo?: boolean;
    AND: [{ OR: [unknown, { lastCheckedAt: { lt: Date } }] }, { OR: [unknown, { verifyingSince: { lt: Date } }] }];
  };
  const staleBefore = where.AND[0].OR[1].lastCheckedAt.lt;
  const claimBefore = where.AND[1].OR[1].verifyingSince.lt;
  return rows.filter((r) => {
    if (where.demo !== undefined && r.demo !== where.demo) return false;
    const checked = r.lastCheckedAt as Date | null;
    const claim = r.verifyingSince as Date | null;
    return (checked === null || checked < staleBefore) && (claim === null || claim < claimBefore);
  });
}

describe("demo connections", () => {
  // Production's demo rows: seeded 2026-08-31 by scripts/seed-demo.ts, token
  // "demo", verified that day, so migration 0030 copied that date into
  // lastCheckedAt and marked them demo by their label.
  const rows = [
    { id: "demo-heroku", label: "demo large-tier", demo: true, status: "valid", lastCheckedAt: new Date("2026-08-31T00:00:00Z"), verifyingSince: null },
    { id: "demo-vercel", label: "demo large-tier", demo: true, status: "valid", lastCheckedAt: null, verifyingSince: null },
    { id: "real-stale", label: "production", demo: false, status: "valid", lastCheckedAt: new Date("2026-11-01T00:00:00Z"), verifyingSince: null },
  ];

  it("are never picked by the sweep or by a page's request, so never marked invalid", async () => {
    h.findMany.mockImplementation(async (args: { where: Record<string, unknown> }) => applyWhere(rows, args));
    h.runCheck.mockImplementation(async (c: unknown) => c);
    h.claimCheck.mockResolvedValue(true);
    h.runClaimedCheck.mockResolvedValue(null);
    expect(await checks.sweepConnectionChecks(NOW)).toBe(1);
    expect(h.runCheck.mock.calls.map((c) => c[0].id)).toEqual(["real-stale"]);
    expect(await checks.checkStaleForOrg("org-a", NOW)).toEqual(["real-stale"]);
    expect(h.claimCheck.mock.calls.map((c) => c[0])).toEqual(["real-stale"]);
  });
});

describe("createSlots", () => {
  it("runs at most `size` tasks at once and every task in the end", async () => {
    const slots = checks.createSlots(3);
    let running = 0;
    let peak = 0;
    const task = async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      return 1;
    };
    const results = await Promise.all(Array.from({ length: 10 }, () => slots.run(task)));
    expect(peak).toBe(3);
    expect(results).toHaveLength(10);
    expect(slots.running).toBe(0);
  });

  it("frees the slot when a task throws", async () => {
    const slots = checks.createSlots(1);
    await expect(slots.run(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    await expect(slots.run(async () => "next")).resolves.toBe("next");
  });
});

describe("sweepConnectionChecks", () => {
  it("checks every due connection, CHECK_CONCURRENCY at a time, and counts the ones it checked", async () => {
    h.findMany.mockResolvedValue(["a", "b", "c", "d", "e", "f", "g"].map((id) => row(id)));
    let running = 0;
    let peak = 0;
    h.runCheck.mockImplementation(async (c: { id: string }) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      // "c" was claimed by another process first: skipped, not counted.
      return c.id === "c" ? null : c;
    });
    expect(await checks.sweepConnectionChecks(NOW)).toBe(6);
    expect(h.runCheck).toHaveBeenCalledTimes(7);
    // Each check claims when it gets its slot, not at the sweep's start.
    expect(h.runCheck.mock.calls.every((c) => c.length === 1)).toBe(true);
    expect(peak).toBe(checks.CHECK_CONCURRENCY);
  });

  it("logs a failed check and carries on with the rest", async () => {
    h.findMany.mockResolvedValue([row("a"), row("b")]);
    h.runCheck.mockImplementation(async (c: { id: string }) => {
      if (c.id === "a") throw new Error("AWS is not enabled on this server");
      return c;
    });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await checks.sweepConnectionChecks(NOW)).toBe(1);
    expect(err).toHaveBeenCalledWith("connection check a failed: AWS is not enabled on this server");
    err.mockRestore();
  });

  it("does nothing when every connection was checked in the last day", async () => {
    h.findMany.mockResolvedValue([]);
    expect(await checks.sweepConnectionChecks(NOW)).toBe(0);
    expect(h.runCheck).not.toHaveBeenCalled();
  });
});

describe("checkStaleForOrg", () => {
  it("claims the org's due connections before answering and returns only the ones it claimed", async () => {
    h.findMany.mockResolvedValue([row("a"), row("b"), row("c")]);
    h.claimCheck.mockImplementation(async (id: string) => id !== "b");
    h.runClaimedCheck.mockResolvedValue(null);
    expect(await checks.checkStaleForOrg("org-a", NOW)).toEqual(["a", "c"]);
    expect(h.findMany.mock.calls[0][0]).toMatchObject({ where: { orgId: "org-a" }, take: checks.ORG_BATCH });
    await vi.waitFor(() => expect(h.runClaimedCheck).toHaveBeenCalledTimes(2));
    expect(h.runClaimedCheck.mock.calls.map((c) => [c[0].id, c[1]])).toEqual([
      ["a", NOW],
      ["c", NOW],
    ]);
  });

  it("refuses with 429 past the org's limit, and the limit is per org", async () => {
    h.findMany.mockResolvedValue([]);
    for (let i = 0; i < 6; i++) await checks.checkStaleForOrg("org-a", NOW);
    const err = await checks.checkStaleForOrg("org-a", NOW).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err.status).toBe(429);
    await expect(checks.checkStaleForOrg("org-b", NOW)).resolves.toEqual([]);
  });
});

describe("startConnectionCheckSweep", () => {
  it("first sweeps between one and eleven minutes after boot, never on the boot tick", () => {
    vi.useFakeTimers();
    h.findMany.mockResolvedValue([]);
    checks.startConnectionCheckSweep(() => 0.5);
    vi.advanceTimersByTime(60_000 + 5 * 60_000 - 1);
    expect(h.findMany).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(h.findMany).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
