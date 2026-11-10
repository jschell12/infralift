import { describe, expect, it } from "vitest";
import {
  DEFAULT_HOURLY_RATE_USD,
  estimate,
  footprintFrom,
  opsBurden,
  type EstimateInput,
} from "./estimate.js";
import { PRICES_VERIFIED_AT } from "./pricing.js";
import { sizeTarget } from "./sizing.js";

/** A Vercel-shaped workload: little RAM, a lot of egress. */
function vercelish(over: Partial<EstimateInput> = {}): EstimateInput {
  return {
    sourceProvider: "Vercel",
    monthlySpendUsd: 755,
    webInstances: 2,
    workerInstances: 0,
    ramPerInstanceMb: 1024,
    postgres: "small",
    redis: "none",
    runtime: "js",
    bandwidthGbMonth: 2000,
    requestsMillionsMonth: 30,
    objectStorageGb: 100,
    ...over,
  };
}

/** A Heroku-shaped workload: many always-on dynos. */
function herokuish(over: Partial<EstimateInput> = {}): EstimateInput {
  return {
    sourceProvider: "Heroku",
    monthlySpendUsd: 1200,
    webInstances: 4,
    workerInstances: 4,
    ramPerInstanceMb: 2048,
    postgres: "large",
    redis: "small",
    runtime: "js",
    bandwidthGbMonth: 300,
    requestsMillionsMonth: 8,
    objectStorageGb: 20,
    ...over,
  };
}

describe("footprintFrom", () => {
  it("multiplies instances by per-instance RAM", () => {
    const f = footprintFrom(herokuish());
    expect(f.totalRamMb).toBe(8 * 2048);
    expect(f.webInstances).toBe(4);
    expect(f.workerInstances).toBe(4);
  });

  it("maps the 'none' tier to null rather than a zero-cost plan", () => {
    const f = footprintFrom(vercelish({ postgres: "none", redis: "none" }));
    expect(f.postgresTier).toBeNull();
    expect(f.redisTier).toBeNull();
  });
});

describe("the calculator does not own any pricing", () => {
  // The whole reason this module lives in apps/api next to sizing.ts. If these
  // ever diverge, the first number a stranger sees stops matching the
  // assessment they run afterwards, and the Terraform we generate from the
  // same plan describes a third thing.
  it("reports exactly what sizeTarget reports for the same footprint", () => {
    for (const input of [vercelish(), herokuish()]) {
      const footprint = footprintFrom(input);
      for (const target of estimate(input).targets) {
        expect(target.monthlyCents).toBe(
          sizeTarget(target.slug, footprint)!.monthlyCents
        );
      }
    }
  });
});

describe("the ops line", () => {
  it("charges Hetzner per instance and Workers almost nothing", () => {
    const footprint = footprintFrom(herokuish());
    const hetzner = opsBurden("hetzner", footprint, 150);
    const cloudflare = opsBurden("cloudflare", footprint, 150);

    expect(hetzner.hoursPerMonth).toBeGreaterThan(cloudflare.hoursPerMonth);
    expect(cloudflare.hoursPerMonth).toBe(0.5);
    expect(hetzner.monthlyCents).toBe(
      Math.round(hetzner.hoursPerMonth * 150 * 100)
    );
  });

  it("grows with the instance count, not with the bill", () => {
    const small = opsBurden(
      "hetzner",
      footprintFrom(herokuish({ webInstances: 1, workerInstances: 0 })),
      150
    );
    const large = opsBurden(
      "hetzner",
      footprintFrom(herokuish({ webInstances: 8, workerInstances: 8 })),
      150
    );
    expect(large.hoursPerMonth).toBeGreaterThan(small.hoursPerMonth);
  });

  it("honours an hourly rate of zero instead of overriding it with the default", () => {
    // Someone who insists their own time is free should see that number, not
    // ours. `?? DEFAULT` on a zero would silently substitute $150.
    const result = estimate(vercelish({ hourlyRateUsd: 0 }));
    for (const target of result.targets) {
      expect(target.ops.monthlyCents).toBe(0);
      expect(target.netMonthlySavingsCents).toBe(
        target.grossMonthlySavingsCents
      );
    }
  });
});

describe("estimate", () => {
  it("nets the ops line out of the savings", () => {
    const result = estimate(vercelish());
    const best = result.targets[0];
    expect(best.netMonthlySavingsCents).toBe(
      best.grossMonthlySavingsCents! - best.ops.monthlyCents
    );
    expect(best.netAnnualSavingsCents).toBe(best.netMonthlySavingsCents! * 12);
  });

  it("puts Cloudflare ahead for an egress-heavy workload", () => {
    const result = estimate(vercelish());
    expect(result.bestSlug).toBe("cloudflare");
  });

  it("makes no savings claim when the current bill is unknown", () => {
    const result = estimate(vercelish({ monthlySpendUsd: undefined }));
    expect(result.bestSlug).toBeNull();
    for (const target of result.targets) {
      expect(target.grossMonthlySavingsCents).toBeNull();
      expect(target.netMonthlySavingsCents).toBeNull();
      // The target cost is still knowable and still worth showing.
      expect(target.monthlyCents).toBeGreaterThan(0);
    }
    expect(result.assumptions[0]).toContain("makes no savings claim");
  });

  it("says nobody should move when the ops line eats the difference", () => {
    // A small bill against a fleet big enough to need babysitting. Returning
    // "stay where you are" is the answer that makes the other numbers on the
    // page believable.
    const result = estimate(
      herokuish({ monthlySpendUsd: 260, webInstances: 6, workerInstances: 6 })
    );
    expect(result.bestSlug).toBeNull();
    expect(result.targets.every((t) => t.netMonthlySavingsCents! <= 0)).toBe(
      true
    );
  });

  it("still ranks by cost when there is no saving to rank on", () => {
    const result = estimate(vercelish({ monthlySpendUsd: undefined }));
    expect(result.targets[0].monthlyCents).toBeLessThanOrEqual(
      result.targets[1].monthlyCents
    );
  });

  it("states the rate it used so the reader can argue with the assumption", () => {
    expect(estimate(vercelish()).assumptions[0]).toContain(
      `$${DEFAULT_HOURLY_RATE_USD}/hour`
    );
    expect(estimate(vercelish({ hourlyRateUsd: 40 })).assumptions[0]).toContain(
      "$40/hour"
    );
  });

  it("dates its prices, whether or not there is a bill to compare", () => {
    // /estimate shows "Prices verified <Month YYYY>" from this field, so a
    // page with no savings claim still says how old its target costs are.
    expect(estimate(vercelish()).pricesVerifiedAt).toBe(PRICES_VERIFIED_AT);
    expect(
      estimate(vercelish({ monthlySpendUsd: undefined })).pricesVerifiedAt
    ).toBe(PRICES_VERIFIED_AT);
  });
});

describe("fit", () => {
  // The most expensive way this page can be wrong: quoting Workers for a
  // stack that cannot run on Workers. It wins on price every time and the
  // number is worthless.
  it("refuses to recommend Workers for a non-JS runtime", () => {
    const result = estimate(herokuish({ runtime: "other" }));
    const cf = result.targets.find((t) => t.slug === "cloudflare")!;
    expect(cf.eligible).toBe(false);
    expect(cf.ineligibleReason).toContain("JavaScript");
    expect(result.bestSlug).toBe("hetzner");
  });

  it("still prices an ineligible target rather than hiding it", () => {
    const cf = estimate(herokuish({ runtime: "other" })).targets.find(
      (t) => t.slug === "cloudflare"
    )!;
    expect(cf.monthlyCents).toBeGreaterThan(0);
  });

  it("never ranks an ineligible target first, however cheap it is", () => {
    const result = estimate(herokuish({ runtime: "other" }));
    expect(result.targets[0].slug).toBe("hetzner");
    expect(result.targets[0].eligible).toBe(true);
  });

  it("rules Workers out when processes are far larger than an isolate", () => {
    const cf = estimate(
      herokuish({ runtime: "js", ramPerInstanceMb: 4096 })
    ).targets.find((t) => t.slug === "cloudflare")!;
    expect(cf.eligible).toBe(false);
    expect(cf.ineligibleReason).toContain("128MB");
  });

  it("leaves Hetzner eligible for anything, since it runs a container", () => {
    for (const runtime of ["js", "other"] as const) {
      const hetzner = estimate(herokuish({ runtime })).targets.find(
        (t) => t.slug === "hetzner"
      )!;
      expect(hetzner.eligible).toBe(true);
    }
  });
});
