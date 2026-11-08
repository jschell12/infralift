import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

// The stack routes, with Prisma and the job runner stubbed: what is asserted
// is the where clause (org scoping), what gets stored (settings with the
// stack's defaults filled in), and the status codes.

const h = vi.hoisted(() => ({
  findFirst: vi.fn(),
  projectCreate: vi.fn(),
  projectUpdate: vi.fn(),
  jobCreate: vi.fn(),
  connFindFirst: vi.fn(),
  runJob: vi.fn(async () => {}),
}));

vi.mock("../lib/db.js", () => ({
  prisma: {
    tfProject: { findFirst: h.findFirst, create: h.projectCreate, update: h.projectUpdate },
    tfJob: { create: h.jobCreate },
    providerConnection: { findFirst: h.connFindFirst },
  },
}));
vi.mock("../lib/tf/pipeline.js", () => ({ runJob: h.runJob }));
vi.mock("../lib/tf/tfc-connection.js", () => {
  class TfcConnectionError extends Error {}
  return {
    TfcConnectionError,
    loadTfcConnection: vi.fn(async (orgId: string, id: string) => {
      if (orgId !== "org-a" || id !== "tfc-mine") throw new TfcConnectionError("Terraform Cloud connection not found: pick one under Connections");
      return { organization: "josh-org", hostname: "app.terraform.io", token: "t" };
    }),
  };
});

const { tfRouter } = await import("./tf.js");
const { getStack } = await import("../lib/stacks/index.js");

type Handler = (req: unknown, res: unknown, next?: unknown) => unknown;

async function call(method: string, path: string, req: Record<string, unknown>) {
  const layer = (
    tfRouter as unknown as {
      stack: { route?: { path: string; methods: Record<string, boolean>; stack: { handle: Handler }[] } }[];
    }
  ).stack.find((l) => l.route?.path === path && l.route?.methods[method]);
  if (!layer?.route) throw new Error(`no ${method} ${path}`);
  const out = { status: 200, body: undefined as unknown };
  const res = {
    status(code: number) {
      out.status = code;
      return this;
    },
    json(payload: unknown) {
      out.body = payload;
      return this;
    },
  };
  await layer.route.stack.at(-1)!.handle(
    { user: { orgId: "org-a" }, params: {}, query: {}, ...req },
    res
  );
  return out;
}

const example = getStack("app-foundry-hetzner")!.example;

beforeEach(() => {
  vi.clearAllMocks();
  h.jobCreate.mockImplementation(async ({ data }: { data: object }) => ({ id: "job1", ...data }));
  h.projectCreate.mockImplementation(async ({ data }: { data: object }) => ({ id: "p1", ...data }));
  h.projectUpdate.mockImplementation(async ({ data }: { data: object }) => ({ id: "p1", ...data }));
  h.connFindFirst.mockResolvedValue({ id: "conn-gh" });
});

describe("GET /stacks", () => {
  it("lists stacks with their template and target", async () => {
    const out = await call("get", "/stacks", {});
    expect(out.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          slug: "app-foundry-hetzner",
          template: expect.objectContaining({ slug: "app-foundry" }),
          target: expect.objectContaining({ slug: "hetzner" }),
        }),
      ])
    );
  });
});

describe("POST /stacks/:slug/projects", () => {
  const body = { name: "acme", destRepo: "acme/app", arguments: example };

  it("stores the settings with defaults filled in and starts a stack job", async () => {
    const out = await call("post", "/stacks/:slug/projects", {
      params: { slug: "app-foundry-hetzner" },
      body,
    });
    expect(out.status).toBe(202);
    const data = h.projectCreate.mock.calls[0][0].data;
    expect(data).toMatchObject({ orgId: "org-a", source: "stack", stackSlug: "app-foundry-hetzner" });
    expect(data.providerConfig).toMatchObject({ ...example, server_type: "cx23", backend: "r2" });
    expect(h.jobCreate.mock.calls[0][0].data.kind).toBe("stack");
    expect(h.runJob).toHaveBeenCalledWith("job1");
  });

  it("greenfield: records the host, the org's connection and createRepo", async () => {
    const out = await call("post", "/stacks/:slug/projects", {
      params: { slug: "app-foundry-hetzner" },
      body: { ...body, createRepo: true },
    });
    expect(out.status).toBe(202);
    expect(h.connFindFirst.mock.calls[0][0].where).toEqual({ orgId: "org-a", provider: "github" });
    expect(h.projectCreate.mock.calls[0][0].data).toMatchObject({
      gitHost: "github",
      gitConnectionId: "conn-gh",
      createRepo: true,
    });
  });

  it("GitLab: picks GitLab CI and wires the project's own path", async () => {
    const out = await call("post", "/stacks/:slug/projects", {
      params: { slug: "app-foundry-hetzner" },
      body: { ...body, gitHost: "gitlab", destRepo: "acme/platform/web" },
    });
    expect(out.status).toBe(202);
    expect(h.connFindFirst.mock.calls[0][0].where).toMatchObject({ provider: "gitlab" });
    expect(h.projectCreate.mock.calls[0][0].data).toMatchObject({
      gitHost: "gitlab",
      providerConfig: expect.objectContaining({ delivery: "gitlab-ci", gitlab_project: "acme/platform/web" }),
    });
  });

  it("refuses a delivery that does not run on the repository's host", async () => {
    const out = await call("post", "/stacks/:slug/projects", {
      params: { slug: "app-foundry-hetzner" },
      body: {
        ...body,
        gitHost: "gitlab",
        destRepo: "acme/platform/web",
        arguments: { ...example, delivery: "github-actions" },
      },
    });
    expect(out.status).toBe(400);
    expect(String((out.body as { error: string }).error)).toContain("use GitLab CI");
    expect(h.projectCreate).not.toHaveBeenCalled();
  });

  it("needs a connection to the host, and only looks in the caller's org", async () => {
    h.connFindFirst.mockResolvedValueOnce(null);
    const out = await call("post", "/stacks/:slug/projects", {
      params: { slug: "app-foundry-hetzner" },
      body: { ...body, connectionId: "conn-of-org-b" },
    });
    expect(out.status).toBe(400);
    expect(h.connFindFirst.mock.calls[0][0].where).toEqual({
      orgId: "org-a",
      provider: "github",
      id: "conn-of-org-b",
    });
    expect(h.projectCreate).not.toHaveBeenCalled();
  });

  it("refuses a nested path on GitHub", async () => {
    const out = await call("post", "/stacks/:slug/projects", {
      params: { slug: "app-foundry-hetzner" },
      body: { ...body, destRepo: "acme/platform/web" },
    });
    expect(out.status).toBe(400);
  });

  it("answers 409 for a name the org already uses", async () => {
    h.projectCreate.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "x" })
    );
    const out = await call("post", "/stacks/:slug/projects", {
      params: { slug: "app-foundry-hetzner" },
      body,
    });
    expect(out.status).toBe(409);
    expect(h.runJob).not.toHaveBeenCalled();
  });

  it("answers 400 for settings the stack's schema rejects, before storing anything", async () => {
    const out = await call("post", "/stacks/:slug/projects", {
      params: { slug: "app-foundry-hetzner" },
      body: { ...body, arguments: { ...example, server_type: "huge" } },
    });
    expect(out.status).toBe(400);
    expect(h.projectCreate).not.toHaveBeenCalled();
  });
});

describe("PUT /stacks/projects/:id/settings", () => {
  const project = {
    id: "p1",
    orgId: "org-a",
    source: "stack",
    stackSlug: "app-foundry-hetzner",
    providerConfig: example,
  };

  it("only finds stack projects in the caller's org", async () => {
    h.findFirst.mockResolvedValueOnce(null);
    const out = await call("put", "/stacks/projects/:id/settings", {
      params: { id: "p-of-org-b" },
      body: { arguments: example },
    });
    expect(out.status).toBe(404);
    expect(h.findFirst.mock.calls[0][0].where).toEqual({
      id: "p-of-org-b",
      orgId: "org-a",
      source: "stack",
    });
    expect(h.jobCreate).not.toHaveBeenCalled();
  });

  it("stores the new settings and renders them into a new job", async () => {
    h.findFirst.mockResolvedValueOnce(project);
    const out = await call("put", "/stacks/projects/:id/settings", {
      params: { id: "p1" },
      body: { arguments: { ...example, server_type: "cx33" } },
    });
    expect(out.status).toBe(202);
    expect(h.projectUpdate.mock.calls[0][0].data.providerConfig).toMatchObject({
      server_type: "cx33",
      max_previews: 3,
    });
    expect(h.jobCreate.mock.calls[0][0].data).toMatchObject({
      kind: "stack",
      argumentsJson: expect.objectContaining({ server_type: "cx33" }),
    });
  });

  it("takes tfc_organization from the Terraform Cloud connection, not from what was typed", async () => {
    h.findFirst.mockResolvedValueOnce(project);
    const out = await call("put", "/stacks/projects/:id/settings", {
      params: { id: "p1" },
      body: { arguments: { ...example, backend: "tfc", tfc_organization: "typed-org" }, tfcConnectionId: "tfc-mine" },
    });
    expect(out.status).toBe(202);
    const data = h.projectUpdate.mock.calls[0][0].data;
    expect(data.tfcConnectionId).toBe("tfc-mine");
    expect(data.providerConfig.tfc_organization).toBe("josh-org");
  });

  it("refuses a tfc backend with no connection, or another org's connection", async () => {
    for (const tfcConnectionId of [undefined, "tfc-theirs"]) {
      h.findFirst.mockResolvedValueOnce(project);
      const out = await call("put", "/stacks/projects/:id/settings", {
        params: { id: "p1" },
        body: { arguments: { ...example, backend: "tfc", tfc_organization: "x" }, ...(tfcConnectionId ? { tfcConnectionId } : {}) },
      });
      expect(out.status, String(tfcConnectionId)).toBe(400);
    }
    expect(h.projectUpdate).not.toHaveBeenCalled();
  });

  it("drops the connection when the backend goes back to R2", async () => {
    h.findFirst.mockResolvedValueOnce({ ...project, tfcConnectionId: "tfc-mine" });
    const out = await call("put", "/stacks/projects/:id/settings", {
      params: { id: "p1" },
      body: { arguments: { ...example, backend: "r2" } },
    });
    expect(out.status).toBe(202);
    expect(h.projectUpdate.mock.calls[0][0].data.tfcConnectionId).toBeNull();
  });

  it("answers 400 and changes nothing for invalid settings", async () => {
    h.findFirst.mockResolvedValueOnce(project);
    const out = await call("put", "/stacks/projects/:id/settings", {
      params: { id: "p1" },
      body: { arguments: { ...example, backend: "tfc" } }, // tfc needs an org
    });
    expect(out.status).toBe(400);
    expect(h.projectUpdate).not.toHaveBeenCalled();
  });

  it("refuses to rename the resource prefix of an existing project", async () => {
    h.findFirst.mockResolvedValueOnce(project);
    const out = await call("put", "/stacks/projects/:id/settings", {
      params: { id: "p1" },
      body: { arguments: { ...example, name: "renamed" } },
    });
    expect(out.status).toBe(400);
    expect(String((out.body as { error: string }).error)).toContain("fixed after creation");
    expect(h.projectUpdate).not.toHaveBeenCalled();
  });
});

describe("project names", () => {
  it("refuses a name the stack could not use as its resource prefix", async () => {
    for (const name of ["ab", "1app", "App"]) {
      const out = await call("post", "/stacks/:slug/projects", {
        params: { slug: "app-foundry-hetzner" },
        body: { name, destRepo: "acme/app", arguments: { ...example, name } },
      });
      expect(out.status, name).toBe(400);
    }
    expect(h.projectCreate).not.toHaveBeenCalled();
  });
});
