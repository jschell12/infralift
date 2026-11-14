import { describe, expect, it } from "vitest";
import {
  DEFAULT_ENDPOINTS,
  ENDPOINT_SPECS,
  EndpointOverrideRefused,
  InvalidEndpoint,
  resolveEndpoints,
} from "./endpoints.js";

describe("resolveEndpoints", () => {
  it("uses the real vendor endpoints when nothing is set", () => {
    const { endpoints, overridden } = resolveEndpoints({});
    expect(endpoints).toEqual(DEFAULT_ENDPOINTS);
    expect(overridden).toEqual([]);
    expect(endpoints.githubApi).toBe("https://api.github.com");
    expect(endpoints.cloudflareApi).toBe("https://api.cloudflare.com/client/v4");
    // AWS has no single URL: null leaves the SDK on its regional endpoints.
    expect(endpoints.aws).toBeNull();
  });

  it("takes an override from its variable and drops a trailing slash", () => {
    const { endpoints, overridden } = resolveEndpoints({
      NODE_ENV: "test",
      INFRALIFT_ENDPOINT_GITHUB_API: "http://127.0.0.1:4010/",
      INFRALIFT_ENDPOINT_AWS: "http://localhost:5000",
    });
    expect(endpoints.githubApi).toBe("http://127.0.0.1:4010");
    expect(endpoints.aws).toBe("http://localhost:5000");
    expect(endpoints.cloudflareApi).toBe(DEFAULT_ENDPOINTS.cloudflareApi);
    expect(overridden.sort()).toEqual(["INFRALIFT_ENDPOINT_AWS", "INFRALIFT_ENDPOINT_GITHUB_API"]);
  });

  it("treats an empty or blank variable as unset", () => {
    const { endpoints, overridden } = resolveEndpoints({ INFRALIFT_ENDPOINT_GITHUB_API: "  " });
    expect(endpoints.githubApi).toBe("https://api.github.com");
    expect(overridden).toEqual([]);
  });

  it.each(["not a url", "ftp://example.com", "file:///etc/passwd", "javascript:alert(1)"])(
    "refuses %s as an endpoint",
    (value) => {
      expect(() => resolveEndpoints({ INFRALIFT_ENDPOINT_CLOUDFLARE_API: value })).toThrow(InvalidEndpoint);
    }
  );

  it("refuses any override in production, naming the variables and not their values", () => {
    const env = { NODE_ENV: "production", INFRALIFT_ENDPOINT_GITHUB_API: "http://evil.example:9999" };
    expect(() => resolveEndpoints(env)).toThrow(EndpointOverrideRefused);
    try {
      resolveEndpoints(env);
    } catch (err) {
      expect((err as Error).message).toContain("INFRALIFT_ENDPOINT_GITHUB_API");
      expect((err as Error).message).not.toContain("evil.example");
    }
  });

  it("allows production with no override at all", () => {
    expect(resolveEndpoints({ NODE_ENV: "production" }).endpoints).toEqual(DEFAULT_ENDPOINTS);
  });

  it("has no bypass: production refuses an override whatever else is set", () => {
    const env = { NODE_ENV: "production", INFRALIFT_ENDPOINT_GITHUB_API: "http://localhost:4010" };
    for (const extra of [{ INFRALIFT_E2E: "1" }, { E2E: "1" }, { CI: "true" }]) {
      expect(() => resolveEndpoints({ ...env, ...extra })).toThrow(EndpointOverrideRefused);
    }
  });

  it("allows overrides only when NODE_ENV is exactly development or test", () => {
    for (const NODE_ENV of ["development", "test"]) {
      expect(resolveEndpoints({ NODE_ENV, INFRALIFT_ENDPOINT_VERCEL_API: "http://localhost:1" }).endpoints.vercelApi).toBe(
        "http://localhost:1"
      );
    }
  });

  it("denies by default: unset, empty or any other NODE_ENV refuses an override", () => {
    for (const NODE_ENV of [undefined, "", "prod", "staging", "Development", "TEST", " development", "development "]) {
      expect(() => resolveEndpoints({ NODE_ENV, INFRALIFT_ENDPOINT_VERCEL_API: "http://localhost:1" }), String(NODE_ENV)).toThrow(
        EndpointOverrideRefused
      );
    }
  });

  it("says which NODE_ENV it saw and which it accepts", () => {
    expect(() => resolveEndpoints({ NODE_ENV: "prod", INFRALIFT_ENDPOINT_GITHUB_API: "http://localhost:1" })).toThrow(
      /NODE_ENV is "prod"; overrides are accepted only when it is "development" or "test"/
    );
    expect(() => resolveEndpoints({ INFRALIFT_ENDPOINT_GITHUB_API: "http://localhost:1" })).toThrow(/NODE_ENV is unset/);
  });

  it("needs no NODE_ENV when nothing is overridden", () => {
    for (const NODE_ENV of [undefined, "production", "prod"]) {
      expect(resolveEndpoints({ NODE_ENV }).endpoints).toEqual(DEFAULT_ENDPOINTS);
    }
  });

  it("points Terraform Cloud at app.terraform.io unless overridden", () => {
    expect(resolveEndpoints({}).endpoints.tfcApi).toBe("https://app.terraform.io/api/v2");
    expect(resolveEndpoints({ NODE_ENV: "test", INFRALIFT_ENDPOINT_TFC_API: "http://127.0.0.1:9/api/v2/" }).endpoints.tfcApi).toBe("http://127.0.0.1:9/api/v2");
  });

  it("treats the older TFC_API_URL as an override under the same rule, not a bypass", () => {
    // It used to be read straight from process.env, outside this guard.
    expect(() => resolveEndpoints({ NODE_ENV: "production", TFC_API_URL: "https://evil.example/api/v2" })).toThrow(EndpointOverrideRefused);
    expect(() => resolveEndpoints({ TFC_API_URL: "https://evil.example/api/v2" })).toThrow(/TFC_API_URL is set while NODE_ENV is unset/);
    expect(() => resolveEndpoints({ NODE_ENV: "test", TFC_API_URL: "ftp://x" })).toThrow(InvalidEndpoint);
    const dev = resolveEndpoints({ NODE_ENV: "development", TFC_API_URL: "http://127.0.0.1:9/api/v2" });
    expect(dev.endpoints.tfcApi).toBe("http://127.0.0.1:9/api/v2");
    expect(dev.overridden).toEqual(["TFC_API_URL"]);
    // Both set: the current name wins, and a refusal names both.
    const both = { INFRALIFT_ENDPOINT_TFC_API: "http://a.test", TFC_API_URL: "http://b.test" };
    expect(resolveEndpoints({ ...both, NODE_ENV: "test" }).endpoints.tfcApi).toBe("http://a.test");
    expect(() => resolveEndpoints({ ...both, NODE_ENV: "prod" })).toThrow(/TFC_API_URL, INFRALIFT_ENDPOINT_TFC_API are set/);
  });

  it("names every variable INFRALIFT_ENDPOINT_*, once", () => {
    const vars = Object.values(ENDPOINT_SPECS).map((s) => s.env);
    expect(new Set(vars).size).toBe(vars.length);
    for (const v of vars) expect(v).toMatch(/^INFRALIFT_ENDPOINT_[A-Z0-9_]+$/);
  });
});
