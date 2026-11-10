import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { collect as collectHeroku } from "@infralift/collectors/heroku";
import { analyzeHeroku } from "../connectors/heroku.js";
import {
  buildDemoRenderAssessment,
  buildDemoVercelAssessment,
} from "./demo-fixture.js";
import { computeFootprint, sizeTarget } from "./sizing.js";
import { buildWorkloadBreakdown } from "./workloads.js";

// The Heroku case runs the recorded API responses from the test account
// (connectors/__fixtures__/heroku-api.json: a web app, a worker app and a
// data app holding Postgres and Redis) through the real collector and
// analyzer, so the inventory shape is the one production stores.
const HEROKU_API = JSON.parse(
  readFileSync(
    new URL("../connectors/__fixtures__/heroku-api.json", import.meta.url),
    "utf8"
  )
) as Record<string, unknown>;

async function herokuInventory() {
  const fetchImpl = (async (url: string) => {
    const path = new URL(url).pathname;
    return path in HEROKU_API
      ? { ok: true, status: 200, json: async () => HEROKU_API[path] }
      : { ok: false, status: 404, json: async () => ({}) };
  }) as unknown as typeof globalThis.fetch;
  return analyzeHeroku(await collectHeroku({ token: "tok", fetchImpl }));
}

describe("buildWorkloadBreakdown", () => {
  it("groups a real Heroku account by app and sizes each app on its own", async () => {
    const a = await herokuInventory();
    const out = buildWorkloadBreakdown(a.inventory, {
      estimatedMonthlyCostCents: a.estimatedMonthlyCostCents,
      reportedMonthlySpendCents: null,
    });

    expect(out.workloads.map((w) => w.name).sort()).toEqual([
      "infralift-test-data",
      "infralift-test-web",
      "infralift-test-worker",
    ]);
    expect(out.workloads.every((w) => w.kind === "Heroku app")).toBe(true);

    // Each row is that app's own items, sized alone.
    const web = out.workloads.find((w) => w.name === "infralift-test-web")!;
    const webItems = a.inventory.filter((i) => i.name.startsWith("infralift-test-web "));
    expect(webItems.length).toBeGreaterThan(0);
    expect(web.targets).toEqual(
      ["hetzner", "cloudflare"].map((slug) => ({
        slug,
        monthlyCents: sizeTarget(slug, computeFootprint(webItems))!.monthlyCents,
      }))
    );
    // The data app's Postgres and Redis are add-ons billed to it, so they are
    // in its row, not in a shared one.
    const data = out.workloads.find((w) => w.name === "infralift-test-data")!;
    expect(data.targets.every((t) => t.monthlyCents > 0)).toBe(true);

    // Heroku list prices sum to the total exactly: nothing is left over.
    const sum = out.workloads.reduce((s, w) => s + (w.currentMonthlyCents ?? 0), 0);
    expect(sum).toBe(a.estimatedMonthlyCostCents);
    expect(out.workloadsShared).toBeNull();
  });

  it("puts shared databases and billed usage in their own row instead of splitting them", () => {
    const a = buildDemoRenderAssessment();
    const out = buildWorkloadBreakdown(a.inventory, {
      estimatedMonthlyCostCents: a.estimatedMonthlyCostCents,
      reportedMonthlySpendCents: null,
    });

    expect(out.workloads).toHaveLength(5);
    expect(out.workloads.every((w) => w.kind === "Render service")).toBe(true);
    const allocated = out.workloads.reduce((s, w) => s + w.currentMonthlyCents!, 0);
    expect(allocated).toBe(17500 * 3 + 8500 * 2);

    const shared = out.workloadsShared!;
    expect(shared.items).toEqual(
      expect.arrayContaining(["northwind-db", "northwind-cache"])
    );
    // Not forced to zero and not spread across services: the remainder.
    expect(shared.currentMonthlyCents).toBe(a.estimatedMonthlyCostCents! - allocated);
    expect(shared.currentMonthlyCents).toBeGreaterThan(0);
    // The shared row is the data services only, never a phantom server.
    for (const t of shared.targets) {
      expect(t.monthlyCents).toBeGreaterThan(0);
    }
    expect(shared.targets[0].monthlyCents).toBe(shared.targets[1].monthlyCents);
    expect(out.workloadsNote).toMatch(/row of their own/);
  });

  it("labels per-workload costs as list prices when the customer reported a bill", () => {
    const a = buildDemoRenderAssessment();
    const out = buildWorkloadBreakdown(a.inventory, {
      estimatedMonthlyCostCents: a.estimatedMonthlyCostCents,
      reportedMonthlySpendCents: 100_000,
    });
    // The reported bill does not leak into the rows.
    expect(out.workloads[0].currentMonthlyCents).toBe(17500);
    expect(out.workloadsNote).toMatch(/list prices/);
    expect(out.workloadsNote).toMatch(/not split by workload/);
  });

  it("returns nothing for a connector with no workloads, so the UI hides the section", () => {
    const a = buildDemoVercelAssessment();
    expect(
      buildWorkloadBreakdown(a.inventory, {
        estimatedMonthlyCostCents: a.estimatedMonthlyCostCents,
        reportedMonthlySpendCents: null,
      })
    ).toEqual({ workloads: [], workloadsShared: null, workloadsNote: null });
    expect(
      buildWorkloadBreakdown([], {
        estimatedMonthlyCostCents: null,
        reportedMonthlySpendCents: null,
      }).workloads
    ).toEqual([]);
  });

  it("leaves an unpriced workload and an unknown total unknown, not zero", () => {
    const out = buildWorkloadBreakdown(
      [
        { provider: "railway", type: "railway:service", externalId: "s1", name: "shop/api" },
        { provider: "railway", type: "railway:plugin", externalId: "p1", name: "shop/Postgres", metadata: { pluginType: "postgresql" } },
      ],
      { estimatedMonthlyCostCents: null, reportedMonthlySpendCents: null }
    );
    expect(out.workloads).toEqual([
      expect.objectContaining({ name: "shop/api", kind: "Railway service", currentMonthlyCents: null }),
    ]);
    expect(out.workloadsShared).toEqual(
      expect.objectContaining({ items: ["shop/Postgres"], currentMonthlyCents: null })
    );
  });
});
