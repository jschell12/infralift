import { describe, expect, it } from "vitest";
import { OUTCOME, READ } from "./contract.js";
import { classifyCheck } from "./result.js";
import { renderImportCheck } from "./check.js";
import { scanRepo } from "./scan.js";

// What the workflow writes must be exactly what the reader recognizes. These
// tests break if either side changes alone.

const pr = { url: "u", headSha: "s", state: "open" as const };
const run = (conclusion: string, level: string, message: string) => ({
  status: "completed",
  conclusion,
  url: "r",
  completedAt: null,
  title: null,
  annotations: [{ level, message }],
});

describe("import check contract", () => {
  it("each outcome the workflow writes is classified as that outcome", () => {
    expect(classifyCheck(pr, run("success", "notice", OUTCOME.passed("12"))).state).toBe("passed");
    expect(classifyCheck(pr, run("failure", "failure", OUTCOME.changes("3", "12"))).state).toBe("changes");
    expect(classifyCheck(pr, run("failure", "failure", `${OUTCOME.missingPrefix} Add these: X.`)).state).toBe("needs-setup");
    expect(classifyCheck(pr, run("failure", "failure", OUTCOME.planFailed)).state).toBe("error");
  });

  it("the readers match nothing they were not written for", () => {
    expect(READ.changes(OUTCOME.passed("1"))).toBe(false);
    expect(READ.passed(OUTCOME.changes("1", "2"))).toBe(false);
    expect(READ.planFailed("The plan failed")).toBe(false);
  });

  it("the generated workflow writes the outcomes from this module, not its own copies", () => {
    const root = scanRepo([
      { path: "main.tf", content: 'terraform {\n  backend "s3" {\n    bucket = "b"\n    key = "k"\n  }\n}\nresource "hcloud_server" "s" {}\n' },
    ]).roots[0];
    const { content } = renderImportCheck(root);
    expect(content).toContain(`msg="${OUTCOME.passed("$total")}"`);
    expect(content).toContain(`msg="${OUTCOME.changes("$changes", "$total")}"`);
    expect(content).toContain(`msg="${OUTCOME.planFailed}"`);
    expect(content).toContain(`::error::${OUTCOME.missingPrefix} `);
  });
});
