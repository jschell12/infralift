import { describe, expect, it } from "vitest";
import { breakEvenMonths, compareTarget } from "./compare.js";
import { buildDemoHerokuAssessment } from "./demo-fixture.js";
import { DEFAULT_HOURLY_RATE_USD, opsBurden } from "./estimate.js";
import { computeExitToll } from "./exit-toll.js";
import { computeFootprint, sizeTarget } from "./sizing.js";

// Inputs come from the demo Heroku account run through the real pipeline, so
// the numbers here are the ones the options page shows for it: a $3,229/mo
// bill, Hetzner sized at $422/mo, three hours of ops at $150.
const heroku = buildDemoHerokuAssessment();
const footprint = computeFootprint(heroku.inventory);
const hetzner = sizeTarget("hetzner", footprint)!;
const ops = opsBurden("hetzner", footprint, DEFAULT_HOURLY_RATE_USD);

describe("compareTarget", () => {
  it("nets the ops line out of the infrastructure saving", () => {
    const c = compareTarget({
      currentMonthlyCents: heroku.estimatedMonthlyCostCents,
      targetMonthlyCents: hetzner.monthlyCents,
      ops,
      exitTollCents: 0,
    });
    expect(c.grossMonthlySavingsCents).toBe(322900 - 42200);
    expect(c.netMonthlySavingsCents).toBe(322900 - 42200 - ops.monthlyCents);
    expect(c.netAnnualSavingsCents).toBe(c.netMonthlySavingsCents! * 12);
  });

  it("makes no claim at all when the current bill is unknown", () => {
    // The defect this exists for: an unknown bill compared as $0 made every
    // target a loss and the report said to stay put.
    const c = compareTarget({
      currentMonthlyCents: null,
      targetMonthlyCents: hetzner.monthlyCents,
      ops,
      exitTollCents: 5000,
    });
    expect(c).toEqual({
      grossMonthlySavingsCents: null,
      netMonthlySavingsCents: null,
      netAnnualSavingsCents: null,
      breakEvenMonths: null,
      firstYearNetCents: null,
    });
  });

  it("compares against a zero bill when zero is what was said", () => {
    // Zero is a claim; null is not. A customer who reports $0 gets the loss.
    const c = compareTarget({
      currentMonthlyCents: 0,
      targetMonthlyCents: hetzner.monthlyCents,
      ops,
      exitTollCents: 0,
    });
    expect(c.netMonthlySavingsCents).toBe(-42200 - ops.monthlyCents);
    expect(c.breakEvenMonths).toBeNull();
  });

  it("never breaks even on a move that costs more", () => {
    const c = compareTarget({
      currentMonthlyCents: 26000,
      targetMonthlyCents: hetzner.monthlyCents,
      ops,
      exitTollCents: 7500,
    });
    expect(c.netMonthlySavingsCents).toBeLessThan(0);
    expect(c.breakEvenMonths).toBeNull();
    // The first year is the loss plus the toll, not a smaller loss.
    expect(c.firstYearNetCents).toBe(c.netMonthlySavingsCents! * 12 - 7500);
  });

  it("breaks even immediately when there is no toll to repay", () => {
    const c = compareTarget({
      currentMonthlyCents: 322900,
      targetMonthlyCents: hetzner.monthlyCents,
      ops,
      exitTollCents: 0,
    });
    expect(c.breakEvenMonths).toBe(0);
    expect(c.firstYearNetCents).toBe(c.netMonthlySavingsCents! * 12);
  });

  it("repays the toll after the waiver, not before it", () => {
    // Google waives egress on request; the comparison takes the after-waiver
    // figure. The item is the shape the GCP connector writes for Cloud SQL.
    const gcpToll = computeExitToll("gcp", [
      {
        provider: "gcp",
        type: "gcp:cloud_sql",
        externalId: "prod-db",
        name: "prod-db",
        region: "us-central1",
        metadata: {
          databaseVersion: "POSTGRES_16",
          tier: "db-custom-2-7680",
          dataDiskSizeGb: "100",
          state: "RUNNABLE",
        },
      },
    ]);
    const c = compareTarget({
      currentMonthlyCents: 200000,
      targetMonthlyCents: hetzner.monthlyCents,
      ops,
      exitTollCents: gcpToll.centsAfterWaiver,
    });
    expect(gcpToll.waiverAvailable).toBe(true);
    expect(gcpToll.cents).toBeGreaterThan(0);
    expect(gcpToll.centsAfterWaiver).toBe(0);
    expect(c.breakEvenMonths).toBe(0);

    // Without the waiver the same toll takes time to repay.
    const unwaived = compareTarget({
      currentMonthlyCents: 200000,
      targetMonthlyCents: hetzner.monthlyCents,
      ops,
      exitTollCents: gcpToll.cents,
    });
    expect(unwaived.breakEvenMonths).toBeGreaterThan(0);
  });
});

describe("breakEvenMonths", () => {
  it("rounds up to a tenth of a month, never down", () => {
    // 10000 / 3000 = 3.33..., which must read 3.4, not 3.3: rounding down
    // would claim the toll is repaid before it is.
    expect(breakEvenMonths(10000, 3000)).toBe(3.4);
    expect(breakEvenMonths(6000, 3000)).toBe(2);
    expect(breakEvenMonths(1, 100000)).toBe(0.1);
  });

  it("is null for no saving and for an unknown saving", () => {
    expect(breakEvenMonths(5000, 0)).toBeNull();
    expect(breakEvenMonths(5000, -100)).toBeNull();
    expect(breakEvenMonths(5000, null)).toBeNull();
    expect(breakEvenMonths(0, 0)).toBeNull();
  });
});
