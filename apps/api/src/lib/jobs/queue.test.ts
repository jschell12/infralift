import { beforeEach, describe, expect, it, vi } from "vitest";

// The queue against an in-memory TfJob table that honours the conditional
// updates the real database does.

interface Row {
  id: string;
  stage: string;
  status: string;
  statusMessage: string;
  claimedAt: Date | null;
  claimedBy: string | null;
  createdAt: Date;
}

const h = vi.hoisted(() => {
  const rows: Row[] = [];
  const match = (r: Row, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) => {
      const val = (r as unknown as Record<string, unknown>)[k];
      if (v === null) return val === null;
      if (v && typeof v === "object" && !(v instanceof Date)) {
        const op = v as { not?: unknown; in?: unknown[]; lt?: Date };
        if ("not" in op) return op.not === null ? val !== null : val !== op.not;
        if (op.in) return op.in.includes(val);
        if (op.lt) return (val as Date) < op.lt;
      }
      return val === v;
    });
  const prisma = {
    tfJob: {
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Partial<Row> }) => {
        const hit = rows.filter((r) => match(r, where));
        hit.forEach((r) => Object.assign(r, data));
        return { count: hit.length };
      }),
      findMany: vi.fn(async ({ where, take }: { where: Record<string, unknown>; take?: number }) =>
        rows.filter((r) => match(r, where)).slice(0, take ?? Infinity)
      ),
    },
  };
  return { rows, prisma, runJob: vi.fn(async () => {}) };
});

vi.mock("../db.js", () => ({ prisma: h.prisma }));
vi.mock("../tf/pipeline.js", () => ({ runJob: h.runJob }));

const { claim, claimAndRun, recoverInterrupted, sweep, INTERRUPTED } = await import("./queue.js");

const row = (over: Partial<Row>): Row => ({
  id: "j1",
  stage: "queued",
  status: "pending",
  statusMessage: "",
  claimedAt: null,
  claimedBy: null,
  createdAt: new Date(Date.now() - 60_000),
  ...over,
});

beforeEach(() => {
  h.rows.length = 0;
  vi.clearAllMocks();
});

describe("job queue", () => {
  it("lets exactly one process claim a job", async () => {
    h.rows.push(row({}));
    const results = await Promise.all([claim("j1", "a"), claim("j1", "b")]);
    expect(results.sort()).toEqual([false, true]);
    expect(h.rows[0].claimedBy).toMatch(/^[ab]$/);
  });

  it("runs a job it claims, and not one already claimed", async () => {
    h.rows.push(row({ id: "j1" }), row({ id: "j2", claimedAt: new Date(), claimedBy: "other" }));
    await claimAndRun("j1");
    await claimAndRun("j2");
    expect(h.runJob).toHaveBeenCalledTimes(1);
    expect(h.runJob).toHaveBeenCalledWith("j1");
  });

  it("marks a job errored when it fails before its first step", async () => {
    h.rows.push(row({ id: "j1" }));
    h.runJob.mockRejectedValueOnce(new Error("job row vanished"));
    await expect(claimAndRun("j1")).rejects.toThrow("job row vanished");
    expect(h.rows[0]).toMatchObject({ status: "errored", statusMessage: "could not start: job row vanished" });
  });

  it("recovers jobs from before the queue existed (the migration claims them as pre-0017)", async () => {
    h.rows.push(row({ id: "old-stuck", stage: "commit", status: "running", claimedAt: new Date(), claimedBy: "pre-0017" }));
    expect(await recoverInterrupted("new-process")).toBe(1);
    expect(h.rows[0].status).toBe("errored");
    // and the sweep does not run it
    expect(await sweep(5, 0)).toEqual([]);
  });

  it("marks jobs a gone process left unfinished as interrupted, and only those", async () => {
    h.rows.push(
      row({ id: "stuck-running", stage: "commit", status: "running", claimedAt: new Date(), claimedBy: "old" }),
      row({ id: "stuck-pending", status: "pending", claimedAt: new Date(), claimedBy: "old" }),
      row({ id: "mine", stage: "render", status: "running", claimedAt: new Date(), claimedBy: "me" }),
      row({ id: "done", stage: "complete", status: "success", claimedAt: new Date(), claimedBy: "old" }),
      row({ id: "unclaimed", status: "pending" })
    );
    expect(await recoverInterrupted("me")).toBe(2);
    const by = Object.fromEntries(h.rows.map((r) => [r.id, r]));
    expect(by["stuck-running"]).toMatchObject({ stage: "commit", status: "errored", statusMessage: INTERRUPTED });
    expect(by["stuck-pending"].status).toBe("errored");
    expect(by.mine.status).toBe("running");
    expect(by.done.status).toBe("success");
    expect(by.unclaimed.status).toBe("pending");
  });

  it("sweeps pending jobs nobody claimed, leaving brand-new ones to startJob", async () => {
    h.rows.push(
      row({ id: "old" }),
      row({ id: "fresh", createdAt: new Date() }),
      row({ id: "claimed", claimedAt: new Date(), claimedBy: "x" })
    );
    expect(await sweep(5, 10_000)).toEqual(["old"]);
  });
});
