import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TfCloudWorkspaceAdapter } from "./workspace.js";

// The adapter jobs create workspaces through. TFC is a fetch stub answering
// with the documented sample in __fixtures__/tfc (not measured live).

const created = readFileSync(new URL("./__fixtures__/tfc/workspace-vcs.json", import.meta.url), "utf8");
const unlinked = JSON.stringify({
  data: { ...JSON.parse(created).data, attributes: { ...JSON.parse(created).data.attributes, "vcs-repo": null } },
});

/** Answers each POST with the next of `posts`; GET by name is a 404. */
function tfc(posts: [number, string][]) {
  const sent: any[] = [];
  vi.stubGlobal("fetch", async (_url: string, init: { method: string; body?: string }) => {
    const [status, body] = init.method === "POST" ? posts[sent.push(JSON.parse(init.body!)) - 1] : [404, "{}"];
    return { ok: status < 300, status, json: async () => JSON.parse(body), text: async () => body };
  });
  return sent;
}

afterEach(() => vi.unstubAllGlobals());

const opts = { workspaceName: "app-foundry-demo", repo: "acme/app", branch: "main", workingDirectory: "deploy/infra", autoApply: false };

describe("TfCloudWorkspaceAdapter.createWorkspace", () => {
  it("links through the connection's VCS token and asks TFC to queue the first run", async () => {
    const sent = tfc([[201, JSON.stringify({ data: { ...JSON.parse(created).data, attributes: { ...JSON.parse(created).data.attributes, "queue-all-runs": true } } })]]);
    const ws = await new TfCloudWorkspaceAdapter("t", "acme", undefined, "ot-hmAyP66qk2AMVdbJ").createWorkspace({ ...opts, queueAllRuns: true });
    expect(sent[0].data.attributes).toMatchObject({
      "vcs-repo": { identifier: "acme/app", "oauth-token-id": "ot-hmAyP66qk2AMVdbJ", branch: "main" },
      "queue-all-runs": true,
    });
    expect(ws).toMatchObject({ vcsRepo: "acme/app", queueAllRuns: true, linkError: null, created: true, tfcWorkspaceId: "ws-noZcaGXsac6aZSJR" });
  });

  it("reports a workspace that already exists as reused, and sends nothing to change it", async () => {
    const methods: string[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: { method: string }) => {
      methods.push(init.method);
      return { ok: true, status: 200, json: async () => JSON.parse(created), text: async () => created };
    });
    const ws = await new TfCloudWorkspaceAdapter("t", "acme", undefined, "ot-hmAyP66qk2AMVdbJ").createWorkspace({ ...opts, queueAllRuns: true });
    expect(methods).toEqual(["GET"]);
    expect(ws).toMatchObject({ created: false, tfcWorkspaceId: "ws-noZcaGXsac6aZSJR", vcsRepo: "acme/app", workingDirectory: "deploy/infra" });
  });

  it("without a VCS token sends neither vcs-repo nor queue-all-runs", async () => {
    const sent = tfc([[201, unlinked]]);
    const ws = await new TfCloudWorkspaceAdapter("t", "acme").createWorkspace({ ...opts, queueAllRuns: true });
    expect(sent[0].data.attributes).not.toHaveProperty("vcs-repo");
    expect(sent[0].data.attributes).not.toHaveProperty("queue-all-runs");
    expect(ws).toMatchObject({ vcsRepo: null, linkError: null });
  });

  it("falls back to an unlinked workspace when TFC refuses the link, and says so", async () => {
    const sent = tfc([
      // Only the status is read; the body is not a documented sample.
      [422, '{"errors":[]}'],
      [201, unlinked],
    ]);
    const ws = await new TfCloudWorkspaceAdapter("t", "acme", undefined, "ot-hmAyP66qk2AMVdbJ").createWorkspace({ ...opts, queueAllRuns: true });
    expect(sent).toHaveLength(2);
    expect(sent[1].data.attributes).not.toHaveProperty("vcs-repo");
    expect(sent[1].data.attributes).not.toHaveProperty("queue-all-runs");
    expect(ws.vcsRepo).toBeNull();
    expect(ws.linkError).toMatch(/could not link acme\/app/);
  });
});
