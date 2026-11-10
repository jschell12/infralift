import { describe, expect, it } from "vitest";
import { verifiedMonth } from "./prices";

describe("verifiedMonth", () => {
  it("names the month the API's date falls in", () => {
    expect(verifiedMonth("2026-08-01")).toBe("August 2026");
    expect(verifiedMonth("2026-12-31")).toBe("December 2026");
  });

  it("does not slip to the previous month on the first", () => {
    // Parsed as local midnight, 2026-08-01 is July 31 anywhere west of UTC.
    // CI runs in UTC, where that bug cannot show, so pin a western zone.
    const tz = process.env.TZ;
    process.env.TZ = "America/Los_Angeles";
    try {
      expect(new Date(2026, 7, 1).getTimezoneOffset()).toBeGreaterThan(0);
      expect(verifiedMonth("2026-08-01")).toBe("August 2026");
    } finally {
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
    }
  });

  it("says nothing rather than something wrong for a missing or bad date", () => {
    expect(verifiedMonth(undefined)).toBeNull();
    expect(verifiedMonth("")).toBeNull();
    expect(verifiedMonth("August 2026")).toBeNull();
    expect(verifiedMonth("2026-13-45")).toBeNull();
  });
});
