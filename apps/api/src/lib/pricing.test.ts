import { describe, expect, it } from "vitest";
import { computeEffectivePricing, type DiscountProgramData } from "./pricing.js";

// The programs below are the rows prisma/seed.ts writes for Cloudflare,
// DigitalOcean and Hetzner, so these tests exercise the numbers the options
// page actually applies.
const CLOUDFLARE: DiscountProgramData[] = [
  {
    kind: "startup_credit",
    name: "Cloudflare for Startups",
    creditMaxCents: 250_000_00,
    creditDurationMonths: 12,
    creditMonthlyCapCents: null,
    confidence: "corroborated",
    tiers: [],
  },
  {
    kind: "committed_spend",
    name: "Enterprise contract",
    creditMaxCents: null,
    creditDurationMonths: null,
    creditMonthlyCapCents: null,
    confidence: "corroborated",
    tiers: [{ minAnnualCommitUsd: 36_000, discountBps: 1500 }],
  },
];

const DIGITALOCEAN: DiscountProgramData[] = [
  {
    kind: "startup_credit",
    name: "DigitalOcean Startups",
    creditMaxCents: 100_000_00,
    creditDurationMonths: 12,
    creditMonthlyCapCents: 10_000_00,
    confidence: "corroborated",
    tiers: [],
  },
];

const HETZNER: DiscountProgramData[] = [
  {
    kind: "auction",
    name: "Serverbörse (server auction)",
    creditMaxCents: null,
    creditDurationMonths: null,
    creditMonthlyCapCents: null,
    confidence: "corroborated",
    tiers: [{ minAnnualCommitUsd: 0, discountBps: 4000 }],
  },
];

describe("committed-spend tiers", () => {
  it("does not qualify below the tier's annual commitment", () => {
    // Cloudflare's catalog typical is $15/mo: $180/yr is nowhere near $36k.
    const p = computeEffectivePricing(1500, CLOUDFLARE);
    expect(p.steadyStateMonthlyCents).toBe(1500);
    expect(p.applied).toEqual([]);
  });

  it("qualifies on the projected spend it is given", () => {
    const p = computeEffectivePricing(1500, CLOUDFLARE, {
      annualSpendCents: 36_000_00,
    });
    expect(p.steadyStateMonthlyCents).toBe(Math.round(1500 * 0.85));
    expect(p.applied[0].name).toBe("Enterprise contract");
  });

  it("qualifies exactly at the boundary and not a dollar under", () => {
    const at = computeEffectivePricing(300_000, CLOUDFLARE);
    const under = computeEffectivePricing(299_999, CLOUDFLARE);
    expect(at.steadyStateMonthlyCents).toBe(255_000);
    expect(under.steadyStateMonthlyCents).toBe(299_999);
  });

  it("applies an auction discount with no commitment at all", () => {
    const p = computeEffectivePricing(1200, HETZNER);
    expect(p.steadyStateMonthlyCents).toBe(720);
    expect(p.applied[0].kind).toBe("auction");
  });
});

describe("startup credits", () => {
  it("are ignored unless the workload is eligible", () => {
    const p = computeEffectivePricing(10_000, CLOUDFLARE);
    expect(p.year1MonthlyCents).toBe(p.steadyStateMonthlyCents);
  });

  it("cover year 1 entirely when the credit exceeds a year of list", () => {
    const p = computeEffectivePricing(10_000, CLOUDFLARE, {
      startupCreditsEligible: true,
    });
    expect(p.year1MonthlyCents).toBe(0);
    expect(p.steadyStateMonthlyCents).toBe(10_000);
    expect(p.applied.map((a) => a.name)).toContain("Cloudflare for Startups");
  });

  it("burn at most the monthly cap and stop at the program total", () => {
    // $15k/mo list against DigitalOcean's $10k/mo cap and $100k total: the
    // cap would allow $120k over the year, the total allows $100k.
    const p = computeEffectivePricing(15_000_00, DIGITALOCEAN, {
      startupCreditsEligible: true,
    });
    expect(p.year1MonthlyCents).toBe(
      Math.round((15_000_00 * 12 - 100_000_00) / 12)
    );
    expect(p.applied[0].detail).toContain("monthly use-it-or-lose-it cap");
  });

  it("do not stack with a commitment; the cheaper of the two wins year 1", () => {
    // $50k/mo qualifies for the enterprise tier, and $250k of credit covers
    // five months of list. Credits win year 1; steady state keeps the tier.
    const p = computeEffectivePricing(50_000_00, CLOUDFLARE, {
      startupCreditsEligible: true,
    });
    expect(p.steadyStateMonthlyCents).toBe(42_500_00);
    expect(p.year1MonthlyCents).toBe(
      Math.round((50_000_00 * 12 - 250_000_00) / 12)
    );
    expect(p.year1MonthlyCents).toBeLessThan(p.steadyStateMonthlyCents);
  });
});
