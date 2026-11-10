import { describe, expect, it } from "vitest";
import {
  BY_NEWEST,
  BY_STATUS,
  PREFER_USABLE_CONNECTION,
} from "./connection-order.js";

// Applies the orderBy the way Postgres does for these columns, so the test
// fails if the statuses or the directions change.
function order(rows: { id: string; status: string; createdAt: number }[]) {
  expect(PREFER_USABLE_CONNECTION).toEqual([BY_STATUS, BY_NEWEST]);
  const byStatus = BY_STATUS;
  const byCreated = BY_NEWEST;
  const dir = (d: "asc" | "desc") => (d === "asc" ? 1 : -1);
  return [...rows]
    .sort(
      (a, b) =>
        (a.status < b.status ? -1 : a.status > b.status ? 1 : 0) *
          dir(byStatus.status) ||
        (a.createdAt - b.createdAt) * dir(byCreated.createdAt),
    )
    .map((r) => r.id);
}

describe("PREFER_USABLE_CONNECTION", () => {
  it("puts a valid connection ahead of a newer invalid or unchecked one", () => {
    expect(
      order([
        { id: "invalid-newest", status: "invalid", createdAt: 3 },
        { id: "unverified", status: "unverified", createdAt: 2 },
        { id: "valid-old", status: "valid", createdAt: 1 },
        { id: "valid-new", status: "valid", createdAt: 2 },
      ]),
    ).toEqual(["valid-new", "valid-old", "unverified", "invalid-newest"]);
  });
});
