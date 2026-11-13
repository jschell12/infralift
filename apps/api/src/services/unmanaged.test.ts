import { generateKeyPairSync } from "node:crypto";
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

// GCP: connectors/__fixtures__/gcp-api.json, Google's documented response
// shapes (its _source says so), served to the real gcp connector, which signs
// a JWT with the service account key, so the key is generated here.
const gcp = JSON.parse(readFileSync(new URL("../connectors/__fixtures__/gcp-api.json", import.meta.url), "utf8"));
const GCP_KEY = JSON.stringify({
  type: "service_account",
  project_id: gcp.projectId,
  client_email: `infralift@${gcp.projectId}.iam.gserviceaccount.com`,
  private_key: generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }),
});

// AWS: connectors/__fixtures__/aws-api.json through the real AWS connector
// with hand-mocked SDK clients, as connectors/aws.test.ts does, counting
// Cost Explorer calls.
const aws = JSON.parse(readFileSync(new URL("../connectors/__fixtures__/aws-api.json", import.meta.url), "utf8"));

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
  costExplorerCalls: [] as unknown[],
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
vi.mock("../lib/crypto.js", () => ({ decryptToken: (enc: string) => enc }));
// The org's AWS external id lives on the Org row; this suite has no Org table.
vi.mock("./aws-access.js", () => ({ connectionSecret: async (_org: string, _provider: string, secret: string) => secret }));
// The real AWS connector over mocked SDK clients; every other provider is real.
vi.mock("../connectors/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../connectors/index.js")>();
  const { createAwsConnector } = await import("../connectors/aws.js");
  const { AssumeRoleCommand, GetCallerIdentityCommand } = await import("@aws-sdk/client-sts");
  const fx = JSON.parse((await import("node:fs")).readFileSync(new URL("../connectors/__fixtures__/aws-api.json", import.meta.url), "utf8"));
  const awsUnderTest = createAwsConnector({
    sts: () => ({
      send: async (cmd: unknown) => (cmd instanceof AssumeRoleCommand ? fx.AssumeRole : cmd instanceof GetCallerIdentityCommand ? fx.GetCallerIdentity : undefined),
    }),
    tagging: (region: string) => ({ send: async () => (region === "us-east-1" ? fx.GetResources : { ResourceTagMappingList: [] }) }),
    costExplorer: () => ({
      send: async (cmd: unknown) => {
        h.costExplorerCalls.push(cmd);
        return fx.GetCostAndUsage;
      },
    }),
  } as unknown as Parameters<typeof createAwsConnector>[0]);
  return { ...actual, getConnector: (p: string) => (p === "aws" ? awsUnderTest : actual.getConnector(p as never)) };
});
vi.mock("../lib/jobs/start.js", () => ({ startJob: h.runJob }));

const { connectionsRouter } = await import("../routes/connections.js");
const { INVENTORY_TTL_MS, cloudflareAccountsOf, commonAwsRegion, encodeCursor, resetUnmanagedState, subtractManaged, withKnownAccount } = await import(
  "./unmanaged.js"
);
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
      if (url === "https://oauth2.googleapis.com/token") return json(gcp.token);
      if (url === `https://sqladmin.googleapis.com/v1/projects/${gcp.projectId}/instances`) return json(gcp.sqlInstances);
      if (url === `https://storage.googleapis.com/storage/v1/b?project=${gcp.projectId}`) return json(gcp.buckets);
      if (url.includes("googleapis.com")) return json({ error: { code: 403, status: "PERMISSION_DENIED" } }, 403);
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
const GCP_CONNECTION = { ...CONNECTION, id: "gcp-conn", provider: "gcp", label: "gcp", encryptedToken: GCP_KEY };
// Production 2026-11-13: a Firebase connection whose stored secret is not a
// service account JSON key logged "inventory of connection ... failed
// (firebase): Firebase connection must be a service account JSON key" and the
// adopt page said "Something went wrong on our side".
const FIREBASE_BAD_KEY = { ...CONNECTION, id: "fb-conn", provider: "firebase", label: "testenv", encryptedToken: "ya29.an-access-token-not-a-key" };
const AWS_CONNECTION = {
  ...CONNECTION,
  id: "aws-conn",
  provider: "aws",
  label: "aws",
  encryptedToken: JSON.stringify({ roleArn: "arn:aws:iam::123456789012:role/infralift-readonly", externalId: "org-external-id-0123456789abcdef" }),
};

/** The org's own connections; any other id or org finds nothing, as the real
 *  org-scoped query would. */
function connections(where: { id?: string; orgId: string; provider?: string }) {
  if (where.orgId !== "org-a") return null;
  if (where.provider === "github") return { id: "gh-conn", orgId: "org-a", provider: "github", encryptedToken: "enc" };
  if (where.id === "cf-conn") return CONNECTION;
  if (where.id === "gcp-conn") return GCP_CONNECTION;
  if (where.id === "fb-conn") return FIREBASE_BAD_KEY;
  if (where.id === "aws-conn") return AWS_CONNECTION;
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
  h.costExplorerCalls.length = 0;
  process.env.INFRALIFT_AWS_ACCOUNT_ID = "999999999999";
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
  delete process.env.INFRALIFT_AWS_ACCOUNT_ID;
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

// -- what the adopt form can fill in --------------------------------------------------------

describe("backend defaults", () => {
  // Items in the shape the Cloudflare connector writes: an account-scoped
  // resource carries metadata.accountId and metadata.accountName.
  const A = "0123456789abcdef0123456789abcdef";
  const B = "fedcba9876543210fedcba9876543210";
  const cfItem = (id: string, accountId: unknown, accountName: unknown = null): ResourceInventoryItem => ({
    provider: "cloudflare",
    type: "cloudflare:r2_bucket",
    externalId: id,
    name: id,
    metadata: { accountId, accountName },
  });
  const r2 = { kind: "r2" as const, bucket: "acme-state", key: "cf/terraform.tfstate" };

  it("lists each account once, in the order seen, keeping the first name found", () => {
    const items = [cfItem("a1", A), cfItem("b1", B, "Staging"), cfItem("a2", A, "Production"), cfItem("a3", A, "Other")];
    expect(cloudflareAccountsOf(items)).toEqual([
      { id: A, name: "Production" },
      { id: B, name: "Staging" },
    ]);
  });

  it("ignores an item without a well-formed account id, such as a DNS record", () => {
    expect(cloudflareAccountsOf([cfItem("x", null), cfItem("y", "not-an-id"), cfItem("z", A.toUpperCase())])).toEqual([]);
  });

  it("fills the account id only when the request leaves it out and exactly one account is known", () => {
    expect(withKnownAccount("cloudflare", r2, [cfItem("a1", A)])).toEqual({ ...r2, accountId: A });
    expect(withKnownAccount("cloudflare", { ...r2, accountId: B }, [cfItem("a1", A)])).toEqual({ ...r2, accountId: B });
    expect(withKnownAccount("cloudflare", r2, [])).toEqual(r2);
  });

  it("refuses to guess between several accounts", () => {
    expect(() => withKnownAccount("cloudflare", r2, [cfItem("a1", A), cfItem("b1", B)])).toThrow(/2 Cloudflare accounts/);
  });

  it("leaves an S3 backend, and any other provider's connection, alone", () => {
    const s3 = { kind: "s3" as const, bucket: "acme-state", key: "k", region: "us-east-1" };
    expect(withKnownAccount("cloudflare", s3, [cfItem("a1", A)])).toEqual(s3);
    expect(withKnownAccount("aws", r2, [cfItem("a1", A)])).toEqual(r2);
  });

  it("picks the commonest region from AWS ARNs, skipping global resources and breaking ties alphabetically", () => {
    const awsItem = (arn: string, region: string): ResourceInventoryItem => ({
      provider: "aws",
      type: "aws:x",
      externalId: arn,
      name: arn,
      region,
      metadata: { arn },
    });
    const items = [
      awsItem("arn:aws:iam::123456789012:role/a", "eu-west-1"),
      awsItem("arn:aws:iam::123456789012:role/b", "eu-west-1"),
      awsItem("arn:aws:ec2:us-west-2:123456789012:instance/i-1", "us-west-2"),
      awsItem("arn:aws:ec2:eu-central-1:123456789012:instance/i-2", "eu-central-1"),
    ];
    expect(commonAwsRegion(items)).toBe("eu-central-1");
    expect(commonAwsRegion([...items, awsItem("arn:aws:rds:us-west-2:123456789012:db:x", "us-west-2")])).toBe("us-west-2");
    expect(commonAwsRegion([])).toBeNull();
  });
});

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

  it("names the Cloudflare account the inventory found, for the R2 backend's account id", async () => {
    const out = await list();
    // One account in the fixture; the account list's name wins over the name
    // the zone payload carries for the same id, because it is seen first.
    expect(out.body.backendDefaults).toEqual({
      cloudflareAccounts: [{ id: cf.accounts.result[0].id, name: cf.accounts.result[0].name }],
      awsRegion: null,
    });
  });

  it("offers the region most of an AWS account's resources are in, for an S3 backend", async () => {
    const out = await list({}, { id: "aws-conn" });
    expect(out.body.backendDefaults).toEqual({ cloudflareAccounts: [], awsRegion: "us-east-1" });
  });

  it("reads an AWS account without calling Cost Explorer, which bills per request", async () => {
    const out = await list({}, { id: "aws-conn" });
    expect(out.status).toBe(200);
    expect((out.body.resources as Row[]).map((r) => r.type)).toContain("aws:ec2_instance");
    expect(h.costExplorerCalls).toHaveLength(0);
    await list({ refresh: "1" }, { id: "aws-conn" });
    expect(h.costExplorerCalls).toHaveLength(0);
  });

  it("answers 409 with our sentence and the replace code on a 401, never the provider's text, and marks the connection invalid", async () => {
    cloudflareStatus = 401;
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const out = await list();
    err.mockRestore();
    expect(out.status).toBe(409);
    expect(out.body).toEqual({
      error: "infralift couldn't read this account: Cloudflare refused the saved credential. Replace it on Connections.",
      code: "connection_credential",
      connectionId: "cf-conn",
    });
    expect(h.connUpdateMany.mock.calls[0][0]).toMatchObject({ where: { id: "cf-conn" }, data: { status: "invalid" } });
  });

  it("answers 409 naming the kind of key expected when the stored credential is not one, without calling Google", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const out = await list({}, { id: "fb-conn" });
    const logged = err.mock.calls.map((c) => c.join(" ")).join("\n");
    err.mockRestore();
    expect(out.status).toBe(409);
    expect(out.body).toEqual({
      error: "infralift couldn't read this account: the saved credential isn't a service account key. Replace it on Connections.",
      code: "connection_credential",
      connectionId: "fb-conn",
    });
    // Neither the response nor the log carries the stored secret.
    expect(JSON.stringify(out.body)).not.toContain("ya29");
    expect(logged).not.toContain("ya29");
    expect(logged).toContain("Firebase connection must be a service account JSON key");
    expect(h.connUpdateMany.mock.calls[0][0]).toEqual({
      where: { id: "fb-conn" },
      data: { status: "invalid", lastError: "the saved credential isn't a service account key; replace it" },
    });
    const urls = vi.mocked(fetch).mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("googleapis.com"))).toBe(false);
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

  it("fills in an R2 backend's account id from the connection's only Cloudflare account", async () => {
    const { accountId: _omitted, ...noAccount } = backend;
    const out = await adopt({ resources: zones, target: { ...target, backend: noAccount } });
    expect(out.status).toBe(202);
    const files = h.jobCreate.mock.calls[0][0].data.argumentsJson.adoptFiles as { path: string; content: string }[];
    const account = cf.accounts.result[0].id as string;
    expect(files.some((f) => f.content.includes(`https://${account}.r2.cloudflarestorage.com`))).toBe(true);
  });

  it("keeps an R2 account id the request names, even when the connection sees another", async () => {
    expect((await adopt({ resources: zones, target })).status).toBe(202);
    const files = h.jobCreate.mock.calls[0][0].data.argumentsJson.adoptFiles as { path: string; content: string }[];
    expect(files.some((f) => f.content.includes(`https://${backend.accountId}.r2.cloudflarestorage.com`))).toBe(true);
    expect(files.some((f) => f.content.includes(`https://${cf.accounts.result[0].id}.r2.cloudflarestorage.com`))).toBe(false);
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

  it("answers as a replay when an identical request won the race to create the project", async () => {
    h.projectFindFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: "p-won",
      name: "acme-cf",
      destPath: "infra/cf",
      managedResources: zones.map((z) => ({ resourceType: z.type, providerId: z.providerId })),
    });
    h.jobFindFirst.mockResolvedValue({ id: "job-won", status: "pending" });
    h.projectCreate.mockRejectedValue(new Prisma.PrismaClientKnownRequestError("unique", { code: "P2002", clientVersion: "6" }));
    const out = await adopt({ resources: zones, target });
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ projectId: "p-won", jobId: "job-won", replayed: true });
    expect(h.jobCreate).not.toHaveBeenCalled();
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

  describe("on GCP", () => {
    const sql = { type: "gcp:cloud_sql", providerId: "orders-db" };

    it("lists the project item as not adoptable, and Cloud SQL as adoptable", async () => {
      const out = await list({}, { id: "gcp-conn" });
      const rows = out.body.resources as Row[];
      expect(rows.find((r) => r.type === "gcp:project")).toMatchObject({ providerId: gcp.projectId, adoptable: false });
      expect(rows.find((r) => r.type === "gcp:cloud_sql")).toMatchObject({ adoptable: true, terraformType: "google_sql_database_instance" });
    });

    it("names the project in the provider block though only Cloud SQL was picked", async () => {
      // Cloud SQL imports by bare instance name, which resolves against the
      // provider's project; without it the import plan fails.
      const out = await adopt({ resources: [sql], target: { ...target, name: "acme-gcp", path: "infra/gcp" } }, { id: "gcp-conn" });
      expect(out.status).toBe(202);
      const files = h.jobCreate.mock.calls[0][0].data.argumentsJson.adoptFiles as { path: string; content: string }[];
      const provider = files.find((f) => f.path === "provider.tf")!.content;
      expect(provider).toContain(`project = "${gcp.projectId}"`);
      const imports = files.find((f) => f.path === "imports.tf")!.content;
      expect(imports).toContain('id = "orders-db"');
      expect(imports).not.toContain("google_storage_bucket");
      expect((h.ledgerCreateMany.mock.calls[0][0].data as { resourceType: string }[]).map((r) => r.resourceType)).toEqual(["gcp:cloud_sql"]);
    });

    it("refuses the project item itself, with the reason", async () => {
      const out = await adopt({ resources: [{ type: "gcp:project", providerId: gcp.projectId }], target }, { id: "gcp-conn" });
      expect(out.status).toBe(400);
      expect(out.body.refused).toEqual([{ type: "gcp:project", providerId: gcp.projectId, reason: "no Terraform import mapping for this kind yet" }]);
    });
  });

  it("reports how many distinct resources a replay holds, not how many keys were sent", async () => {
    h.projectFindFirst.mockResolvedValue({
      id: "p-new",
      name: "acme-cf",
      destPath: "infra/cf",
      managedResources: zones.map((z) => ({ resourceType: z.type, providerId: z.providerId })),
    });
    h.jobFindFirst.mockResolvedValue({ id: "job-new", status: "running" });
    const out = await adopt({ resources: [...zones, ...zones], target });
    expect(out.body).toMatchObject({ replayed: true, adopted: 2 });
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
