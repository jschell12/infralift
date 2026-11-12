import { describe, expect, it } from "vitest";
import { intQuery } from "./query.js";
import { InvalidInput } from "./errors.js";

const DAYS = { name: "days", fallback: 7, min: 1, max: 3650 };

describe("intQuery", () => {
  it.each([
    [undefined, 7],
    ["", 7],
    ["30", 30],
    ["1", 1],
    ["3650", 3650],
  ])("%j gives %i", (raw, expected) => {
    expect(intQuery(raw, DAYS)).toBe(expected);
  });

  // Both edges and the shapes Number() would have let through as NaN or a
  // fraction, which became an Invalid Date and a 500.
  it.each(["abc", "0", "3651", "-5", "1.5", "1e3", " ", "NaN", ["1", "2"]])("refuses %j with a 400", (raw) => {
    expect(() => intQuery(raw, DAYS)).toThrow(InvalidInput);
    expect(() => intQuery(raw, DAYS)).toThrow("days must be a whole number from 1 to 3650");
  });
});
