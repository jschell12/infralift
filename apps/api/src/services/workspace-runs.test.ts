import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Runs act on a customer's own Terraform Cloud org with a write-capable
// token, and apply changes real infrastructure. Prisma is stubbed; TFC is a
// fetch stub answering with the documented sample responses in
// lib/tf/__fixtures__/tfc.

const db = vi.hoisted(() => ({
  providerConnection: { findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  workspace: { findFirst: vi.fn(), update: vi.fn() },
}));
vi.mock("../lib/db.js", () => ({ prisma: db }));
vi.mock("node:dns/promises", () => ({ lookup: async () => [{ address: "52.1.2.3" }] }));

process.env.TOKEN_ENCRYPTION_KEY ??= "0".repeat(64);
const { encryptToken } = await import("../lib/crypto.js");
const svc = await import("./workspace-runs.js");
const { Conflict, InvalidInput, NotFound, Unprocessable, Upstream } = await import("../lib/errors.js");

const fixture = (name: string) =>
  readFileSync(new URL(`../lib/tf/__fixtures__/tfc/${name}`, import.meta.url), "utf8");

const TFC_WS = "ws-noZcaGXsac6aZSJR"; // the workspace the run fixtures belong to
const ws = (over: Record<string, unknown> = {}) => ({
  id: "w1",
  orgId: "org_mine",
  name: "app-foundry-demo",
  kind: "managed",
  connectionId: "conn_mine",
  tfcWorkspaceId: TFC_WS,
  vcsRepo: null,
  lastRunStatus: null,
  lastRunAt: null,
  ...over,
});
const conn = (over: Record<string, unknown> = {}) => ({
  id: "conn_mine",
  orgId: "org_mine",
  provider: "tfc",
  vcsOauthTokenId: null,
  encryptedToken: encryptToken(JSON.stringify({ organization: "acme", token: "t" })),
  ...over,
});

function runResponse(confirmable: boolean, workspaceId = TFC_WS) {
  const run = JSON.parse(fixture("runs-with-plan.json")).data[0];
  run.attributes.actions["is-confirmable"] = confirmable;
  run.relationships.workspace.data.id = workspaceId;
  return JSON.stringify({ data: run });
}

function tfc(table: Record<string, [number, string]>) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (url: string, init: { method: string }) => {
    const call = `${init.method} ${url.replace("https://app.terraform.io/api/v2", "")}`;
    calls.push(call);
    const [status, body] = table[call] ?? [404, "{}"];
    return { ok: status < 300, status, json: async () => JSON.parse(body), text: async () => body };
  });
  return calls;
}

beforeEach(() => {
  for (const model of Object.values(db)) for (const fn of Object.values(model)) fn.mockReset().mockResolvedValue(null);
  db.workspace.findFirst.mockImplementation(async ({ where }: { where: { id: string; orgId: string } }) =>
    where.orgId === "org_mine" && where.id === "w1" ? ws() : null
  );
  db.providerConnection.findFirst.mockImplementation(async ({ where }: { where: { orgId: string } }) =>
    where.orgId === "org_mine" ? conn() : null
  );
  db.workspace.update.mockImplementation(async ({ data }: { data: object }) => ({ ...ws(), ...data }));
  vi.unstubAllGlobals();
});

describe("tenant isolation", () => {
  it("another org's workspace id is a 404, and TFC is never called", async () => {
    const calls = tfc({});
    await expect(svc.listRuns("org_other", "w1")).rejects.toBeInstanceOf(NotFound);
    await expect(svc.applyRun("org_other", "w1", "run-1", { confirm: "app-foundry-demo" })).rejects.toBeInstanceOf(NotFound);
    expect(db.workspace.findFirst).toHaveBeenCalledWith({ where: { id: "w1", orgId: "org_other" } });
    expect(calls).toEqual([]);
  });

  it("another org's connection id is a 404", async () => {
    await expect(svc.listOAuthTokens("org_other", "conn_mine")).rejects.toBeInstanceOf(NotFound);
  });

  it("a run from another TFC workspace is a 404, not applied", async () => {
    const calls = tfc({ "GET /runs/run-x": [200, runResponse(true, "ws-someoneelse")] });
    await expect(svc.applyRun("org_mine", "w1", "run-x", { confirm: "app-foundry-demo" })).rejects.toBeInstanceOf(NotFound);
    expect(calls).toEqual(["GET /runs/run-x"]);
  });
});

describe("applyRun gating", () => {
  it("refuses a wrong confirmation name before asking TFC anything", async () => {
    const calls = tfc({});
    await expect(svc.applyRun("org_mine", "w1", "run-1", { confirm: "app-foundry" })).rejects.toBeInstanceOf(InvalidInput);
    expect(calls).toEqual([]);
  });

  it("refuses a run TFC does not call confirmable", async () => {
    const calls = tfc({ "GET /runs/run-1": [200, runResponse(false)] });
    await expect(svc.applyRun("org_mine", "w1", "run-1", { confirm: "app-foundry-demo" })).rejects.toBeInstanceOf(Conflict);
    expect(calls).not.toContain("POST /runs/run-CZcmD7eagjhyX0vN/actions/apply");
  });

  it("applies a confirmable run with the right name", async () => {
    const calls = tfc({
      "GET /runs/run-1": [200, runResponse(true)],
      "POST /runs/run-CZcmD7eagjhyX0vN/actions/apply": [202, ""],
    });
    await expect(svc.applyRun("org_mine", "w1", "run-1", { confirm: "app-foundry-demo" })).resolves.toEqual({
      id: "run-CZcmD7eagjhyX0vN",
      status: "confirmed",
    });
    expect(calls).toContain("POST /runs/run-CZcmD7eagjhyX0vN/actions/apply");
  });
});

describe("runs", () => {
  it("lists runs and records the newest on the workspace", async () => {
    tfc({ [`GET /workspaces/${TFC_WS}/runs?page%5Bsize%5D=20&include=plan`]: [200, fixture("runs-with-plan.json")] });
    const runs = await svc.listRuns("org_mine", "w1");
    expect(runs.map((r) => r.status)).toEqual(["planned", "planning"]);
    expect(runs[0]).not.toHaveProperty("workspaceId");
    expect(db.workspace.update).toHaveBeenCalledWith({
      where: { id: "w1" },
      data: { lastRunStatus: "planned", lastRunAt: new Date("2021-05-24T07:38:04.171Z") },
    });
  });

  it("a 401 from TFC marks the connection invalid and answers 502", async () => {
    tfc({ [`GET /workspaces/${TFC_WS}/runs?page%5Bsize%5D=20&include=plan`]: [401, '{"errors":[{"status":"401"}]}'] });
    await expect(svc.listRuns("org_mine", "w1")).rejects.toBeInstanceOf(Upstream);
    expect(db.providerConnection.updateMany).toHaveBeenCalledWith({
      where: { id: "conn_mine" },
      data: { status: "invalid", lastError: "Terraform Cloud refused the credential (401) during listing runs" },
    });
  });

  it("a 500 from TFC does not mark the connection", async () => {
    tfc({ [`GET /workspaces/${TFC_WS}/runs?page%5Bsize%5D=20&include=plan`]: [500, "{}"] });
    await expect(svc.listRuns("org_mine", "w1")).rejects.toBeInstanceOf(Upstream);
    expect(db.providerConnection.updateMany).not.toHaveBeenCalled();
  });

  it("queueing in a workspace with no configuration is a Conflict that says to link the repo", async () => {
    tfc({ "POST /runs": [422, '{"errors":[]}'] });
    await expect(svc.queueRun("org_mine", "w1", {})).rejects.toThrow(/link a repository/);
  });
});

describe("VCS link", () => {
  it("an org with no VCS provider is a 422 pointing at its TFC settings", async () => {
    tfc({ "GET /organizations/acme/oauth-clients?page%5Bsize%5D=100": [200, '{"data":[]}'] });
    const err = await svc.listOAuthTokens("org_mine", "conn_mine").catch((e) => e);
    expect(err).toBeInstanceOf(Unprocessable);
    expect(err.body().error).toContain("https://app.terraform.io/app/acme/settings/version-control");
  });

  it("links an infralift workspace through the picked token and records it", async () => {
    const calls = tfc({
      "GET /organizations/acme/oauth-clients?page%5Bsize%5D=100": [200, fixture("oauth-clients.json")],
      "GET /oauth-clients/oc-XKFwG6ggfA9n7t1K/oauth-tokens": [200, fixture("oauth-tokens.json")],
      [`PATCH /workspaces/${TFC_WS}`]: [200, fixture("workspace-vcs.json")],
    });
    const out = await svc.linkRepository("org_mine", "w1", { repo: "acme/app", oauthTokenId: "ot-hmAyP66qk2AMVdbJ" });
    expect(out.vcsRepo).toBe("acme/app");
    expect(db.providerConnection.update).toHaveBeenCalledWith({
      where: { id: "conn_mine" },
      data: { vcsOauthTokenId: "ot-hmAyP66qk2AMVdbJ" },
    });
    expect(calls).toContain(`PATCH /workspaces/${TFC_WS}`);
  });

  it("refuses a token that is not in the organization", async () => {
    tfc({
      "GET /organizations/acme/oauth-clients?page%5Bsize%5D=100": [200, fixture("oauth-clients.json")],
      "GET /oauth-clients/oc-XKFwG6ggfA9n7t1K/oauth-tokens": [200, fixture("oauth-tokens.json")],
    });
    await expect(svc.selectOAuthToken("org_mine", "conn_mine", "ot-notours")).rejects.toBeInstanceOf(InvalidInput);
    expect(db.providerConnection.update).not.toHaveBeenCalled();
  });

  it("leaves an adopted workspace's settings alone", async () => {
    db.workspace.findFirst.mockResolvedValue(ws({ kind: "adopted" }));
    const calls = tfc({});
    await expect(svc.linkRepository("org_mine", "w1", { repo: "acme/app" })).rejects.toBeInstanceOf(Conflict);
    expect(calls).toEqual([]);
  });
});
