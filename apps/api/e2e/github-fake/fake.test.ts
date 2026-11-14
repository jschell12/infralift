import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { gitHostClient, type GitHostClient } from "../../src/lib/git/hosts.js";
import { deliverChangeRequest } from "../../src/lib/git/deliver.js";
import { DEFAULT_ENDPOINTS } from "../../src/lib/endpoints.js";
import { CHECK_JOB_NAME } from "../../src/lib/import/contract.js";
import { FAKE_LOGIN, startGithubFake, type RunningFake } from "./server.js";

// The GitHub fake driven by infralift's own GitHub client, with no Docker:
// runs in the ordinary test suite, so a change to either side that breaks
// the other (or GitHub's documented shapes) fails here first.

let running: RunningFake;
let client: GitHostClient;
const repo = `${FAKE_LOGIN}/infra`;

beforeAll(async () => {
  running = await startGithubFake();
  client = gitHostClient("github", "fake-token", { ...DEFAULT_ENDPOINTS, githubApi: running.url });
  await client.ensureRepo({ repo });
});
afterAll(() => running.close());

describe("GitHub fake", () => {
  it("creates a repository with a default branch", async () => {
    expect(await client.repoExists(repo)).toBe(true);
    expect(await client.repoExists(`${FAKE_LOGIN}/missing`)).toBe(false);
    expect(await client.defaultBranch(repo)).toBe("main");
    expect((await client.listFiles({ repo, ref: "main" })).paths).toEqual(["README.md"]);
  });

  it("delivers files as a pull request, and a second identical delivery is a no-op", async () => {
    const request = {
      repo,
      base: "main",
      isMine: (b: string) => b.startsWith("infralift/"),
      newBranch: "infralift/adopt-test",
      files: async () => [
        { fileName: "imports.tf", content: 'import {\n  to = aws_s3_bucket.a\n  id = "a"\n}\n' },
        { fileName: "deploy.sh", content: "#!/bin/sh\n", mode: "100755" as const },
      ],
      workDir: "infra/aws",
      message: "infralift: adopt",
      title: "Adopt",
      body: () => "body",
    };
    const first = await deliverChangeRequest(client, request);
    expect(first.outcome).toBe("opened");
    if (first.outcome !== "opened") return;
    expect(first.url).toMatch(/\/pull\/1$/);
    expect(await client.readFile({ repo, path: "infra/aws/imports.tf", ref: first.branch })).toContain("aws_s3_bucket.a");
    expect(await client.fileExists({ repo, path: "infra/aws/imports.tf", branch: "main" })).toBe(false);
    const tree = await client.listTree({ repo, ref: first.branch });
    expect(tree.entries.find((e) => e.path === "infra/aws/deploy.sh")?.mode).toBe("100755");

    const again = await deliverChangeRequest(client, request);
    expect(again.outcome).toBe("unchanged");

    const pr = await client.getChangeRequest({ repo, number: 1 });
    expect(pr?.state).toBe("open");
    const commit = await client.getCommit({ repo, sha: pr!.headSha });
    expect(commit?.subject).toBe("infralift: adopt");
    expect(commit?.files.sort()).toEqual(["infra/aws/deploy.sh", "infra/aws/imports.tf"]);
  });

  it("reads back a check run posted for the head, with its annotations", async () => {
    const pr = (await client.getChangeRequest({ repo, number: 1 }))!;
    const res = await fetch(`${running.url}/repos/${repo}/check-runs`, {
      method: "POST",
      headers: { Authorization: "Bearer fake-token", "Content-Type": "application/json" },
      body: JSON.stringify({
        name: CHECK_JOB_NAME,
        head_sha: pr.headSha,
        status: "completed",
        conclusion: "success",
        output: {
          title: "ok",
          summary: "ok",
          annotations: [{ path: ".github", start_line: 1, end_line: 1, annotation_level: "notice", message: "No changes: all 1 resources match the code." }],
        },
      }),
    });
    expect(res.status).toBe(201);
    const run = await client.getCheckRun({ repo, sha: pr.headSha, name: CHECK_JOB_NAME });
    expect(run).toMatchObject({ status: "completed", conclusion: "success" });
    expect(run?.annotations).toEqual([{ level: "notice", message: "No changes: all 1 resources match the code." }]);
  });

  it("refuses a request GitHub's description would refuse, and records it", async () => {
    const res = await fetch(`${running.url}/repos/${repo}/pulls`, {
      method: "POST",
      headers: { Authorization: "Bearer fake-token", "Content-Type": "application/json" },
      body: JSON.stringify({ head: 42, base: "main" }),
    });
    expect(res.status).toBe(422);
    expect(running.fake.violations.splice(0)).toMatchObject([{ operation: "POST /repos/{owner}/{repo}/pulls", direction: "request" }]);
  });

  it("answered every call in GitHub's documented shapes", () => {
    expect(running.fake.violations).toEqual([]);
  });
});
