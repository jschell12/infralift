import { describe, expect, it } from "vitest";
import type { AssessmentSummary, ProviderConnectionSummary } from "@infralift/shared";
import { findUnmanagedHref, latestCompletedAssessment, primaryFindAccount } from "./adopt";

// Assessment rows carry the fields GET /assessments sends
// (listAssessmentSummaries in apps/api/src/services/assessments.ts); only the
// ones these functions read are filled in. Connections are toSummary() rows.

type A = Pick<AssessmentSummary, "id" | "status" | "connectionId" | "completedAt">;
const done = (id: string, connectionId: string | null, completedAt: string): A => ({
  id,
  status: "completed",
  connectionId,
  completedAt,
});
const conn = (id: string, status: ProviderConnectionSummary["status"] = "valid") => ({ id, status });

describe("latestCompletedAssessment", () => {
  it("picks the newest completed run of that connection, whatever the list order", () => {
    const list = [done("old", "c1", "2026-11-01T00:00:00Z"), done("new", "c1", "2026-11-10T00:00:00Z")];
    expect(latestCompletedAssessment(list, "c1")?.id).toBe("new");
    expect(latestCompletedAssessment([...list].reverse(), "c1")?.id).toBe("new");
  });

  it("ignores other connections, uploaded snapshots and runs that did not complete", () => {
    const list: A[] = [
      done("other", "c2", "2026-11-10T00:00:00Z"),
      done("snapshot", null, "2026-11-10T00:00:00Z"),
      { id: "failed", status: "failed", connectionId: "c1", completedAt: "2026-11-10T00:00:00Z" },
      { id: "running", status: "running", connectionId: "c1", completedAt: null },
    ];
    expect(latestCompletedAssessment(list, "c1")).toBeNull();
  });
});

describe("primaryFindAccount gives the accent to one account", () => {
  it("is nothing when no account's connection is valid", () => {
    expect(primaryFindAccount([])).toBeNull();
    expect(primaryFindAccount([conn("c1", "invalid"), conn("c2", "unverified")])).toBeNull();
  });

  it("is the first valid account by default", () => {
    expect(primaryFindAccount([conn("bad", "invalid"), conn("c1"), conn("c2")])).toBe("c1");
  });

  it("prefers the account a link pointed at (?assess=)", () => {
    expect(primaryFindAccount([conn("c1"), conn("c2")], "c2")).toBe("c2");
  });

  it("ignores a link to an account that cannot be read", () => {
    expect(primaryFindAccount([conn("c1"), conn("c2", "invalid")], "c2")).toBe("c1");
    expect(primaryFindAccount([conn("c1")], "gone")).toBe("c1");
  });
});

describe("findUnmanagedHref", () => {
  it("is the account's own page, with the id escaped", () => {
    expect(findUnmanagedHref("c1")).toBe("/projects/new/adopt?connection=c1");
    expect(findUnmanagedHref("a b&c")).toBe("/projects/new/adopt?connection=a%20b%26c");
  });
});
