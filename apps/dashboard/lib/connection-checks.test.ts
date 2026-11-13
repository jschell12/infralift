import { describe, expect, it } from "vitest";
import type { ProviderConnectionSummary } from "@infralift/shared";
import { checkingCount, checkingText, shouldRequestChecks } from "./connection-checks";

// Rows as GET /connections sends them (toSummary in
// apps/api/src/services/connections.ts).
const NOW = Date.parse("2026-11-13T12:00:00Z");
const row = (over: Partial<ProviderConnectionSummary>): ProviderConnectionSummary => ({
  id: "c1",
  provider: "firebase",
  label: "testenv",
  createdAt: "2026-11-01T00:00:00.000Z",
  lastVerifiedAt: "2026-11-13T09:00:00.000Z",
  lastCheckedAt: "2026-11-13T09:00:00.000Z",
  checking: false,
  status: "valid",
  lastError: null,
  expiresAt: null,
  ...over,
});

describe("shouldRequestChecks", () => {
  it("asks when any connection was never checked, such as the testenv rows that said \"connected\"", () => {
    const list = [row({}), row({ id: "c2", status: "unverified", lastVerifiedAt: null, lastCheckedAt: null })];
    expect(shouldRequestChecks(list, NOW)).toBe(true);
  });

  it("asks when a check is over a day old", () => {
    expect(shouldRequestChecks([row({ lastCheckedAt: "2026-11-12T11:00:00.000Z" })], NOW)).toBe(true);
  });

  it("does not ask when every connection was checked today, or the stale one is already being checked", () => {
    expect(shouldRequestChecks([row({})], NOW)).toBe(false);
    expect(shouldRequestChecks([row({ lastCheckedAt: null, checking: true })], NOW)).toBe(false);
    expect(shouldRequestChecks([], NOW)).toBe(false);
  });
});

describe("the page's one status line", () => {
  it("counts the connections being checked", () => {
    expect(checkingCount([row({ checking: true }), row({ id: "c2" }), row({ id: "c3", checking: true })])).toBe(2);
  });

  it("says nothing when nothing is being checked", () => {
    expect(checkingText(0)).toBe("");
    expect(checkingText(1)).toBe("Checking 1 connection...");
    expect(checkingText(3)).toBe("Checking 3 connections...");
  });
});
