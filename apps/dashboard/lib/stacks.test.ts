import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isAppStack, newProjectStacks, type Stack } from "./stacks";

// The catalog stack as GET /tf/stacks sends it: the real stack.json, mapped
// field for field the way listStackSummaries() in
// apps/api/src/services/stacks.ts does (gitHosts comes from the deliveries).
const manifest = JSON.parse(
  readFileSync(join(process.cwd(), "../api/stacks/app-foundry-hetzner/stack.json"), "utf8")
) as Stack & { deliveries: Stack["deliveries"] };
const appFoundry: Stack = {
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

// No catalog stack is infrastructure-only yet (ADR 0010), so this one is made
// up: the real stack with its app template removed and a new slug. It is the
// shape a team stack's summary already has (summary() in
// apps/api/src/services/team-stacks.ts carries no template).
const infraOnly: Stack = { ...appFoundry, slug: "postgres-backups", name: "Postgres with backups", template: undefined };

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

  it("offers nothing for an empty catalog", () => {
    expect(newProjectStacks([])).toEqual([]);
  });
});
