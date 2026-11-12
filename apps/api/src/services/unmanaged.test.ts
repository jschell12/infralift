import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import type { ResourceInventoryItem } from "@infralift/shared";

// "Adopt from an account": GET /connections/:id/unmanaged and
// POST /connections/:id/adopt, through the real router, services, Cloudflare
// connector and adopters. Prisma, the job runner and the network are stubbed.
//
// The account is connectors/__fixtures__/cloudflare-api.json, served to the
// real Cloudflare connector, so every inventory item here is one the connector
// produced. That fixture is the response examples from Cloudflare's API
// reference, not a capture from a live account (its _source says so). The
// second zone's DNS record is the fixture's record with a new id, because the
// fixture has one record and a real account's record ids are unique.

const cf = JSON.parse(readFileSync(new URL("../connectors/__fixtures__/cloudflare-api.json", import.meta.url), "utf8"));
const ZONE_1 = cf.zonesPage1.result[0].id as string;
const ZONE_2 = cf.zonesPage2.result[0].id as string;
const RECORD_2 = "9a7806061c88ada191ed06f989cc3dac";
const dnsZone2 = { ...cf.dnsRecords, result: [{ ...cf.dnsRecords.result[0], id: RECORD_2, name: "example.org" }] };

const h = vi.hoisted(() => ({
  connFindFirst: vi.fn(),
  connUpdateMany: vi.fn(),
  ledgerFindMany: vi.fn(),
  ledgerCreateMany: vi.fn(),
  projectFindFirst: vi.fn(),
  projectCreate: vi.fn(),
  jobCreate: vi.fn(),
  jobFindFirst: vi.fn(),
  runJob: vi.fn(),
}));

vi.mock("../lib/db.js", () => {
  const prisma = {
    providerConnection: { findFirst: h.connFindFirst, updateMany: h.connUpdateMany },
    managedResource: { findMany: h.ledgerFindMany, createMany: h.ledgerCreateMany },
    tfProject: { findFirst: h.projectFindFirst, create: h.projectCreate },
    tfJob: { create: h.jobCreate, findFirst: h.jobFindFirst },
    $transaction: async (fn: (tx: unknown) => unknown) => fn(prisma),
  };
  return { prisma };
});
vi.mock("../lib/crypto.js", () => ({ decryptToken: () => "token" }));
vi.mock("../lib/jobs/start.js", () => ({ startJob: h.runJob }));

const { connectionsRouter } = await import("../routes/connections.js");
const { INVENTORY_TTL_MS, encodeCursor, resetUnmanagedState, subtractManaged } = await import("./unmanaged.js");
const { ledgerKey } = await import("./managed-resources.js");
const { cloudflareConnector } = await import("../connectors/cloudflare.js");

// -- the account and GitHub, over fetch ---------------------------------------------

let cloudflareCalls = 0;
let cloudflareStatus = 200;

function fakeNetwork() {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const url = String(input);
      if (url.startsWith("https://api.cloudflare.com/client/v4")) {
        if (url.includes("/accounts?per_page")) cloudflareCalls++;
        if (cloudflareStatus !== 200) return json({ success: false, errors: [] }, cloudflareStatus);
        if (url.includes("/accounts?")) return json(cf.accounts);
        if (url.includes("/r2/buckets")) return json(cf.r2Buckets);
        if (url.includes("/zones?per_page=50&page=1")) return json(cf.zonesPage1);
        if (url.includes("/zones?per_page=50&page=2")) return json(cf.zonesPage2);
        if (url.includes(`/zones/${ZONE_1}/dns_records`)) return json(cf.dnsRecords);
        if (url.includes(`/zones/${ZONE_2}/dns_records`)) return json(dnsZone2);
        return json({ success: false, errors: [] }, 404); // workers, pages: none in this account
      }
      const path = url.replace("https://api.github.com", "");
      if (path === "/repos/acme/infra") return json({ default_branch: "main" });
      if (path.startsWith("/repos/acme/infra/contents/")) return json({}, 404);
      return json({ message: `unhandled ${url}` }, 500);
    })
  );
}

const CONNECTION = {
  id: "cf-conn",
  orgId: "org-a",
  provider: "cloudflare",
  label: "cf",
  encryptedToken: "enc",
  status: "valid",
  updatedAt: new Date("2026-11-10T00:00:00Z"),
};

/** The org's own connections; any other id or org finds nothing, as the real
 *  org-scoped query would. */
function connections(where: { id?: string; orgId: string; provider?: string }) {
  if (where.orgId !== "org-a") return null;
  if (where.provider === "github") return { id: "gh-conn", orgId: "org-a", provider: "github", encryptedToken: "enc" };
  if (where.id === "cf-conn") return CONNECTION;
  if (where.id === "gh-conn") return { ...CONNECTION, id: "gh-conn", provider: "github" };
  return null;
}

// -- calling the router -----------------------------------------------------------------

type Handler = (req: unknown, res: unknown) => unknown;

async function call(
  method: "get" | "post",
  path: string,
  opts: { id?: string; orgId?: string; query?: Record<string, string>; body?: unknown } = {}
) {
  const layer = (
    connectionsRouter as unknown as {
      stack: { route?: { path: string; methods: Record<string, boolean>; stack: { handle: Handler }[] } }[];
    }
  ).stack.find((l) => l.route?.path === path && l.route?.methods[method]);
  const out = { status: 200, body: undefined as unknown as Record<string, unknown>, headers: {} as Record<string, string> };
  const res = {
    headersSent: false,
    status(code: number) {
      out.status = code;
      return this;
    },
    setHeader(name: string, value: string) {
      out.headers[name.toLowerCase()] = value;
    },
    json(payload: Record<string, unknown>) {
      out.body = payload;
      return this;
    },
  };
  await layer!.route!.stack.at(-1)!.handle(
    { user: { orgId: opts.orgId ?? "org-a" }, params: { id: opts.id ?? "cf-conn" }, query: opts.query ?? {}, body: opts.body ?? {} },
    res
  );
  return out;
}

const list = (query: Record<string, string> = {}, more: { id?: string; orgId?: string } = {}) =>
  call("get", "/:id/unmanaged", { query, ...more });

type Row = { type: string; providerId: string; name: string; adoptable: boolean; reason: string | null; terraformType: string | null };

beforeEach(() => {
  vi.clearAllMocks();
  resetUnmanagedState();
  cloudflareCalls = 0;
  cloudflareStatus = 200;
  h.connFindFirst.mockImplementation(async ({ where }: { where: { id?: string; orgId: string; provider?: string } }) => connections(where));
  h.connUpdateMany.mockResolvedValue({ count: 1 });
  h.ledgerFindMany.mockResolvedValue([]);
  h.ledgerCreateMany.mockResolvedValue({ count: 0 });
  h.projectFindFirst.mockResolvedValue(null);
  h.projectCreate.mockImplementation(async ({ data }: { data: object }) => ({ id: "p-new", ...data }));
  h.jobCreate.mockImplementation(async ({ data }: { data: object }) => ({ id: "job-new", status: "pending", ...data }));
  fakeNetwork();
});

afterEach(() => {
  vi.useRealTimers();
});

// -- subtraction ---------------------------------------------------------------------------

describe("subtractManaged", () => {
  let inventory: ResourceInventoryItem[];
  beforeEach(async () => {
    inventory = (await cloudflareConnector.assess("token")).inventory;
  });

  const zone1 = () => ({ type: "cloudflare:zone", providerId: ZONE_1 });
  const record1 = () => ({ type: "cloudflare:dns_record", providerId: cf.dnsRecords.result[0].id as string });
  const bucket = () => ({ type: "cloudflare:r2_bucket", providerId: "example-bucket" });

  it("lists what the connector found, adoptable with its Terraform type", () => {
    const rows = subtractManaged("cloudflare", inventory, new Set());
    expect(rows.map((r) => [r.type, r.providerId, r.adoptable, r.terraformType])).toEqual([
      ["cloudflare:dns_record", cf.dnsRecords.result[0].id, true, "cloudflare_dns_record"],
      ["cloudflare:dns_record", RECORD_2, true, "cloudflare_dns_record"],
      ["cloudflare:r2_bucket", "example-bucket", true, "cloudflare_r2_bucket"],
      ["cloudflare:zone", ZONE_1, true, "cloudflare_zone"],
      ["cloudflare:zone", ZONE_2, true, "cloudflare_zone"],
    ]);
  });

  it.each([
    ["nothing managed", [], 5],
    ["one zone managed", [zone1()], 4],
    ["a zone and its record managed", [zone1(), record1()], 3],
    ["everything managed", null, 0],
    // Same id, other type: a DNS record whose id happens to equal a zone's
    // (the fixture's do) is a different resource.
    ["a key with the right id but the wrong type", [{ type: "cloudflare:worker", providerId: ZONE_1 }], 5],
  ])("subtracts the ledger: %s", (_label, managed, left) => {
    const keys = managed ?? inventory.map((i) => ({ type: i.type, providerId: i.externalId }));
    const rows = subtractManaged("cloudflare", inventory, new Set(keys.map(ledgerKey)));
    expect(rows).toHaveLength(left);
    for (const k of keys) expect(rows.some((r) => r.type === k.type && r.providerId === k.providerId)).toBe(false);
  });

  it("leaves out usage lines and lists a resource the connector reported twice once", () => {
    const usage = { provider: "cloudflare" as const, type: "cloudflare:usage", externalId: "u", name: "usage" };
    const rows = subtractManaged("cloudflare", [...inventory, inventory[0]!, usage], new Set());
    expect(rows).toHaveLength(5);
    expect(rows.some((r) => r.type === "cloudflare:usage")).toBe(false);
  });

  it("says why an item cannot be adopted", () => {
    const noAccount = { provider: "cloudflare" as const, type: "cloudflare:worker", externalId: "w1", name: "api", metadata: {} };
    const unknown = { provider: "cloudflare" as const, type: "cloudflare:load_balancer", externalId: "lb", name: "lb" };
    const rows = subtractManaged("cloudflare", [noAccount, unknown], new Set());
    expect(rows.find((r) => r.providerId === "w1")).toMatchObject({ adoptable: false, terraformType: null });
    expect(rows.find((r) => r.providerId === "w1")?.reason).toContain("account id");
    expect(rows.find((r) => r.providerId === "lb")?.reason).toBe("no Terraform import mapping for this kind yet");
  });
});

// -- GET /connections/:id/unmanaged ------------------------------------------------------

describe("GET /connections/:id/unmanaged", () => {
  it("returns the account minus the ledger, read for this org and connection", async () => {
    h.ledgerFindMany.mockResolvedValue([{ resourceType: "cloudflare:zone", providerId: ZONE_1 }]);
    const out = await list();
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ connectionId: "cf-conn", provider: "cloudflare", total: 4, adoptable: 4 });
    expect((out.body.resources as Row[]).some((r) => r.providerId === ZONE_1 && r.type === "cloudflare:zone")).toBe(false);
    expect(h.connFindFirst.mock.calls[0][0].where).toEqual({ id: "cf-conn", orgId: "org-a" });
    expect(h.ledgerFindMany.mock.calls[0][0].where).toEqual({ orgId: "org-a", providerConnectionId: "cf-conn" });
    expect(out.headers["x-next-cursor"]).toBeUndefined();
  });

  it("404s another org's connection without calling the provider", async () => {
    const out = await list({}, { orgId: "org-b" });
    expect(out.status).toBe(404);
    expect(cloudflareCalls).toBe(0);
  });

  it("refuses a git host connection: it is not a cloud account", async () => {
    expect((await list({}, { id: "gh-conn" })).status).toBe(400);
  });

  it("pages with a cursor in X-Next-Cursor until the last page, without repeats", async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const out = await list({ limit: "2", ...(cursor ? { cursor } : {}) });
      expect(out.status).toBe(200);
      seen.push(...(out.body.resources as Row[]).map((r) => `${r.type}/${r.providerId}`));
      cursor = out.headers["x-next-cursor"];
      pages++;
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    // Every page came from the one cached inventory.
    expect(cloudflareCalls).toBe(1);
  });

  it("keeps its place when the row a cursor names has since been adopted", async () => {
    const first = await list({ limit: "2" });
    const lastOfFirst = (first.body.resources as Row[])[1]!;
    h.ledgerFindMany.mockResolvedValue([{ resourceType: lastOfFirst.type, providerId: lastOfFirst.providerId }]);
    const second = await list({ limit: "2", cursor: first.headers["x-next-cursor"]! });
    const all = await list({ limit: "200" });
    const after = (all.body.resources as Row[]).filter((r) => `${r.type}/${r.providerId}` > `${lastOfFirst.type}/${lastOfFirst.providerId}`);
    expect((second.body.resources as Row[]).map((r) => r.providerId)).toEqual(after.slice(0, 2).map((r) => r.providerId));
  });

  it.each([
    ["a limit above the cap", { limit: "201" }],
    ["a limit of zero", { limit: "0" }],
    ["a cursor this list never returned", { cursor: "not-a-cursor" }],
  ])("400s %s", async (_label, query) => {
    expect((await list(query)).status).toBe(400);
  });

  it("returns an empty page past the end rather than starting over", async () => {
    const out = await list({ cursor: encodeCursor({ type: "zzz", providerId: "zzz" }) });
    expect(out.body.resources).toEqual([]);
    expect(out.headers["x-next-cursor"]).toBeUndefined();
  });

  describe("the inventory cache", () => {
    it("reuses the inventory inside the TTL, reads again after it, and on ?refresh=1", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-11-11T12:00:00Z"));
      await list();
      await list();
      expect(cloudflareCalls).toBe(1);

      vi.setSystemTime(new Date(Date.now() + INVENTORY_TTL_MS - 1));
      await list();
      expect(cloudflareCalls).toBe(1);

      vi.setSystemTime(new Date(Date.now() + 1));
      const expired = await list();
      expect(cloudflareCalls).toBe(2);
      expect(expired.body.fetchedAt).toBe(new Date(Date.now()).toISOString());

      await list({ refresh: "1" });
      expect(cloudflareCalls).toBe(3);
    });

    it("reads again after the credential is replaced", async () => {
      await list();
      h.connFindFirst.mockImplementation(async ({ where }: { where: { id?: string; orgId: string; provider?: string } }) => {
        const c = connections(where);
        return c === CONNECTION ? { ...CONNECTION, updatedAt: new Date("2026-11-11T00:00:00Z") } : c;
      });
      await list();
      expect(cloudflareCalls).toBe(2);
    });

    it("shares one provider read between requests that arrive together", async () => {
      await Promise.all([list(), list(), list()]);
      expect(cloudflareCalls).toBe(1);
    });

    it("limits provider reads per org, and serves cached pages past the limit", async () => {
      for (let i = 0; i < 10; i++) expect((await list({ refresh: "1" })).status).toBe(200);
      expect((await list({ refresh: "1" })).status).toBe(429);
      expect((await list()).status).toBe(200);
      expect(cloudflareCalls).toBe(10);
    });
  });

  it("answers 502 without the provider's text, and marks the connection invalid on a 401", async () => {
    cloudflareStatus = 401;
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const out = await list();
    err.mockRestore();
    expect(out.status).toBe(502);
    expect(out.body.error).toBe("Could not read the account's resources");
    expect(out.body.requestId).toEqual(expect.any(String));
    expect(h.connUpdateMany.mock.calls[0][0]).toMatchObject({ where: { id: "cf-conn" }, data: { status: "invalid" } });
  });

  it("does not mark the connection on a 5xx, and caches no failure", async () => {
    cloudflareStatus = 503;
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await list()).status).toBe(502);
    err.mockRestore();
    expect(h.connUpdateMany).not.toHaveBeenCalled();
    cloudflareStatus = 200;
    expect((await list()).status).toBe(200);
  });
});

// -- POST /connections/:id/adopt ----------------------------------------------------------

describe("POST /connections/:id/adopt", () => {
  const backend = { kind: "r2", bucket: "acme-state", key: "cf/terraform.tfstate", accountId: "0123456789abcdef0123456789abcdef" };
  const target = { kind: "new", name: "acme-cf", repo: "acme/infra", path: "infra/cf", backend };
  const zones = [
    { type: "cloudflare:zone", providerId: ZONE_1 },
    { type: "cloudflare:zone", providerId: ZONE_2 },
  ];
  const adopt = (body: unknown, more: { id?: string; orgId?: string } = {}) => call("post", "/:id/adopt", { body, ...more });

  it("opens an adoption of exactly the picked resources, linked to the connection, with pending ledger rows", async () => {
    const out = await adopt({ resources: zones, target });
    expect(out.status).toBe(202);
    expect(out.body).toMatchObject({ projectId: "p-new", projectName: "acme-cf", jobId: "job-new", adopted: 2, replayed: false });

    const project = h.projectCreate.mock.calls[0][0].data;
    expect(project).toMatchObject({ orgId: "org-a", source: "imported", providerConnectionId: "cf-conn", destPath: "infra/cf", assessmentId: null });
    expect(project.importJson.generateConfig).toBe(true);

    const files = h.jobCreate.mock.calls[0][0].data.argumentsJson.adoptFiles as { path: string; content: string }[];
    expect(files.map((f) => f.path)).toEqual(["versions.tf", "provider.tf", "imports.tf"]);
    expect(files[2]!.content).toContain(`id = "${ZONE_1}"`);
    expect(files[2]!.content).toContain(`id = "${ZONE_2}"`);
    expect(files[2]!.content).not.toContain("dns_record");

    const rows = h.ledgerCreateMany.mock.calls[0][0].data as Record<string, string>[];
    expect(rows.map((r) => [r.resourceType, r.providerId, r.terraformAddress, r.status, r.providerConnectionId])).toEqual([
      ["cloudflare:zone", ZONE_1, "cloudflare_zone.example_com", "pending", "cf-conn"],
      ["cloudflare:zone", ZONE_2, "cloudflare_zone.example_org", "pending", "cf-conn"],
    ]);
    expect(h.runJob).toHaveBeenCalledWith("job-new");
  });

  it("404s another org's connection and creates nothing", async () => {
    const out = await adopt({ resources: zones, target }, { orgId: "org-b" });
    expect(out.status).toBe(404);
    expect(h.projectCreate).not.toHaveBeenCalled();
  });

  it("refuses a resource the account does not have, by key", async () => {
    const out = await adopt({ resources: [...zones, { type: "cloudflare:zone", providerId: "gone" }], target });
    expect(out.status).toBe(400);
    expect(out.body.missing).toEqual([{ type: "cloudflare:zone", providerId: "gone" }]);
    expect(h.projectCreate).not.toHaveBeenCalled();
  });

  it("409s a resource a project already manages, before opening anything", async () => {
    h.ledgerFindMany.mockResolvedValue([{ resourceType: "cloudflare:zone", providerId: ZONE_1 }]);
    const out = await adopt({ resources: zones, target });
    expect(out.status).toBe(409);
    expect(h.projectCreate).not.toHaveBeenCalled();
  });

  it("409s when another request reserved the same resource first, and queues no job", async () => {
    h.ledgerCreateMany.mockRejectedValue(new Prisma.PrismaClientKnownRequestError("unique", { code: "P2002", clientVersion: "6" }));
    const out = await adopt({ resources: zones, target });
    expect(out.status).toBe(409);
    expect(out.body.error).toContain("already managed");
    expect(h.jobCreate).not.toHaveBeenCalled();
    expect(h.runJob).not.toHaveBeenCalled();
  });

  it("answers the same request again with the project it made (200, replayed), opening nothing new", async () => {
    h.projectFindFirst.mockResolvedValue({
      id: "p-new",
      name: "acme-cf",
      destPath: "infra/cf",
      managedResources: zones.map((z) => ({ resourceType: z.type, providerId: z.providerId })),
    });
    h.jobFindFirst.mockResolvedValue({ id: "job-new", status: "running" });
    const out = await adopt({ resources: [...zones].reverse(), target });
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ projectId: "p-new", jobId: "job-new", jobStatus: "running", replayed: true });
    expect(h.projectFindFirst.mock.calls[0][0].where).toMatchObject({ orgId: "org-a", name: "acme-cf", providerConnectionId: "cf-conn" });
    expect(h.projectCreate).not.toHaveBeenCalled();
    expect(cloudflareCalls).toBe(0);
  });

  it("does not replay onto a project of that name holding other resources: the name conflicts", async () => {
    h.projectFindFirst.mockResolvedValue({
      id: "p-old",
      name: "acme-cf",
      destPath: "infra/cf",
      managedResources: [{ resourceType: "cloudflare:zone", providerId: ZONE_1 }],
    });
    h.projectCreate.mockRejectedValue(new Prisma.PrismaClientKnownRequestError("unique", { code: "P2002", clientVersion: "6" }));
    const out = await adopt({ resources: zones, target });
    expect(out.status).toBe(409);
    expect(out.body.error).toBe("a project named acme-cf already exists");
  });

  describe("into an existing project", () => {
    const existing = { kind: "existing", projectId: "p-old" };

    it("404s a project of another org", async () => {
      h.projectFindFirst.mockResolvedValue(null);
      const out = await adopt({ resources: zones, target: existing });
      expect(out.status).toBe(404);
      expect(h.projectFindFirst.mock.calls[0][0].where).toEqual({ id: "p-old", orgId: "org-a" });
    });

    it("409s a project that manages another account", async () => {
      h.projectFindFirst.mockResolvedValue({ id: "p-old", name: "old", providerConnectionId: "other-conn" });
      const out = await adopt({ resources: zones, target: existing });
      expect(out.status).toBe(409);
      expect(out.body.error).toContain("does not manage this account");
    });

    it("409s for now, saying why, even for the right account", async () => {
      h.projectFindFirst.mockResolvedValue({ id: "p-old", name: "old", providerConnectionId: "cf-conn" });
      const out = await adopt({ resources: zones, target: existing });
      expect(out.status).toBe(409);
      expect(out.body.error).toContain("not supported yet");
      expect(h.jobCreate).not.toHaveBeenCalled();
    });
  });

  it.each([
    ["no resources", { resources: [], target }],
    ["more than the cap", { resources: Array.from({ length: 201 }, (_, i) => ({ type: "cloudflare:zone", providerId: `z${i}` })), target }],
    ["an unsafe path", { resources: zones, target: { ...target, path: "infra/$(x)" } }],
    ["a bad project name", { resources: zones, target: { ...target, name: "Acme CF" } }],
  ])("400s %s before calling anything", async (_label, body) => {
    expect((await adopt(body)).status).toBe(400);
    expect(cloudflareCalls).toBe(0);
  });
});
