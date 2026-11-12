import { afterEach, describe, expect, it, vi } from "vitest";
import { PROVIDERS } from "@infralift/shared";
import {
  CONNECTION_TYPES,
  connectionName,
  connectionRequest,
  connectionStatus,
  createConnection,
  isCloudAccount,
} from "./connections";

// Request bodies are checked against the API's own schemas: createSchema in
// apps/api/src/routes/connections.ts ({provider, label, token}) and
// connectionSchema in apps/api/src/routes/workspaces.ts ({label, hostname?,
// organization, token}). Response bodies are the shapes those routes send:
// toSummary() for /connections, and the 201 body POST /workspaces/connections
// builds for Terraform Cloud.

describe("connectionRequest sends each type to the endpoint that stores it", () => {
  it("sends a cloud provider to /connections with provider, label and token", () => {
    expect(connectionRequest("aws", { label: "prod", token: "arn:aws:iam::123456789012:role/r", organization: "x" })).toEqual({
      path: "/connections",
      body: { provider: "aws", label: "prod", token: "arn:aws:iam::123456789012:role/r" },
    });
  });

  it("sends a repository host to /connections too", () => {
    expect(connectionRequest("github", { label: "acme", token: "t" }).path).toBe("/connections");
  });

  it("sends Terraform Cloud to /workspaces/connections with its organization", () => {
    expect(connectionRequest("tfc", { label: "platform", token: "t", organization: "acme" })).toEqual({
      path: "/workspaces/connections",
      body: { label: "platform", organization: "acme", token: "t" },
    });
  });

  it("leaves a blank Terraform Cloud hostname out, and keeps a real one", () => {
    expect(connectionRequest("tfc", { label: "p", token: "t", organization: "a", hostname: "  " }).body).not.toHaveProperty(
      "hostname"
    );
    expect(
      connectionRequest("tfc", { label: "p", token: "t", organization: "a", hostname: "tfe.example.com" }).body.hostname
    ).toBe("tfe.example.com");
  });
});

describe("createConnection posts the request and returns the API's answer", () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubFetch(status: number, body: unknown) {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status }));
    vi.stubGlobal("fetch", fetch);
    return fetch;
  }

  it("posts Terraform Cloud to /api/workspaces/connections", async () => {
    const fetch = stubFetch(201, {
      id: "c_tfc",
      provider: "tfc",
      label: "platform",
      hostname: "app.terraform.io",
      organization: "acme",
      status: "invalid",
    });
    const out = await createConnection("tfc", { label: "platform", token: "t", organization: "acme" });
    expect(out.status).toBe("invalid");
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("/api/workspaces/connections");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ label: "platform", organization: "acme", token: "t" });
  });

  it("posts a provider to /api/connections", async () => {
    const fetch = stubFetch(201, {
      id: "c_cf",
      provider: "cloudflare",
      label: "prod",
      createdAt: "2026-11-11T00:00:00.000Z",
      lastVerifiedAt: "2026-11-11T00:00:00.000Z",
      status: "valid",
      lastError: null,
      expiresAt: null,
    });
    await createConnection("cloudflare", { label: "prod", token: "t" });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("/api/connections");
    expect(JSON.parse(String(init?.body))).toEqual({ provider: "cloudflare", label: "prod", token: "t" });
  });

  it("throws the API's sentence when the label is taken", async () => {
    stubFetch(409, { error: 'a Terraform Cloud connection labelled "platform" already exists' });
    await expect(createConnection("tfc", { label: "platform", token: "t", organization: "acme" })).rejects.toThrow(
      'a Terraform Cloud connection labelled "platform" already exists'
    );
  });
});

describe("the type picker", () => {
  it("offers every provider once, and Terraform Cloud", () => {
    const types = CONNECTION_TYPES.map((t) => t.type);
    expect(new Set(types).size).toBe(types.length);
    expect([...types].sort()).toEqual([...PROVIDERS, "tfc"].sort());
  });

  it("groups Terraform Cloud with the repository hosts, apart from cloud accounts", () => {
    const code = CONNECTION_TYPES.filter((t) => t.group === "code").map((t) => t.type);
    expect(code).toEqual(["tfc", "github", "gitlab"]);
    expect(CONNECTION_TYPES.filter((t) => t.group === "cloud").map((t) => t.type)).toContain("aws");
  });

  it("does not promise read-only use for the types infralift writes with", () => {
    for (const t of CONNECTION_TYPES) expect(t.readOnly, t.type).toBe(t.group === "cloud");
  });

  it("names Terraform Cloud, which PROVIDER_LABELS does not have", () => {
    expect(connectionName("tfc")).toBe("Terraform Cloud");
    expect(connectionName("aws")).toBe("AWS");
  });

  it("treats only cloud providers as accounts a project adopts from", () => {
    expect(isCloudAccount("aws")).toBe(true);
    for (const p of ["tfc", "github", "gitlab", "unknown"]) expect(isCloudAccount(p), p).toBe(false);
  });
});

describe("connectionStatus colors only problems", () => {
  const now = Date.parse("2026-11-11T12:00:00Z");
  const inDays = (d: number) => new Date(now + d * 86_400_000).toISOString();
  const cases: [string, { status: "valid" | "invalid" | "unverified"; expiresAt: string | null }, string, string][] = [
    ["valid with no expiry is a neutral check", { status: "valid", expiresAt: null }, "ok", "valid"],
    ["valid, 14 days left", { status: "valid", expiresAt: inDays(14) }, "ok", "expires in 14 days"],
    ["valid, 13 days left warns", { status: "valid", expiresAt: inDays(13) }, "warn", "expires in 13 days"],
    ["valid, 1 day left", { status: "valid", expiresAt: inDays(1) }, "warn", "expires in 1 day"],
    ["valid but past its expiry", { status: "valid", expiresAt: inDays(-1) }, "danger", "expired"],
    ["invalid", { status: "invalid", expiresAt: null }, "danger", "invalid"],
    ["unverified (a timed-out check)", { status: "unverified", expiresAt: null }, "muted", "unverified"],
  ];
  it.each(cases)("%s", (_name, c, tone, text) => {
    expect(connectionStatus(c, now)).toEqual({ tone, text });
  });
});
