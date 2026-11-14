import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { PROVIDERS, type Provider } from "@infralift/shared";
import { DEFAULT_ENDPOINTS, ENDPOINT_SPECS, resolveEndpoints, type Endpoints } from "../lib/endpoints.js";
import { gitHostClient } from "../lib/git/hosts.js";
import { createConnectorRegistry } from "./index.js";

// Every connector and git host client must call the endpoint it is given and
// nothing else, or the e2e stack (and any test) would quietly reach a real
// vendor. Each endpoint is pointed at its own fake origin, every connector's
// verify and assess runs against a fetch that answers everything, and every
// URL requested must be under an override. AWS is the SDK, not fetch, and is
// covered by aws.test.ts and the e2e suite.

const OVERRIDE_ENV = Object.fromEntries(
  Object.entries(ENDPOINT_SPECS)
    .filter(([name]) => name !== "aws")
    .map(([name, spec]) => [spec.env, `http://${name.toLowerCase()}.override.test/base`])
);
const overridden: Endpoints = resolveEndpoints({ ...OVERRIDE_ENV, NODE_ENV: "test" }).endpoints;
const overrideOrigins = Object.values(OVERRIDE_ENV);

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const googleKey = JSON.stringify({
  type: "service_account",
  project_id: "wiring-test",
  client_email: "wiring@wiring-test.iam.gserviceaccount.com",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
});
const tokenFor: Partial<Record<Provider, string>> = {
  gcp: googleKey,
  firebase: googleKey,
  azure: JSON.stringify({ tenantId: "t", clientId: "c", clientSecret: "s", subscriptionId: "sub" }),
};

let fetchMock: Mock;
beforeEach(() => {
  // A generic success: enough for each connector to take its next call.
  fetchMock = vi.fn(async () =>
    new Response(JSON.stringify({ access_token: "a", success: true, result: [], data: {} }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  );
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const requested = () => fetchMock.mock.calls.map(([input]) => String(input instanceof Request ? input.url : input));

describe("connectors call only the endpoints they are given", () => {
  const registry = createConnectorRegistry(overridden);

  it.each(PROVIDERS.filter((p) => p !== "aws"))("%s", async (provider) => {
    const connector = registry[provider];
    const token = tokenFor[provider] ?? "wiring-token";
    await connector.verify(token).catch(() => {});
    await connector.assess(token, { costs: false }).catch(() => {});
    const urls = requested();
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(overrideOrigins.some((o) => url.startsWith(o)), `${provider} requested ${url}`).toBe(true);
    }
  });

  it("with no overrides, they call the real APIs", async () => {
    const real = createConnectorRegistry(DEFAULT_ENDPOINTS);
    await real.cloudflare.verify("t").catch(() => {});
    await real.github.verify("t").catch(() => {});
    expect(requested()).toEqual([
      "https://api.cloudflare.com/client/v4/user/tokens/verify",
      "https://api.github.com/user",
    ]);
  });
});

describe("git host clients call only the endpoint they are given", () => {
  it.each(["github", "gitlab"] as const)("%s", async (host) => {
    const client = gitHostClient(host, "t", overridden);
    await client.repoExists("acme/infra").catch(() => {});
    await client.fileExists({ repo: "acme/infra", path: "a.tf", branch: "main" }).catch(() => {});
    await client
      .commitFiles({ repo: "acme/infra", branch: "main", workDir: "", files: [{ fileName: "a.tf", content: "" }], message: "m" })
      .catch(() => {});
    const base = host === "github" ? overridden.githubApi : overridden.gitlabApi;
    const urls = requested();
    expect(urls.length).toBeGreaterThan(2);
    for (const url of urls) expect(url.startsWith(base), url).toBe(true);
  });
});
