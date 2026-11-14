import { describe, expect, it } from "vitest";
import { composeExports, OFFSETS, stackLayout } from "./ports.js";

// Two checkouts must get different stacks, the same checkout the same one,
// and every port must stay below the ephemeral range and inside its block.

describe("per-checkout e2e stack layout", () => {
  it("is stable for a path and different for another worktree", () => {
    const a = stackLayout("/src/infralift", {});
    expect(stackLayout("/src/infralift/", {})).toEqual(a);
    const b = stackLayout("/src/infralift-connector-fixes", {});
    expect(b.project).not.toBe(a.project);
    expect(b.base).not.toBe(a.base);
    expect(a.project).toMatch(/^infralift-e2e-[0-9a-f]{6}$/);
  });

  it("keeps every port in 20000..32699, in its own block of 100, with room above the API for per-provider processes", () => {
    for (const path of ["/a", "/b/c", "/Users/x/dev/infralift", "/home/runner/work/infralift/infralift"]) {
      const { base, ports } = stackLayout(path, {});
      expect(base % 100).toBe(0);
      expect(base).toBeGreaterThanOrEqual(20000);
      expect(base + 99).toBeLessThan(32768);
      expect(Math.max(...Object.values(ports))).toBe(base + OFFSETS.api);
      expect(new Set(Object.values(ports)).size).toBe(Object.keys(OFFSETS).length);
    }
  });

  it("takes E2E_PORT_BASE and E2E_PROJECT, and refuses a base that is not a usable port", () => {
    const l = stackLayout("/a", { E2E_PORT_BASE: "41000", E2E_PROJECT: "mine" });
    expect(l).toMatchObject({ base: 41000, project: "mine", ports: { postgres: 41001, api: 41040 } });
    for (const bad of ["80", "65500", "abc", "4100.5"]) expect(() => stackLayout("/a", { E2E_PORT_BASE: bad })).toThrow(/E2E_PORT_BASE/);
  });

  it("exports what docker-compose.e2e.yml reads", () => {
    const lines = composeExports(stackLayout("/a", { E2E_PORT_BASE: "41000", E2E_PROJECT: "mine" }));
    expect(lines).toContain("export COMPOSE_PROJECT_NAME=mine");
    expect(lines).toContain("export E2E_PORT_POSTGRES=41001");
    expect(lines).toContain("export E2E_PORT_GOOGLE=41018");
  });
});
