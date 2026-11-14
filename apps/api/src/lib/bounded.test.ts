import { describe, expect, it } from "vitest";
import { settleBounded } from "./bounded.js";

describe("settleBounded", () => {
  it("never has more than `limit` calls in flight, and runs every item", async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await settleBounded([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return n * 10;
    });
    expect(peak).toBe(3);
    expect(out).toEqual([10, 20, 30, 40, 50, 60, 70].map((value) => ({ ok: true, value })));
  });

  it("keeps the input order and reports a failing item without stopping the rest", async () => {
    const boom = new Error("site 2 refused");
    const out = await settleBounded(["a", "b", "c"], 2, async (s) => {
      if (s === "b") throw boom;
      return s.toUpperCase();
    });
    expect(out).toEqual([{ ok: true, value: "A" }, { ok: false, error: boom }, { ok: true, value: "C" }]);
  });

  it("returns an empty list for no items, and refuses a limit that would run nothing", async () => {
    expect(await settleBounded([], 4, async () => 1)).toEqual([]);
    for (const bad of [0, -1, 1.5]) await expect(settleBounded([1], bad, async () => 1)).rejects.toThrow(/limit/);
  });
});
