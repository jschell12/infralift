import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { vercelConnector } from "./vercel.js";
import { cloudflareConnector } from "./cloudflare.js";
import { herokuConnector } from "./heroku.js";
import { firebaseConnector } from "./firebase.js";
import { githubConnector, parseGithubExpiration } from "./github.js";
import { readFileSync } from "node:fs";
import { netlifyConnector } from "./netlify.js";
import { renderConnector } from "./render.js";
import { railwayConnector } from "./railway.js";
import { flyioConnector } from "./flyio.js";
import { digitaloceanConnector } from "./digitalocean.js";
import { gcpConnector } from "./gcp.js";
import { azureConnector } from "./azure.js";
import { getConnector } from "./index.js";

const cfVerify = JSON.parse(
  readFileSync(new URL("./__fixtures__/cloudflare-token-verify.json", import.meta.url), "utf8")
);

// ---------------------------------------------------------------------------
// Shared fetch mock helpers
// ---------------------------------------------------------------------------

let fetchMock: Mock;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

function ok(body: unknown) {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  });
}

function fail(status = 401) {
  return Promise.resolve({
    ok: false,
    status,
    json: () => Promise.resolve({ error: "unauthorized" }),
  });
}

/** Match a fetch call by URL substring. */
function mockRoute(
  routes: Record<string, unknown>,
  fallbackStatus = 404
) {
  fetchMock.mockImplementation((url: string) => {
    for (const [pattern, body] of Object.entries(routes)) {
      if (url.includes(pattern)) return ok(body);
    }
    return fail(fallbackStatus);
  });
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

describe("getConnector", () => {
  it("returns a connector for every provider", () => {
    const providers = [
      "vercel", "cloudflare", "heroku", "aws", "firebase", "github",
      "netlify", "render", "railway", "flyio", "digitalocean", "gcp", "azure",
    ] as const;
    for (const p of providers) {
      const c = getConnector(p);
      expect(c).toBeDefined();
      expect(c.provider).toBe(p);
    }
  });
});

// ---------------------------------------------------------------------------
// Vercel
// ---------------------------------------------------------------------------

describe("vercel", () => {
  it("verify returns true on 200", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });
    expect(await vercelConnector.verify("tok")).toBe(true);
  });

  it("verify returns false on 401", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 401 });
    expect(await vercelConnector.verify("bad")).toBe(false);
  });

  it("assess inventories projects and domains", async () => {
    mockRoute({
      "/v9/projects": {
        projects: [
          { id: "p1", name: "my-app", framework: "nextjs", env: [{ key: "A" }] },
        ],
      },
      "/v5/domains": { domains: [{ id: "d1", name: "example.com" }] },
    });

    const result = await vercelConnector.assess("tok");
    expect(result.inventory).toHaveLength(2);
    expect(result.inventory[0].type).toBe("vercel:project");
    expect(result.inventory[1].type).toBe("vercel:domain");
    expect(result.findings.some((f) => f.category === "cost")).toBe(true);
    expect(result.findings.some((f) => f.title.includes("Next.js"))).toBe(true);
    expect(result.estimatedMonthlyCostCents).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Cloudflare
// ---------------------------------------------------------------------------

describe("cloudflare", () => {
  it("verify checks token status", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ result: { status: "active" } }),
    });
    expect(await cloudflareConnector.verify("tok")).toBe(true);
  });

  it("check reads expires_on from the verify response", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(cfVerify.active), { status: 200 }));
    expect(await cloudflareConnector.check!("tok")).toEqual({
      valid: true,
      reason: null,
      expiresAt: new Date("2020-01-01T00:00:00Z"),
    });
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(cfVerify.noExpiry), { status: 200 }));
    expect((await cloudflareConnector.check!("tok")).expiresAt).toBeNull();
  });

  it("check gives Cloudflare's own reason for a refused token", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(cfVerify.refused), { status: 401 }));
    expect(await cloudflareConnector.check!("bad")).toEqual({
      valid: false,
      reason: "Cloudflare answered 401: Invalid API Token",
      expiresAt: null,
    });
  });

  it("verify returns false on inactive", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ result: { status: "disabled" } }),
    });
    expect(await cloudflareConnector.verify("tok")).toBe(false);
  });

  it("assess inventories workers, pages, r2, zones", async () => {
    mockRoute({
      "/accounts?": {
        success: true,
        result: [{ id: "acc1" }],
      },
      "/workers/scripts": {
        success: true,
        result: [{ id: "worker-1", modified_on: "2026-01-01" }],
      },
      "/pages/projects": {
        success: true,
        result: [{ name: "pages-1", production_branch: "main" }],
      },
      "/r2/buckets": {
        success: true,
        result: { buckets: [{ name: "bucket-1" }] },
      },
      "/zones?": {
        success: true,
        result: [{ id: "z1", name: "example.com", status: "active", plan: { name: "Free" } }],
      },
    });

    const result = await cloudflareConnector.assess("tok");
    const types = result.inventory.map((i) => i.type);
    expect(types).toContain("cloudflare:worker");
    expect(types).toContain("cloudflare:pages_project");
    expect(types).toContain("cloudflare:r2_bucket");
    expect(types).toContain("cloudflare:zone");
    expect(result.findings.some((f) => f.category === "iac_standard")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Heroku
// ---------------------------------------------------------------------------

describe("heroku", () => {
  it("verify returns true on 200", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });
    expect(await herokuConnector.verify("tok")).toBe(true);
  });

  it("assess inventories apps, dynos, addons with cost", async () => {
    fetchMock.mockImplementation((url: string) => {
      const path = new URL(url).pathname;
      if (path === "/apps") {
        return ok([
          { id: "a1", name: "my-heroku-app", region: { name: "us" }, stack: { name: "heroku-24" } },
        ]);
      }
      if (path.endsWith("/formation")) {
        return ok([{ type: "web", size: "standard-1x", quantity: 2 }]);
      }
      if (path.endsWith("/addons")) {
        return ok([
          {
            id: "addon-1",
            name: "pg",
            addon_service: { name: "heroku-postgresql" },
            billed_price: { cents: 5000 },
            plan: { name: "standard-0" },
          },
        ]);
      }
      return fail(404);
    });

    const result = await herokuConnector.assess("tok");
    expect(result.inventory.some((i) => i.type === "heroku:app")).toBe(true);
    expect(result.inventory.some((i) => i.type === "heroku:dyno")).toBe(true);
    expect(result.inventory.some((i) => i.type === "heroku:addon")).toBe(true);
    expect(result.estimatedMonthlyCostCents).toBeGreaterThan(0);
    // The bill is priced; the saving is not. It comes from the sized
    // comparison (services/assessments.ts), never from the connector.
    expect(result).not.toHaveProperty("estimatedMonthlySavingsCents");
    expect(result.findings.every((f) => f.monthlySavingsCents === undefined)).toBe(true);
    expect(result.findings.some((f) => f.title.includes("Heroku Postgres"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Firebase
// ---------------------------------------------------------------------------

describe("firebase", () => {
  it("verify rejects non-JSON token", async () => {
    expect(await firebaseConnector.verify("not-json")).toBe(false);
  });

  it("verify rejects wrong type field", async () => {
    expect(
      await firebaseConnector.verify(
        JSON.stringify({ type: "authorized_user", project_id: "p", private_key: "k", client_email: "e" })
      )
    ).toBe(false);
  });

  // Full assess test skipped: requires RSA private key for JWT signing.
});

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

describe("github", () => {
  it("verify returns true on 200", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, headers: new Headers() });
    expect(await githubConnector.verify("tok")).toBe(true);
  });

  // GitHub sends github-authentication-token-expiration on every response to
  // a personal access token that has an expiry, and nothing for one without.
  // The header value's shape is GitHub's "YYYY-MM-DD HH:MM:SS UTC" as reported
  // by clients that parse it (composer's diagnose); not captured from a live
  // token here, which is why the parser also takes a numeric offset.
  it("check reads the token's expiry from the verify response header", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("{}", { status: 200, headers: { "github-authentication-token-expiration": "2026-12-01 00:00:00 UTC" } })
    );
    const out = await githubConnector.check!("tok");
    expect(out).toEqual({ valid: true, reason: null, expiresAt: new Date("2026-12-01T00:00:00Z") });
  });

  it("check gives a null expiry without the header, and the reason on a 401", async () => {
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 200 }));
    expect((await githubConnector.check!("tok")).expiresAt).toBeNull();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: "Bad credentials", documentation_url: "https://docs.github.com/rest", status: "401" }), { status: 401 })
    );
    expect(await githubConnector.check!("bad")).toEqual({ valid: false, reason: "GitHub answered 401: Bad credentials", expiresAt: null });
  });

  it("parseGithubExpiration accepts UTC and numeric offsets, and nothing else", () => {
    expect(parseGithubExpiration("2026-12-01 00:00:00 UTC")?.toISOString()).toBe("2026-12-01T00:00:00.000Z");
    expect(parseGithubExpiration("2026-12-01 00:00:00 -0700")?.toISOString()).toBe("2026-12-01T07:00:00.000Z");
    expect(parseGithubExpiration("")).toBeNull();
    expect(parseGithubExpiration(null)).toBeNull();
    expect(parseGithubExpiration("next tuesday")).toBeNull();
  });

  it("assess returns empty", async () => {
    const result = await githubConnector.assess("tok");
    expect(result.inventory).toHaveLength(0);
    expect(result.findings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Netlify
// ---------------------------------------------------------------------------

describe("netlify", () => {
  it("verify returns true on 200", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });
    expect(await netlifyConnector.verify("tok")).toBe(true);
  });

  it("verify returns false on 401", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 401 });
    expect(await netlifyConnector.verify("bad")).toBe(false);
  });

  it("assess inventories sites, dns zones, forms", async () => {
    mockRoute({
      "/sites?": [
        {
          id: "s1",
          name: "my-site",
          build_settings: {
            functions_dir: "netlify/functions",
            repo_url: "https://github.com/org/repo",
          },
        },
      ],
      "/dns_zones": [{ id: "z1", name: "example.com", records: [1, 2] }],
      "/forms?": [{ id: "f1", name: "contact", submission_count: 42 }],
      "/build_hooks": [{ id: "h1" }],
    });

    const result = await netlifyConnector.assess("tok");
    const types = result.inventory.map((i) => i.type);
    expect(types).toContain("netlify:site");
    expect(types).toContain("netlify:dns_zone");
    expect(types).toContain("netlify:form");
    expect(types).toContain("netlify:build_hook");
    expect(result.findings.some((f) => f.title.includes("serverless functions"))).toBe(true);
    expect(result.findings.some((f) => f.category === "risk")).toBe(true);
    expect(result.findings.some((f) => f.category === "cost")).toBe(true);
    expect(result.estimatedMonthlyCostCents).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

describe("render", () => {
  it("verify returns true on 200", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });
    expect(await renderConnector.verify("tok")).toBe(true);
  });

  it("assess inventories services, postgres, redis, env groups with cost", async () => {
    mockRoute({
      "/services?": [
        { service: { id: "svc1", name: "api", type: "web_service", plan: "starter", region: "oregon" } },
      ],
      "/postgres?": [
        { postgres: { id: "db1", name: "main-db", plan: "starter", version: "16", region: "oregon" } },
      ],
      "/redis?": [
        { redis: { id: "r1", name: "cache", plan: "free", region: "oregon" } },
      ],
      "/env-groups?": [
        { envGroup: { id: "eg1", name: "shared", envVars: [{ key: "A" }, { key: "B" }] } },
      ],
    });

    const result = await renderConnector.assess("tok");
    const types = result.inventory.map((i) => i.type);
    expect(types).toContain("render:web_service");
    expect(types).toContain("render:postgres");
    expect(types).toContain("render:redis");
    expect(types).toContain("render:env_group");
    expect(result.estimatedMonthlyCostCents).toBe(700);
    expect(result.findings.some((f) => f.title.includes("Render Postgres"))).toBe(true);
  });

  it("assess prices the services and makes no savings claim of its own", async () => {
    mockRoute({
      "/services?": [
        { service: { id: "svc1", name: "api", type: "web_service", plan: "standard" } },
        { service: { id: "svc2", name: "worker", type: "worker", plan: "standard" } },
      ],
      "/postgres?": [],
      "/redis?": [],
      "/env-groups?": [],
    });

    const result = await renderConnector.assess("tok");
    expect(result.estimatedMonthlyCostCents).toBe(5000);
    // This used to be 3000: the bill minus a flat $20 VPS, whatever the
    // workload. The cost finding still states the bill.
    expect(result).not.toHaveProperty("estimatedMonthlySavingsCents");
    const cost = result.findings.find((f) => f.category === "cost")!;
    expect(cost.title).toContain("$50/mo");
    expect(cost.monthlySavingsCents).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Railway
// ---------------------------------------------------------------------------

describe("railway", () => {
  it("verify returns true when me.id exists", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: { me: { id: "u1" } } }),
    });
    expect(await railwayConnector.verify("tok")).toBe(true);
  });

  it("verify returns false on error", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 401 });
    expect(await railwayConnector.verify("bad")).toBe(false);
  });

  it("assess inventories projects, services, plugins, environments", async () => {
    // Railway uses two GraphQL calls: projects listing, then me.projects for usage
    let callCount = 0;
    fetchMock.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return ok({
          data: {
            projects: {
              edges: [
                {
                  node: {
                    id: "proj1",
                    name: "my-project",
                    description: "test project",
                    services: {
                      edges: [{ node: { id: "svc1", name: "web", icon: null } }],
                    },
                    plugins: {
                      edges: [
                        { node: { id: "pg1", name: "postgresql", friendlyName: "PostgreSQL" } },
                      ],
                    },
                    environments: {
                      edges: [{ node: { id: "env1", name: "production" } }],
                    },
                  },
                },
              ],
            },
          },
        });
      }
      // Second call: me.projects for usage/plan
      return ok({
        data: {
          me: {
            id: "u1",
            projects: {
              edges: [
                { node: { id: "proj1", name: "my-project", subscription: { plan: "hobby" } } },
              ],
            },
          },
        },
      });
    });

    const result = await railwayConnector.assess("tok");
    const types = result.inventory.map((i) => i.type);
    expect(types).toContain("railway:project");
    expect(types).toContain("railway:service");
    expect(types).toContain("railway:plugin");
    expect(types).toContain("railway:environment");
    expect(result.findings.some((f) => f.title.includes("Railway Postgres"))).toBe(true);
    expect(result.findings.some((f) => f.category === "cost")).toBe(true);
    expect(result.estimatedMonthlyCostCents).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// Fly.io
// ---------------------------------------------------------------------------

describe("flyio", () => {
  it("verify returns true when viewer.id exists", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: { viewer: { id: "u1" } } }),
    });
    expect(await flyioConnector.verify("tok")).toBe(true);
  });

  it("verify returns false on error", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 401 });
    expect(await flyioConnector.verify("bad")).toBe(false);
  });

  it("assess inventories apps, machines, volumes", async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes("/graphql")) {
        return ok({
          data: {
            apps: {
              nodes: [
                {
                  id: "app1",
                  name: "my-fly-app",
                  status: "deployed",
                  organization: { slug: "personal" },
                  regions: [{ code: "iad", name: "Ashburn" }],
                },
              ],
            },
          },
        });
      }
      if (url.includes("/machines")) {
        return ok([
          {
            id: "m1",
            state: "started",
            region: "iad",
            config: {
              image: "my-image:latest",
              guest: { cpu_kind: "shared", cpus: 1, memory_mb: 256 },
            },
          },
        ]);
      }
      if (url.includes("/volumes")) {
        return ok([
          { id: "v1", name: "data", region: "iad", size_gb: 10, state: "created", encrypted: true },
        ]);
      }
      return fail(404);
    });

    const result = await flyioConnector.assess("tok");
    const types = result.inventory.map((i) => i.type);
    expect(types).toContain("flyio:app");
    expect(types).toContain("flyio:machine");
    expect(types).toContain("flyio:volume");
    expect(result.estimatedMonthlyCostCents).toBeGreaterThan(0);
    expect(result.findings.some((f) => f.category === "cost")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// DigitalOcean
// ---------------------------------------------------------------------------

describe("digitalocean", () => {
  it("verify returns true on 200", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });
    expect(await digitaloceanConnector.verify("tok")).toBe(true);
  });

  it("assess inventories droplets, apps, databases, domains, k8s", async () => {
    mockRoute({
      "/droplets?": {
        droplets: [
          {
            id: 1,
            name: "web-1",
            size_slug: "s-1vcpu-1gb",
            region: { slug: "nyc1" },
            vcpus: 1,
            memory: 1024,
            disk: 25,
            status: "active",
            image: { slug: "ubuntu-24-04-x64" },
          },
        ],
      },
      "/apps?": {
        apps: [
          {
            id: "app1",
            spec: { name: "my-do-app", services: [{}], static_sites: [] },
            tier_slug: "basic",
            region: { slug: "nyc" },
          },
        ],
      },
      "/databases?": {
        databases: [
          {
            id: "db1",
            name: "pg-main",
            engine: "pg",
            version: "16",
            region: "nyc1",
            size: "db-s-1vcpu-1gb",
            num_nodes: 1,
            status: "online",
          },
        ],
      },
      "/spaces?": { spaces: [] },
      "/domains?": {
        domains: [{ name: "example.com", ttl: 1800 }],
      },
      "/kubernetes/clusters?": { kubernetes_clusters: [] },
      "/account": { account: { email: "test@test.com" } },
    });

    const result = await digitaloceanConnector.assess("tok");
    const types = result.inventory.map((i) => i.type);
    expect(types).toContain("digitalocean:droplet");
    expect(types).toContain("digitalocean:app");
    expect(types).toContain("digitalocean:database");
    expect(types).toContain("digitalocean:domain");
    expect(result.estimatedMonthlyCostCents).toBeGreaterThan(0);
    expect(result.findings.some((f) => f.title.includes("DO Managed Postgres"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// GCP
// ---------------------------------------------------------------------------

describe("gcp", () => {
  it("verify rejects non-JSON token", async () => {
    expect(await gcpConnector.verify("not-json")).toBe(false);
  });

  it("verify rejects wrong type field", async () => {
    expect(
      await gcpConnector.verify(
        JSON.stringify({ type: "authorized_user", project_id: "p", private_key: "k", client_email: "e" })
      )
    ).toBe(false);
  });

  // Full assess test skipped: requires RSA private key for JWT signing.
});

// ---------------------------------------------------------------------------
// Azure
// ---------------------------------------------------------------------------

describe("azure", () => {
  it("verify rejects non-JSON token", async () => {
    expect(await azureConnector.verify("not-json")).toBe(false);
  });

  it("verify rejects incomplete credentials", async () => {
    expect(
      await azureConnector.verify(JSON.stringify({ tenantId: "t" }))
    ).toBe(false);
  });

  it("verify returns false when token exchange fails", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 400 });
    expect(
      await azureConnector.verify(
        JSON.stringify({
          tenantId: "t",
          clientId: "c",
          clientSecret: "s",
          subscriptionId: "sub",
        })
      )
    ).toBe(false);
  });

  it("assess inventories app services, vms, sql, storage", async () => {
    // Token exchange
    fetchMock.mockImplementation((url: string) => {
      if (url.includes("oauth2/v2.0/token")) {
        return ok({ access_token: "mock-token" });
      }
      if (url.includes("Microsoft.Web/sites?")) {
        return ok({
          value: [
            {
              id: "/sub/rg/sites/my-app",
              name: "my-app",
              kind: "app,linux",
              location: "eastus",
              properties: { state: "Running", defaultHostName: "my-app.azurewebsites.net" },
            },
            {
              id: "/sub/rg/sites/my-func",
              name: "my-func",
              kind: "functionapp,linux",
              location: "eastus",
              properties: { state: "Running" },
            },
          ],
        });
      }
      if (url.includes("Microsoft.Web/serverfarms?")) {
        return ok({
          value: [
            {
              id: "/sub/rg/farms/plan1",
              name: "plan1",
              location: "eastus",
              sku: { name: "B1", tier: "Basic", capacity: 1 },
              kind: "linux",
            },
          ],
        });
      }
      if (url.includes("Microsoft.Compute/virtualMachines?")) {
        return ok({
          value: [
            {
              id: "/sub/rg/vms/vm1",
              name: "vm1",
              location: "eastus",
              properties: {
                hardwareProfile: { vmSize: "Standard_B2s" },
                storageProfile: { osDisk: { osType: "Linux" } },
                provisioningState: "Succeeded",
              },
            },
          ],
        });
      }
      if (url.includes("Microsoft.Sql/servers?")) {
        return ok({
          value: [
            {
              id: "/sub/rg/servers/sql1",
              name: "sql1",
              location: "eastus",
              properties: { state: "Ready", version: "12.0" },
            },
          ],
        });
      }
      if (url.includes("/databases?")) {
        return ok({
          value: [
            {
              id: "/sub/rg/servers/sql1/dbs/mydb",
              name: "mydb",
              location: "eastus",
              sku: { name: "S0", tier: "Standard" },
              properties: { status: "Online" },
            },
          ],
        });
      }
      if (url.includes("Microsoft.Storage/storageAccounts?")) {
        return ok({
          value: [
            {
              id: "/sub/rg/storage/st1",
              name: "st1",
              location: "eastus",
              kind: "StorageV2",
              sku: { name: "Standard_LRS", tier: "Standard" },
              properties: { accessTier: "Hot" },
            },
          ],
        });
      }
      return fail(404);
    });

    const result = await azureConnector.assess(
      JSON.stringify({
        tenantId: "t",
        clientId: "c",
        clientSecret: "s",
        subscriptionId: "sub1",
      })
    );
    const types = result.inventory.map((i) => i.type);
    expect(types).toContain("azure:subscription");
    expect(types).toContain("azure:app_service");
    expect(types).toContain("azure:function_app");
    expect(types).toContain("azure:app_service_plan");
    expect(types).toContain("azure:virtual_machine");
    expect(types).toContain("azure:sql_server");
    expect(types).toContain("azure:sql_database");
    expect(types).toContain("azure:storage_account");
    expect(result.findings.some((f) => f.title.includes("Function App"))).toBe(true);
    expect(result.findings.some((f) => f.title.includes("VM(s)"))).toBe(true);
    expect(result.findings.some((f) => f.title.includes("Storage Account"))).toBe(true);
    expect(result.findings.some((f) => f.title.includes("Azure SQL"))).toBe(true);
  });
});
