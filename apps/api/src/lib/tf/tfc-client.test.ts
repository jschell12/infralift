import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { TfcClient } from "./tfc-client.js";

// Response shapes measured against app.terraform.io on 2026-10-08, not
// taken from the docs. The docs suggested a 404 for a configuration version
// without ingress; the API answers 200 with a JSON body of `null`.

function respond(status: number, body: string) {
  vi.stubGlobal("fetch", async () => ({
    ok: status < 300,
    status,
    json: async () => JSON.parse(body),
    text: async () => body,
  }));
}

afterEach(() => vi.unstubAllGlobals());

const client = () => new TfcClient("t", "acme");

describe("TfcClient against measured responses", () => {
  it("getIngress treats a 200 with a null body as no ingress", async () => {
    respond(200, "null");
    await expect(client().getIngress("cv-1")).resolves.toBeNull();
  });

  it("getIngress reads the commit from a VCS configuration version", async () => {
    respond(200, JSON.stringify({ data: { attributes: { "commit-sha": "abc", "clone-url": "https://x" } } }));
    await expect(client().getIngress("cv-1")).resolves.toEqual({ commitSha: "abc", cloneUrl: "https://x" });
  });

  it("listVariables nulls a sensitive value, as the API does", async () => {
    respond(
      200,
      JSON.stringify({
        data: [
          { attributes: { key: "secret_token", value: null, category: "terraform", hcl: false, sensitive: true } },
          { attributes: { key: "region", value: "us-west-2", category: "terraform", hcl: false, sensitive: false } },
        ],
      })
    );
    const vars = await client().listVariables("ws-1");
    expect(vars.map((v) => [v.key, v.value])).toEqual([
      ["secret_token", null],
      ["region", "us-west-2"],
    ]);
  });

  it.each(["listVariables", "listCurrentOutputs", "listInboundRunTriggerSources"] as const)(
    "%s survives a null body",
    async (method) => {
      respond(200, "null");
      await expect(client()[method]("ws-1")).resolves.toEqual([]);
    }
  );
});

// Documented sample responses (see __fixtures__/tfc/README.md); unlike the
// block above, these have not been measured against a live organization.
const fixture = (name: string) =>
  readFileSync(new URL(`./__fixtures__/tfc/${name}`, import.meta.url), "utf8");

/** Routes by "METHOD path" to [status, body]; records each call and body. */
function routes(table: Record<string, [number, string]>) {
  const calls: { call: string; body: any }[] = [];
  vi.stubGlobal("fetch", async (url: string, init: { method: string; body?: string }) => {
    const call = `${init.method} ${url.replace("https://app.terraform.io/api/v2", "")}`;
    calls.push({ call, body: init.body ? JSON.parse(init.body) : undefined });
    const [status, body] = table[call] ?? [404, "{}"];
    return { ok: status < 300, status, json: async () => JSON.parse(body), text: async () => body };
  });
  return calls;
}

describe("TfcClient runs and VCS links", () => {
  it("listOAuthTokens lists each OAuth client's tokens with its provider", async () => {
    const calls = routes({
      "GET /organizations/acme/oauth-clients?page%5Bsize%5D=100": [200, fixture("oauth-clients.json")],
      "GET /oauth-clients/oc-XKFwG6ggfA9n7t1K/oauth-tokens": [200, fixture("oauth-tokens.json")],
    });
    await expect(client().listOAuthTokens()).resolves.toEqual([
      { id: "ot-hmAyP66qk2AMVdbJ", serviceProvider: "github", serviceProviderDisplayName: "GitHub", user: "skierkowski" },
    ]);
    expect(calls).toHaveLength(2);
  });

  it("listOAuthTokens is empty when the org has no VCS provider", async () => {
    routes({ "GET /organizations/acme/oauth-clients?page%5Bsize%5D=100": [200, '{"data":[]}'] });
    await expect(client().listOAuthTokens()).resolves.toEqual([]);
  });

  it("createWorkspace sends vcs-repo and reads the link back", async () => {
    const calls = routes({ "POST /organizations/acme/workspaces": [201, fixture("workspace-vcs.json")] });
    const ws = await client().createWorkspace("app-foundry-demo", {
      vcs: { identifier: "acme/app", oauthTokenId: "ot-hmAyP66qk2AMVdbJ", branch: "main" },
      workingDir: "deploy/infra",
    });
    expect(calls[0].body.data.attributes["vcs-repo"]).toEqual({
      identifier: "acme/app",
      "oauth-token-id": "ot-hmAyP66qk2AMVdbJ",
      branch: "main",
    });
    expect(calls[0].body.data.attributes["working-directory"]).toBe("deploy/infra");
    expect(ws.vcsRepo).toBe("acme/app");
  });

  it("createWorkspace without vcs stays API-driven", async () => {
    const calls = routes({ "POST /organizations/acme/workspaces": [201, fixture("workspace-vcs.json")] });
    await client().createWorkspace("x", { description: "infralift: acme/app@main" });
    expect(calls[0].body.data.attributes).not.toHaveProperty("vcs-repo");
  });

  it("listRuns maps the included plan's counts only once the plan has finished", async () => {
    const calls = routes({
      "GET /workspaces/ws-1/runs?page%5Bsize%5D=20&include=plan": [200, fixture("runs-with-plan.json")],
    });
    const [ready, planning] = await client().listRuns("ws-1");
    expect(ready).toMatchObject({
      id: "run-CZcmD7eagjhyX0vN",
      status: "planned",
      source: "tfe-configuration-version",
      workspaceId: "ws-noZcaGXsac6aZSJR",
      hasChanges: true,
      isConfirmable: true,
      isDiscardable: true,
      additions: 0,
      changes: 1,
      destructions: 0,
    });
    expect(planning).toMatchObject({ planOnly: true, isConfirmable: false, hasChanges: null, additions: null });
    expect(calls).toHaveLength(1);
  });

  it("applyRun and discardRun post to the run's actions and accept a bodiless 202", async () => {
    const calls = routes({
      "POST /runs/run-1/actions/apply": [202, ""],
      "POST /runs/run-1/actions/discard": [202, ""],
    });
    await client().applyRun("run-1", "ok");
    await client().discardRun("run-1", "no");
    expect(calls.map((c) => [c.call, c.body])).toEqual([
      ["POST /runs/run-1/actions/apply", { comment: "ok" }],
      ["POST /runs/run-1/actions/discard", { comment: "no" }],
    ]);
  });
});
