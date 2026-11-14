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

  it("allows overrides outside production", () => {
    for (const NODE_ENV of [undefined, "development", "test"]) {
      expect(resolveEndpoints({ NODE_ENV, INFRALIFT_ENDPOINT_VERCEL_API: "http://localhost:1" }).endpoints.vercelApi).toBe(
        "http://localhost:1"
      );
    }
  });

  it("names every variable INFRALIFT_ENDPOINT_*, once", () => {
    const vars = Object.values(ENDPOINT_SPECS).map((s) => s.env);
    expect(new Set(vars).size).toBe(vars.length);
    for (const v of vars) expect(v).toMatch(/^INFRALIFT_ENDPOINT_[A-Z0-9_]+$/);
  });
});
