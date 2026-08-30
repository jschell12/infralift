import { describe, expect, it } from "vitest";
import type { ResourceInventoryItem } from "@infralift/shared";
import { inferProfile } from "./options.js";

const item = (
  type: string,
  name: string,
  metadata: Record<string, unknown> = {},
  externalId = "x"
): ResourceInventoryItem => ({
  provider: type.split(":")[0] as ResourceInventoryItem["provider"],
  type,
  externalId,
  name,
  metadata,
});

describe("inferProfile", () => {
  it("reads a Heroku app as a long-running node workload", () => {
    const { runtime, needs } = inferProfile([
      item("heroku:app", "shop-web"),
      item("heroku:dyno", "shop-web web (Basic x1)", { processType: "web" }, "uuid:web"),
    ]);
    expect(runtime).toBe("node_server");
    expect(needs.map((n) => n.key)).toContain("full_node_runtime");
  });

  it("derives postgres, redis, and worker needs from Heroku add-ons and dynos", () => {
    const { needs } = inferProfile([
      item("heroku:addon", "shop-data: heroku-postgresql", {
        plan: "heroku-postgresql:essential-0",
        appName: "shop-data",
      }),
      item("heroku:addon", "shop-data: heroku-redis", {
        plan: "heroku-redis:mini",
        appName: "shop-data",
      }),
      item("heroku:dyno", "shop-worker worker (Basic x1)", { processType: "worker" }, "uuid:worker"),
    ]);
    const keys = needs.map((n) => n.key);
    expect(keys).toContain("managed_postgres");
    expect(keys).toContain("managed_redis");
    expect(keys).toContain("background_workers");
  });

  it("reads a Next.js Vercel project as SSR", () => {
    const { runtime, needs } = inferProfile([
      item("vercel:project", "acme-web", { framework: "nextjs" }),
    ]);
    expect(runtime).toBe("ssr");
    expect(needs.map((n) => n.key)).toContain("ssr");
  });

  it("spots cron workloads from project names", () => {
    const { needs } = inferProfile([
      item("vercel:project", "acme-worker-cron", { framework: "nextjs" }),
    ]);
    expect(needs.map((n) => n.key)).toContain("cron");
  });

  it("carries the inventory item name as evidence", () => {
    const { needs } = inferProfile([
      item("heroku:addon", "shop-data: heroku-postgresql", {
        plan: "heroku-postgresql:essential-0",
      }),
    ]);
    const pg = needs.find((n) => n.key === "managed_postgres");
    expect(pg?.evidence).toBe("shop-data: heroku-postgresql");
  });

  it("falls back to static for an inventory with no compute", () => {
    const { runtime } = inferProfile([]);
    expect(runtime).toBe("static");
  });
});
