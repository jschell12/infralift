import { afterEach, describe, expect, it, vi } from "vitest";
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
