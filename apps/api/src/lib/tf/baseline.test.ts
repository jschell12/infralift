import { describe, expect, it } from "vitest";
import type { Provider } from "@infralift/shared";
import { buildDemoHerokuAssessment, buildDemoVercelAssessment } from "../demo-fixture.js";
import { PROVIDER_VERSIONS, REQUIRED_VERSION, providerVersion } from "./baseline.js";
import { generateHcl, providerSource } from "./codegen.js";
import { renderProviderFile } from "./render.js";

// The baseline is the one place versions live (ADR 0012). These tests read
// what codegen and the template renderer actually write and hold it to the
// baseline; catalog.test.ts does the same for the catalog stacks on disk, and
// adopt.test.ts for adoption's floor.

/** Every `source = "..."` / `version = "..."` pair in an HCL file. */
const pins = (hcl: string) =>
  [...hcl.matchAll(/source\s+=\s+"([^"]+)"\s*\n\s*version\s+=\s+"([^"]+)"/g)].map((m) => ({ source: m[1], version: m[2] }));

const versionsTf = (files: { fileName: string; content: string }[]) => files.find((f) => f.fileName === "versions.tf")!.content;

describe("providerVersion", () => {
  it("returns the baseline's pin for a listed source", () => {
    expect(providerVersion("hashicorp/aws")).toBe("~> 6.73.0");
    expect(providerVersion("cloudflare/cloudflare")).toBe(PROVIDER_VERSIONS["cloudflare/cloudflare"]);
  });

  it("refuses a source the baseline does not list, rather than writing it unpinned", () => {
    expect(() => providerVersion("hashicorp/random")).toThrow(/no pin for provider hashicorp\/random/);
    expect(() => providerVersion("")).toThrow();
  });
});

describe("codegen reads the baseline", () => {
  const providers: Provider[] = ["vercel", "heroku", "render", "digitalocean", "firebase", "gcp", "aws", "azure", "cloudflare", "netlify"];

  it.each(providers)("%s: providerSource carries the baseline's version for its source", (provider) => {
    const src = providerSource(provider)!;
    expect(src, provider).not.toBeNull();
    expect(src.version).toBe(PROVIDER_VERSIONS[src.source]);
  });

  it("writes the generated floor and baseline pins into versions.tf, source and target providers alike", () => {
    // The Heroku demo has a Postgres and a Redis, so the Hetzner target pulls
    // in hcloud, neon and upstash beside heroku itself.
    const files = generateHcl({
      provider: "heroku",
      inventory: buildDemoHerokuAssessment().inventory,
      backend: "local",
      migrationTarget: "hetzner",
    });
    const hcl = versionsTf(files);
    expect(hcl).toContain(`required_version = "${REQUIRED_VERSION.generated}"`);
    const found = pins(hcl);
    expect(found.map((p) => p.source).sort()).toEqual(["heroku/heroku", "hetznercloud/hcloud", "kislerdm/neon", "upstash/upstash"]);
    for (const p of found) expect(p.version, p.source).toBe(PROVIDER_VERSIONS[p.source]);
  });

  it("gives a Cloudflare target the same cloudflare pin the catalog stacks use", () => {
    const files = generateHcl({
      provider: "vercel",
      inventory: buildDemoVercelAssessment().inventory,
      backend: "local",
      migrationTarget: "cloudflare",
    });
    const found = pins(versionsTf(files));
    expect(found).toContainEqual({ source: "cloudflare/cloudflare", version: PROVIDER_VERSIONS["cloudflare/cloudflare"] });
    for (const p of found) expect(p.version, p.source).toBe(PROVIDER_VERSIONS[p.source]);
  });

  it("template projects' provider.tf takes the generated floor too", () => {
    const hcl = renderProviderFile({ name: "aws", source: "hashicorp/aws", version: "~> 6.73.0", region: "us-east-1" });
    expect(hcl).toContain(`required_version = "${REQUIRED_VERSION.generated}"`);
  });
});
