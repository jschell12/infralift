import { describe, expect, it } from "vitest";
import {
  buildDemoHerokuAssessment,
  buildDemoVercelAssessment,
} from "./demo-fixture.js";
import { computeFootprint, sizeTarget } from "./sizing.js";

describe("computeFootprint", () => {
  it("measures the Heroku demo: ~60GB RAM, premium data tiers", () => {
    const f = computeFootprint(buildDemoHerokuAssessment().inventory);
    // 4× Performance-L (14GB) + 1× Standard-1X (0.5GB) + 4× Standard-2X (1GB)
    expect(f.totalRamMb).toBe(4 * 14336 + 512 + 4 * 1024);
    expect(f.webInstances).toBe(5);
    expect(f.workerInstances).toBe(4);
    expect(f.postgresTier).toBe("large"); // premium-0
    expect(f.redisTier).toBe("large"); // premium-3
  });

  it("reads usage items from the Vercel demo: 10TB bandwidth, 50M requests", () => {
    const f = computeFootprint(buildDemoVercelAssessment().inventory);
    expect(f.bandwidthGbMonth).toBe(10000);
    expect(f.requestsMillionsMonth).toBe(50);
    expect(f.objectStorageGb).toBe(500);
    expect(f.postgresTier).toBeNull();
  });
});

describe("sizeTarget", () => {
  const herokuFootprint = computeFootprint(
    buildDemoHerokuAssessment().inventory
  );
  const vercelFootprint = computeFootprint(
    buildDemoVercelAssessment().inventory
  );

  it("prices the Heroku demo on Hetzner in the credible hundreds, not $7", () => {
    const sized = sizeTarget("hetzner", herokuFootprint);
    expect(sized).not.toBeNull();
    // Instances + LB + Neon 2CU + Upstash 5GB. The point is the order of
    // magnitude: hundreds per month for a $3,229/mo workload, not single
    // digits.
    expect(sized!.monthlyCents).toBeGreaterThan(30000);
    expect(sized!.monthlyCents).toBeLessThan(80000);
    const labels = sized!.lineItems.map((l) => l.label).join("\n");
    expect(labels).toContain("CCX");
    expect(labels).toContain("Load balancer");
    expect(labels).toContain("Neon Postgres");
    expect(labels).toContain("Upstash Redis (5GB fixed)");
  });

  it("gives the Vercel demo its $0 egress and $0 seats lines on Cloudflare", () => {
    const sized = sizeTarget("cloudflare", vercelFootprint);
    expect(sized).not.toBeNull();
    const zeroLines = sized!.lineItems.filter((l) => l.monthlyCents === 0);
    expect(zeroLines.map((l) => l.label).join("\n")).toContain("Egress");
    expect(zeroLines.map((l) => l.label).join("\n")).toContain("Team seats");
    // 10TB of bandwidth overage ($1,350 on Vercel) prices to $0 here; the
    // whole sized bill lands well under $100/mo.
    expect(sized!.monthlyCents).toBeLessThan(10000);
    expect(sized!.monthlyCents).toBeGreaterThan(500);
  });

  it("floors Hetzner instance count on bandwidth, not just RAM", () => {
    // 10TB/mo cannot credibly ride on one small box even if RAM fits.
    const sized = sizeTarget("hetzner", vercelFootprint);
    const instanceLines = sized!.lineItems.filter((l) =>
      l.label.includes("CCX")
    );
    const count = instanceLines.reduce(
      (n, l) => n + Number(l.label.match(/^(\d+)×/)?.[1] ?? 1),
      0
    );
    expect(count).toBeGreaterThanOrEqual(2);
  });

  it("returns null for targets without a sizing model", () => {
    for (const slug of ["railway", "render", "aws", "digitalocean"]) {
      expect(sizeTarget(slug, herokuFootprint)).toBeNull();
    }
  });
});
