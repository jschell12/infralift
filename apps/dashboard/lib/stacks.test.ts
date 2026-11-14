import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isAppStack, newProjectStacks, toSettings, type Stack } from "./stacks";

// Catalog stacks as GET /tf/stacks sends them: the real stack.json, mapped
// field for field the way listStackSummaries() in
// apps/api/src/services/stacks.ts does (gitHosts comes from the deliveries).
function catalogStack(slug: string): Stack {
  const manifest = JSON.parse(
    readFileSync(join(process.cwd(), `../api/stacks/${slug}/stack.json`), "utf8")
  ) as Stack & { deliveries: Stack["deliveries"] };
  return {
    slug: manifest.slug,
    name: manifest.name,
    description: manifest.description,
    template: manifest.template,
    target: manifest.target,
    runtime: manifest.runtime,
    deliveries: manifest.deliveries,
    gitHosts: [...new Set(manifest.deliveries.map((d) => d.gitHost))],
    inputSchema: manifest.inputSchema,
    example: manifest.example,
  };
}
const appFoundry = catalogStack("app-foundry-hetzner");
const infraStacks = ["network-baseline", "postgres-with-backups", "static-site-cdn"].map(catalogStack);
const infraOnly = infraStacks[1];

describe("new projects do not offer app stacks (ADR 0010)", () => {
  it("reads the real catalog stack, so the test fails if its shape moves", () => {
    expect(appFoundry.slug).toBe("app-foundry-hetzner");
    expect(appFoundry.template?.repo).toBeTruthy();
  });

  it("hides app-foundry-hetzner", () => {
    expect(isAppStack(appFoundry)).toBe(true);
    expect(newProjectStacks([appFoundry])).toEqual([]);
  });

  it("hides app-foundry-hetzner by name even without its template", () => {
    expect(isAppStack({ slug: "app-foundry-hetzner", template: undefined })).toBe(true);
  });

  it("hides any other stack that carries an app template", () => {
    expect(isAppStack({ ...appFoundry, slug: "another-app" })).toBe(true);
  });

  it("keeps a stack with no app template", () => {
    expect(isAppStack(infraOnly)).toBe(false);
    expect(newProjectStacks([appFoundry, infraOnly])).toEqual([infraOnly]);
  });

  it("offers every infrastructure stack in the catalog, and only those", () => {
    for (const s of infraStacks) expect(isAppStack(s), s.slug).toBe(false);
    expect(newProjectStacks([appFoundry, ...infraStacks]).map((s) => s.slug)).toEqual([
      "network-baseline",
      "postgres-with-backups",
      "static-site-cdn",
    ]);
  });

  it("offers nothing for an empty catalog", () => {
    expect(newProjectStacks([])).toEqual([]);
  });
});

describe("toSettings", () => {
  it("sends a boolean setting as a boolean, which the schema requires", () => {
    const network = infraStacks[0];
    expect(toSettings(network.inputSchema, { single_nat: "false", az_count: "3", name: "aws-prod" })).toEqual({
      single_nat: false,
      az_count: 3,
      name: "aws-prod",
    });
    expect(toSettings(network.inputSchema, { single_nat: "true" })).toEqual({ single_nat: true });
    expect(toSettings(network.inputSchema, { single_nat: "" })).toEqual({});
  });
});
