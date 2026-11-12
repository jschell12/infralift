import { describe, expect, it } from "vitest";
import type { AssessmentSummary, ProviderConnectionSummary } from "@infralift/shared";
import { latestCompletedAssessment, primaryAdoptAction } from "./adopt";

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

describe("primaryAdoptAction gives the accent to one next step", () => {
  it("is nothing when no account can be assessed", () => {
    expect(primaryAdoptAction([], [])).toBeNull();
    expect(primaryAdoptAction([conn("c1", "invalid"), conn("c2", "unverified")], [])).toBeNull();
  });

  it("is Assess on the first valid account when nothing has been assessed", () => {
    expect(primaryAdoptAction([conn("bad", "invalid"), conn("c1"), conn("c2")], [])).toEqual({
      connectionId: "c1",
      action: "assess",
    });
  });

  it("is Adopt on the account assessed most recently", () => {
    const list = [done("a1", "c1", "2026-11-01T00:00:00Z"), done("a2", "c2", "2026-11-09T00:00:00Z")];
    expect(primaryAdoptAction([conn("c1"), conn("c2")], list)).toEqual({ connectionId: "c2", action: "adopt" });
  });

  it("skips an assessment whose connection is no longer valid", () => {
    const list = [done("a1", "c1", "2026-11-01T00:00:00Z"), done("a2", "c2", "2026-11-09T00:00:00Z")];
    expect(primaryAdoptAction([conn("c1"), conn("c2", "invalid")], list)).toEqual({ connectionId: "c1", action: "adopt" });
  });

  it("prefers the account a link pointed at (?assess=), with that account's own next step", () => {
    const list = [done("a2", "c2", "2026-11-09T00:00:00Z")];
    expect(primaryAdoptAction([conn("c1"), conn("c2")], list, "c1")).toEqual({ connectionId: "c1", action: "assess" });
    expect(primaryAdoptAction([conn("c1"), conn("c2")], list, "c2")).toEqual({ connectionId: "c2", action: "adopt" });
  });

  it("ignores a link to an account that cannot be assessed", () => {
    expect(primaryAdoptAction([conn("c1"), conn("c2", "invalid")], [], "c2")).toEqual({ connectionId: "c1", action: "assess" });
    expect(primaryAdoptAction([conn("c1")], [], "gone")).toEqual({ connectionId: "c1", action: "assess" });
  });
});
