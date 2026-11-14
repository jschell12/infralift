import { describe, expect, it } from "vitest";
import { checkReadiness } from "./readiness.js";

describe("checkReadiness", () => {
  it("is ready when the database answers", async () => {
    await expect(checkReadiness(async () => [{ "?column?": 1 }])).resolves.toEqual({ ok: true, database: "ok" });
  });

  it("is not ready when the query fails", async () => {
    await expect(checkReadiness(async () => Promise.reject(new Error("ECONNREFUSED")))).resolves.toEqual({
      ok: false,
      database: "unavailable",
    });
  });

  it("is not ready when the database does not answer within the deadline, and does not wait for it", async () => {
    const started = Date.now();
    const never = () => new Promise(() => {});
    await expect(checkReadiness(never, 50)).resolves.toEqual({ ok: false, database: "unavailable" });
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
