import { describe, it, expect } from "vitest";
import type { ResourceInventoryItem } from "@infralift/shared";
import { buildMigrationPlan } from "./migration-plan.js";

// The plan covers the work the codegen does not do. Its whole value is being
// specific to the account in front of it: a plan that reads identically for
// every customer is a template, and a buyer can tell in about four seconds.
// So most of what is asserted here is that the output actually changes with
// the inventory.

const heroku = (
  type: string,
  name: string,
  metadata: Record<string, unknown> = {}
): ResourceInventoryItem => ({
  provider: "heroku",
  type,
  externalId: `${type}:${name}`,
  name,
  metadata,
});

const SMALL_DB = heroku("heroku:addon", "shop-db", {
  plan: "heroku-postgresql:essential-0",
});
const BIG_DB = heroku("heroku:addon", "shop-db", {
  plan: "heroku-postgresql:premium-5",
});
const REDIS = heroku("heroku:addon", "shop-cache", {
  plan: "heroku-redis:mini",
});
const WEB = heroku("heroku:dyno", "shop-api web (standard-2x x2)", {
  size: "standard-2x",
});

const VERCEL_PROJECT: ResourceInventoryItem = {
  provider: "vercel",
  type: "vercel:project",
  externalId: "prj_1",
  name: "storefront",
  metadata: {
    envVarCount: 12,
    gitRepo: "northwind/platform",
    productionBranch: "main",
    buildCommand: "pnpm turbo build",
  },
};

const APEX: ResourceInventoryItem = {
  provider: "vercel",
  type: "vercel:domain",
  externalId: "dom_1",
  name: "northwind.com",
};
const SUB: ResourceInventoryItem = {
  provider: "vercel",
  type: "vercel:domain",
  externalId: "dom_2",
  name: "shop.northwind.com",
};

function plan(inventory: ResourceInventoryItem[]) {
  return buildMigrationPlan({ provider: "heroku", target: "Hetzner", inventory });
}

const section = (p: ReturnType<typeof plan>, area: string) =>
  p.sections.find((s) => s.area === area)!;

describe("the plan is derived from the inventory, not a template", () => {
  it("changes the database method and downtime with the plan tier", () => {
    const small = section(plan([SMALL_DB]), "data");
    const big = section(plan([BIG_DB]), "data");

    expect(small.downtime).toMatch(/10-20 minutes/);
    expect(small.steps[0].detail).toMatch(/pg_dump/);

    expect(big.downtime).not.toBe(small.downtime);
    expect(big.steps[0].detail).toMatch(/logical replication/);
  });

  it("says so plainly when there is no database rather than inventing one", () => {
    const s = section(plan([WEB]), "data");
    expect(s.steps[0].title).toMatch(/No managed database/i);
    expect(s.steps[0].owner).toBe("customer");
    expect(s.risks.join(" ")).toMatch(/cannot see/i);
  });

  it("treats a cache as disposable but flags the assumption", () => {
    const s = section(plan([SMALL_DB, REDIS]), "data");
    expect(s.steps.some((x) => /Re-create shop-cache empty/.test(x.title))).toBe(
      true
    );
    // Silently dropping queue state would be the expensive kind of wrong.
    expect(s.risks.join(" ")).toMatch(/queue state|sessions/i);
  });

  it("distinguishes apex from subdomain, because the record type differs", () => {
    const s = section(plan([APEX, SUB]), "dns");
    const apex = s.steps.find((x) => x.title.includes("northwind.com") && !x.title.includes("shop."))!;
    const sub = s.steps.find((x) => x.title.includes("shop.northwind.com"))!;
    expect(apex.detail).toMatch(/ALIAS\/ANAME/);
    expect(sub.detail).toMatch(/CNAME/);
    expect(s.risks.join(" ")).toMatch(/Apex domains/);
  });

  it("counts secrets without ever claiming to know them", () => {
    const s = section(plan([VERCEL_PROJECT]), "secrets");
    expect(s.summary).toMatch(/12 environment variable/);
    expect(s.summary).toMatch(/never seen/i);
    // Export must be the customer's job — we do not hold the values.
    expect(s.steps[0].owner).toBe("customer");
  });

  it("uses the customer's real repo and build command for CI/CD", () => {
    const s = section(plan([VERCEL_PROJECT]), "cicd");
    expect(s.steps[0].detail).toContain("pnpm turbo build");
    expect(s.steps[0].title).toContain("northwind/platform");
    expect(s.steps[0].detail).toContain("main");
  });
});

describe("the parts that make a flat fee survivable", () => {
  it("names the point of no return in terms of the database", () => {
    expect(plan([SMALL_DB]).pointOfNoReturn).toMatch(/first write/i);
  });

  it("says rollback stays free when there is no database to move", () => {
    const p = plan([WEB, SUB]);
    expect(p.pointOfNoReturn).toMatch(/decommissioned/i);
    expect(section(p, "rollback").summary).toMatch(/free for the whole overlap/i);
  });

  it("gives every step an owner, so nothing is silently ours", () => {
    const p = plan([SMALL_DB, REDIS, VERCEL_PROJECT, APEX, SUB, WEB]);
    for (const s of p.sections) {
      for (const step of s.steps) {
        expect(["infralift", "customer", "shared"]).toContain(step.owner);
      }
    }
    // And the customer genuinely owns some of it — a plan where we do
    // everything is a plan that has not been thought about.
    const owners = p.sections.flatMap((s) => s.steps.map((x) => x.owner));
    expect(owners).toContain("customer");
    expect(owners).toContain("infralift");
  });

  it("never estimates the engagement, only downtime", () => {
    const p = plan([SMALL_DB, VERCEL_PROJECT, APEX]);
    const text = JSON.stringify(p);
    // Downtime is derivable and checkable; labour is not, and a number that
    // looks like a commitment is what turns a fixed fee into an argument.
    expect(text).not.toMatch(/\b\d+\s*(hours?|days?|weeks?)\s*(of work|of effort|engagement)/i);
    expect(p.notCovered.join(" ")).toMatch(/does not estimate the labour/i);
    expect(section(p, "data").downtime).toBeTruthy();
  });

  it("admits what it does not cover", () => {
    const p = plan([VERCEL_PROJECT]);
    const text = p.notCovered.join(" ");
    expect(text).toMatch(/incremental static regeneration|middleware/i);
    expect(text).toMatch(/preview/i);
    expect(text).toMatch(/third-party/i);
  });
});

describe("the plan can drive a stateful UI", () => {
  const p = plan([SMALL_DB, REDIS, VERCEL_PROJECT, APEX, SUB, WEB]);

  it("gives every step a unique, stable id", () => {
    const ids = p.sections.flatMap((s) => s.steps.map((x) => x.id));
    expect(new Set(ids).size).toBe(ids.length);
    // Stable across regeneration of the same inventory.
    const again = plan([SMALL_DB, REDIS, VERCEL_PROJECT, APEX, SUB, WEB]);
    expect(again.sections.flatMap((s) => s.steps.map((x) => x.id))).toEqual(ids);
  });

  it("phases the work so cutover can be gated behind preparation", () => {
    const phases = new Set(
      p.sections.flatMap((s) => s.steps.map((x) => x.phase))
    );
    expect(phases.has("prepare")).toBe(true);
    expect(phases.has("cutover")).toBe(true);
    expect(phases.has("decommission")).toBe(true);

    // Flipping DNS is a cutover step; lowering TTL ahead of it is not.
    const dns = section(p, "dns");
    expect(dns.steps.find((x) => /Lower TTL/.test(x.title))!.phase).toBe("prepare");
    expect(dns.steps.find((x) => /Cut over/.test(x.title))!.phase).toBe("cutover");
  });

  it("marks the steps we could verify ourselves", () => {
    const automatable = p.sections
      .flatMap((s) => s.steps)
      .filter((x) => x.automatable);
    // DNS/TTL/response-diff are probes. If this ever goes to zero, the
    // workflow is a checklist and nothing more.
    expect(automatable.length).toBeGreaterThan(0);
    expect(
      automatable.some((x) => /TTL|Cut over|serves correctly/i.test(x.title))
    ).toBe(true);
  });
});
