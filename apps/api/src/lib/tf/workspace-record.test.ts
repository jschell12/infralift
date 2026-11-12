import { readFileSync } from "node:fs";
import { Prisma } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The Workspace row a template or codegen job writes for the TFC workspace it
// creates or reuses (stack jobs: pipeline-stack.test.ts). The jobs run with
// the real TfCloudWorkspaceAdapter against a TFC fetch stub answering with
// the documented sample in __fixtures__/tfc; the database is an in-memory
// Workspace table that enforces the schema's two unique keys.

type Row = Record<string, any> & { id: string; orgId: string; name: string; kind: string };

const h = vi.hoisted(() => {
  const state = { rows: [] as Row[], stages: [] as { status: string; statusMessage: string }[], job: null as any };
  const unique = (where: any): Row | null => {
    if (where.id) return state.rows.find((r) => r.id === where.id) ?? null;
    if (where.orgId_name) return state.rows.find((r) => r.orgId === where.orgId_name.orgId && r.name === where.orgId_name.name) ?? null;
    const k = where.orgId_tfcWorkspaceId;
    return state.rows.find((r) => r.orgId === k.orgId && r.tfcWorkspaceId === k.tfcWorkspaceId) ?? null;
  };
  const prisma = {
    workspace: {
      findUnique: vi.fn(async ({ where }: any) => unique(where)),
      findFirst: vi.fn(async ({ where }: any) => state.rows.find((r) => r.id === where.id && r.orgId === where.orgId) ?? null),
      create: vi.fn(async ({ data }: any) => {
        const clash = state.rows.some(
          (r) => r.orgId === data.orgId && (r.name === data.name || (data.tfcWorkspaceId && r.tfcWorkspaceId === data.tfcWorkspaceId))
        );
        if (clash) throw new (h.P2002 as any)("unique", { code: "P2002", clientVersion: "test" });
        const row = { id: `w${state.rows.length + 1}`, vcsRepo: null, projectId: null, ...data };
        state.rows.push(row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: any) => Object.assign(unique(where)!, data)),
    },
    tfJob: {
      findUniqueOrThrow: vi.fn(async () => state.job),
      findUnique: vi.fn(async () => ({ stage: "render" })),
      update: vi.fn(async ({ data }: any) => {
        if ("stage" in data) state.stages.push(data);
        return {};
      }),
    },
    providerConnection: { findFirst: vi.fn(async () => ({ encryptedToken: "enc" })) },
    tfRendering: { upsert: vi.fn(async () => ({ id: "r1" })), update: vi.fn(), updateMany: vi.fn() },
    tfProject: { update: vi.fn() },
  };
  return { state, prisma, P2002: null as unknown };
});
h.P2002 = Prisma.PrismaClientKnownRequestError;

vi.mock("../db.js", () => ({ prisma: h.prisma }));
vi.mock("../crypto.js", () => ({ decryptToken: () => "token" }));
vi.mock("./render.js", () => ({
  validateArguments: () => undefined,
  renderTemplate: () => "# rendered",
  renderedFileName: () => "main.tf",
  renderProviderFile: () => "# provider",
}));
vi.mock("./codegen.js", () => ({ generateHcl: () => [{ fileName: "main.tf", content: "# generated" }] }));
vi.mock("../git/hosts.js", async (orig) => ({
  ...(await orig<object>()),
  gitHostClient: () => ({
    commitFiles: async () => ({ commitSha: "c0ffee1", noop: false }),
    ensureRepo: async () => ({ repo: "acme/infra", created: false, defaultBranch: "main" }),
  }),
}));
const cred = { organization: "acme", hostname: "app.terraform.io", token: "t" };
vi.mock("./tfc-connection.js", async () => {
  const { TfCloudWorkspaceAdapter } = await import("./workspace.js");
  const own = (orgId: string, connectionId: string) => {
    if (orgId !== "org_a" || connectionId !== "tfc-1") throw new Error("connection not found");
  };
  return {
    TfcConnectionError: class extends Error {},
    tfcAdapterFor: async (orgId: string, connectionId: string) => {
      own(orgId, connectionId);
      return { adapter: new TfCloudWorkspaceAdapter("t", "acme", "https://app.terraform.io/api/v2"), cred };
    },
    loadTfcConnectionRow: async (orgId: string, connectionId: string) => {
      own(orgId, connectionId);
      return { conn: { id: connectionId, vcsOauthTokenId: "ot-hmAyP66qk2AMVdbJ" }, cred };
    },
  };
});

const { runJob } = await import("./pipeline.js");
const { recordJobWorkspace } = await import("./workspace-record.js");
const { linkRepository } = await import("../../services/workspace-runs.js");
const { Conflict } = await import("../errors.js");

// The documented sample, unlinked, so "already linked" is never the reason a
// link is refused below.
const sample = JSON.parse(readFileSync(new URL("./__fixtures__/tfc/workspace-vcs.json", import.meta.url), "utf8")).data;
const tfcWorkspace = (name: string, id: string) => ({ data: { ...sample, id, attributes: { ...sample.attributes, name, "vcs-repo": null } } });

/** TFC with `existing` workspaces already in it; POSTs create new ones. */
function tfc(existing: Record<string, string> = {}) {
  const workspaces = new Map(Object.entries(existing).map(([name, id]) => [name, tfcWorkspace(name, id)]));
  const sent: string[] = [];
  vi.stubGlobal("fetch", async (url: string, init: { method: string; body?: string }) => {
    const path = url.replace("https://app.terraform.io/api/v2", "");
    sent.push(`${init.method} ${path}`);
    const reply = (status: number, body: unknown) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
    const byName = path.match(/^\/organizations\/acme\/workspaces\/([^/]+)$/);
    if (init.method === "GET" && byName) {
      const ws = workspaces.get(decodeURIComponent(byName[1]));
      return ws ? reply(200, ws) : reply(404, {});
    }
    if (init.method === "POST" && path === "/organizations/acme/workspaces") {
      const name = JSON.parse(init.body!).data.attributes.name;
      const ws = tfcWorkspace(name, `ws-created${workspaces.size + 1}`);
      workspaces.set(name, ws);
      return reply(201, ws);
    }
    if (init.method === "POST" && path === "/runs") return reply(422, { errors: [] }); // no configuration yet
    return reply(500, { errors: [`unhandled ${init.method} ${path}`] });
  });
  return sent;
}

const project = {
  id: "p1",
  orgId: "org_a",
  name: "shop",
  destRepo: "acme/infra",
  destBranch: "main",
  destPath: "infra",
  tfcConnectionId: "tfc-1",
  migrationTarget: null,
  providerConfig: { name: "hcloud", region: "fsn1" },
  templateVersion: { id: "tv1", inputSchema: {}, templateBody: "", releaseTag: "v1", template: { slug: "web" } },
  assessment: { id: "a1", status: "completed", provider: "aws", inventory: [] },
  renderings: [] as { fileName: string }[],
};
const templateJob = () => (h.state.job = { id: "job1", kind: "template", argumentsJson: {}, project });
const codegenJob = () => (h.state.job = { id: "job2", kind: "codegen", argumentsJson: {}, project });

beforeEach(() => {
  vi.clearAllMocks();
  h.state.rows = [];
  h.state.stages = [];
});
afterEach(() => vi.unstubAllGlobals());

describe.each([
  ["template", templateJob, "shop-fsn1"],
  ["codegen", codegenJob, "shop"],
])("%s job", (_kind, job, name) => {
  it("records the workspace it created as managed, once, and a rerun adds no row", async () => {
    tfc();
    job();
    await runJob(h.state.job.id);
    expect(h.state.stages.at(-1)).toMatchObject({ status: "success" });
    expect(h.state.stages.at(-1)!.statusMessage).toContain("listed under Workspaces as managed");
    expect(h.state.rows).toEqual([
      expect.objectContaining({
        orgId: "org_a",
        name,
        kind: "managed",
        projectId: "p1",
        connectionId: "tfc-1",
        tfcWorkspaceId: "ws-created1",
        tfcWorkspaceUrl: `https://app.terraform.io/app/acme/workspaces/${name}`,
        workingDirectory: "deploy/infra",
        vcsRepo: null,
      }),
    ]);

    // The rerun finds the workspace it made and keeps it managed.
    await runJob(h.state.job.id);
    expect(h.state.stages.at(-1)).toMatchObject({ status: "success" });
    expect(h.state.rows).toHaveLength(1);
    expect(h.state.rows[0].kind).toBe("managed");
  });

  it("records a same-name workspace it did not create as adopted, and linking it is refused", async () => {
    const sent = tfc({ [name]: sample.id });
    job();
    await runJob(h.state.job.id);
    expect(sent).not.toContain("POST /organizations/acme/workspaces");
    expect(h.state.stages.at(-1)!.statusMessage).toMatch(/infralift did not create it, so it is listed as adopted/);
    expect(h.state.rows).toEqual([expect.objectContaining({ name, kind: "adopted", tfcWorkspaceId: sample.id, vcsRepo: null })]);

    sent.length = 0;
    const refused = linkRepository("org_a", h.state.rows[0].id, { repo: "acme/infra" });
    await expect(refused).rejects.toBeInstanceOf(Conflict);
    await expect(refused).rejects.toThrow(/adopted workspaces keep their own settings/);
    expect(sent).toEqual([]); // nothing sent to TFC

    await runJob(h.state.job.id);
    expect(h.state.rows).toHaveLength(1);
    expect(h.state.rows[0].kind).toBe("adopted");
  });
});

// One .tf file per project, rewritten by each job. A file per job put the same
// resource blocks in the directory twice on the second run, which Terraform
// refuses.
describe("template job file name", () => {
  it("renders a new project into the project's file", async () => {
    tfc();
    templateJob();
    await runJob("job1");
    expect(h.prisma.tfRendering.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { projectId_fileName: { projectId: "p1", fileName: "main.tf" } } })
    );
  });

  it("keeps writing the file a project already has, so an old per-job name is overwritten, not joined", async () => {
    tfc();
    h.state.job = { id: "job9", kind: "template", argumentsJson: {}, project: { ...project, renderings: [{ fileName: "shop-job-job1.tf" }] } };
    await runJob("job9");
    expect(h.prisma.tfRendering.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { projectId_fileName: { projectId: "p1", fileName: "shop-job-job1.tf" } } })
    );
  });
});

describe("recordJobWorkspace", () => {
  const ws = (over: Record<string, unknown> = {}) => ({
    workspaceName: "shop",
    tfcWorkspaceId: "ws-1",
    created: true,
    workingDirectory: "infra",
    vcsRepo: null,
    queueAllRuns: false,
    linkError: null,
    ...over,
  });
  const input = (orgId: string, over: Record<string, unknown> = {}) => ({
    orgId,
    projectId: `${orgId}-p`,
    connectionId: `${orgId}-c`,
    cred,
    ws: ws(over),
  });

  it("keeps each org's row to itself, even for the same TFC workspace id", async () => {
    await recordJobWorkspace(input("org_a"));
    await recordJobWorkspace(input("org_b", { created: false, vcsRepo: "b/repo" }));
    expect(h.state.rows.map((r) => [r.orgId, r.kind, r.projectId, r.vcsRepo])).toEqual([
      ["org_a", "managed", "org_a-p", null],
      ["org_b", "adopted", "org_b-p", "b/repo"],
    ]);
    for (const call of h.prisma.workspace.findUnique.mock.calls) {
      expect(Object.values(call[0].where)[0]).toHaveProperty("orgId");
    }
  });

  it("never changes a row an adopt or extension flow wrote", async () => {
    h.state.rows.push({ id: "w9", orgId: "org_a", name: "shop", kind: "adopted", tfcWorkspaceId: "ws-1", vcsRepo: "theirs/repo", projectId: "other" });
    const r = await recordJobWorkspace(input("org_a", { vcsRepo: null }));
    expect(r).toEqual({ status: "recorded", id: "w9", kind: "adopted" });
    expect(h.state.rows[0]).toMatchObject({ vcsRepo: "theirs/repo", projectId: "other" });
    expect(h.prisma.workspace.update).not.toHaveBeenCalled();
  });

  it("does not take over a row of the same name that points at another TFC workspace", async () => {
    h.state.rows.push({ id: "w9", orgId: "org_a", name: "shop", kind: "managed", tfcWorkspaceId: "ws-other" });
    const r = await recordJobWorkspace(input("org_a"));
    expect(r).toMatchObject({ status: "skipped" });
    expect(h.state.rows).toHaveLength(1);
    expect(h.state.rows[0].tfcWorkspaceId).toBe("ws-other");
  });
});
