import { describe, expect, it } from "vitest";
import {
  buildDemoHerokuAssessment,
  buildDemoVercelAssessment,
  buildDemoFirebaseAssessment,
  buildDemoRenderAssessment,
} from "./demo-fixture.js";
import { computeExitToll } from "./exit-toll.js";
import type { ResourceInventoryItem } from "@infralift/shared";

describe("exit toll", () => {
  it("prices stored data, not the monthly serving bill", () => {
    // The Vercel demo serves 10TB/mo and stores 500GB. The exit toll is about
    // the 500GB; conflating the two is exactly what the migration doc warns
    // against, and would produce a number ~20x too large.
    const { inventory } = buildDemoVercelAssessment();
    const toll = computeExitToll("vercel", inventory);

    expect(toll.totalGb).toBe(500);
    expect(toll.cents).toBe(7500);
    expect(toll.confidence).toBe("measured");
  });

  it("never counts Redis, which warms rather than migrating", () => {
    const { inventory } = buildDemoHerokuAssessment();
    const toll = computeExitToll("heroku", inventory);

    expect(toll.components.some((c) => /redis/i.test(c.label))).toBe(false);
    expect(
      toll.notes.some((n) => n.includes("Redis is not counted"))
    ).toBe(true);
  });

  it("charges nothing to leave a provider that does not meter egress", () => {
    const { inventory } = buildDemoHerokuAssessment();
    const toll = computeExitToll("heroku", inventory);

    // Heroku has a database to move, so there is volume...
    expect(toll.totalGb).toBeGreaterThan(0);
    // ...but no egress meter, so no toll.
    expect(toll.cents).toBe(0);
  });

  it("zeroes the payable toll where the provider waives migration egress", () => {
    const { inventory } = buildDemoFirebaseAssessment();
    const toll = computeExitToll("firebase", inventory);

    expect(toll.cents).toBeGreaterThan(0);
    expect(toll.waiverAvailable).toBe(true);
    expect(toll.centsAfterWaiver).toBe(0);
    expect(toll.waiverNote).toContain("waive");

    // A provider with no waiver pays the full amount.
    const render = computeExitToll("render", buildDemoRenderAssessment().inventory);
    expect(render.waiverAvailable).toBe(false);
    expect(render.centsAfterWaiver).toBe(render.cents);
  });

  it("marks plan-derived volumes as estimated and API-derived ones as measured", () => {
    const measured: ResourceInventoryItem[] = [
      {
        provider: "gcp",
        type: "gcp:cloud_sql",
        externalId: "prod-db",
        name: "prod-db",
        metadata: { dataDiskSizeGb: 250 },
      } as ResourceInventoryItem,
    ];
    const fromApi = computeExitToll("gcp", measured);
    expect(fromApi.totalGb).toBe(250);
    expect(fromApi.confidence).toBe("measured");
    expect(fromApi.components[0].measured).toBe(true);

    const estimated: ResourceInventoryItem[] = [
      {
        provider: "gcp",
        type: "gcp:cloud_sql",
        externalId: "prod-db",
        name: "prod-db",
        metadata: {},
      } as ResourceInventoryItem,
    ];
    const inferred = computeExitToll("gcp", estimated);
    expect(inferred.confidence).toBe("estimated");
    expect(inferred.components[0].measured).toBe(false);
  });

  it("says so plainly when nothing has to move", () => {
    const toll = computeExitToll("cloudflare", []);
    expect(toll.cents).toBe(0);
    expect(toll.confidence).toBe("none");
    expect(toll.components).toHaveLength(0);
    expect(
      toll.notes.some((n) => n.includes("No stored data was found"))
    ).toBe(true);
  });

  it("scales the toll with the source provider's egress rate", () => {
    const db: ResourceInventoryItem[] = [
      {
        provider: "render",
        type: "render:postgres",
        externalId: "dpg-1",
        name: "db",
        metadata: { plan: "pro" },
      } as ResourceInventoryItem,
    ];

    // Same 96GB volume, different per-GB rates: Render 10c, Railway 5c, DO 1c.
    const render = computeExitToll("render", db);
    const railway = computeExitToll("railway", db);
    const digitalocean = computeExitToll("digitalocean", db);

    expect(render.totalGb).toBe(96);
    expect(render.cents).toBe(960);
    expect(railway.cents).toBe(480);
    expect(digitalocean.cents).toBe(96);
  });
});
