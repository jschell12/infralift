import { beforeEach, describe, expect, it, vi } from "vitest";

// Recommendations through the route, with only Postgres stubbed: recommend()
// and computeEffectivePricing() run for real. The rows are what prisma/seed.ts
// writes for Cloudflare, the provider and its two discount programs, so the
// tier under test is the $36,000/yr enterprise contract the options page
// wrongly applied to a $3,229/mo Heroku account before #120.

const h = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  programs: vi.fn(),
  profile: vi.fn(),
}));

vi.mock("../lib/db.js", () => ({
  prisma: {
    $queryRaw: h.queryRaw,
    discountProgram: { findMany: h.programs },
    appProfile: { findFirst: h.profile },
  },
}));

const { providersRouter } = await import("./providers.js");

type Handler = (req: unknown, res: unknown, next?: unknown) => unknown;

async function call(method: string, path: string, req: Record<string, unknown>) {
  const layer = (
    providersRouter as unknown as {
      stack: { route?: { path: string; methods: Record<string, boolean>; stack: { handle: Handler }[] } }[];
    }
  ).stack.find((l) => l.route?.path === path && l.route?.methods[method]);
  if (!layer?.route) throw new Error(`no ${method} ${path}`);
  const out = { status: 200, body: undefined as unknown };
  const res = {
    status(code: number) {
      out.status = code;
      return this;
    },
    json(payload: unknown) {
      out.body = payload;
      return this;
    },
  };
  await layer.route.stack.at(-1)!.handle(
    { user: { orgId: "org-a" }, params: {}, query: {}, ...req },
    res
  );
  return out;
}

/** The Cloudflare row recommend()'s ranking query returns, at a given price. */
function cloudflareRow(typicalMonthlyCents: number) {
  return {
    slug: "cloudflare",
    name: "Cloudflare (Workers + Pages)",
    category: "edge",
    pricingModel: "hybrid",
    minMonthlyCents: 500,
    typicalMonthlyCents,
    managedLevel: 3,
    egressFreeGb: -1,
    benefits: "",
    drawbacks: "",
    score: 20,
    required_fit: 6,
    preferred_fit: 0,
    budget_fit: 6,
    ops_fit: 4,
    egress_fit: 2,
  };
}

const CLOUDFLARE_PROGRAMS = [
  {
    kind: "startup_credit",
    name: "Cloudflare for Startups",
    creditMaxCents: 250_000_00,
    creditDurationMonths: 12,
    creditMonthlyCapCents: null,
    confidence: "corroborated",
    provider: { slug: "cloudflare" },
    tiers: [],
  },
  {
    kind: "committed_spend",
    name: "Enterprise contract",
    creditMaxCents: null,
    creditDurationMonths: null,
    creditMonthlyCapCents: null,
    confidence: "corroborated",
    provider: { slug: "cloudflare" },
    tiers: [{ minAnnualCommitUsd: 36_000, discountBps: 1500 }],
  },
];

// The demo Heroku account's bill, a year of it: $38,748, over the $36k tier.
const HEROKU_ANNUAL_CENTS = 322_900 * 12;

const profile = {
  runtime: "node_server",
  requiredCapabilities: [],
  preferredCapabilities: [],
  budgetMonthlyCents: 322_900,
  opsTolerance: 1,
  trafficGbMonth: 50,
  annualSpendCents: HEROKU_ANNUAL_CENTS,
  startupCreditsEligible: false,
};

interface Priced {
  slug: string;
  pricing: { steadyStateMonthlyCents: number; applied: { name: string }[] };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.queryRaw.mockResolvedValue([cloudflareRow(1500)]);
  h.programs.mockResolvedValue(CLOUDFLARE_PROGRAMS);
});

describe("POST /providers/recommendations", () => {
  it("does not qualify a $15/mo target for a tier on today's $3,229/mo bill", async () => {
    const out = await call("post", "/recommendations", { body: profile });

    expect(out.status).toBe(200);
    const [cf] = out.body as Priced[];
    // $180/yr of Cloudflare is nowhere near the $36,000/yr commitment. Sized
    // off the bill being left, this came out 15% off.
    expect(cf.pricing.steadyStateMonthlyCents).toBe(1500);
    expect(cf.pricing.applied).toEqual([]);
  });

  it("still applies the tier when the target's own price reaches it", async () => {
    // $3,000/mo on Cloudflare is exactly $36,000/yr: the boundary, from the
    // other side, so the fix has not simply switched tiers off.
    h.queryRaw.mockResolvedValue([cloudflareRow(300_000)]);
    const out = await call("post", "/recommendations", {
      body: { ...profile, annualSpendCents: undefined },
    });

    const [cf] = out.body as Priced[];
    expect(cf.pricing.steadyStateMonthlyCents).toBe(255_000);
    expect(cf.pricing.applied.map((a) => a.name)).toEqual(["Enterprise contract"]);
  });

  it("rejects a profile it cannot read", async () => {
    const out = await call("post", "/recommendations", {
      body: { ...profile, runtime: "mainframe" },
    });
    expect(out.status).toBe(400);
    expect(h.queryRaw).not.toHaveBeenCalled();
  });
});

describe("GET /providers/app-profiles/:id/recommendations", () => {
  it("prices a saved profile on the target, not on the annual spend it stored", async () => {
    h.profile.mockResolvedValue({ id: "ap1", orgId: "org-a", name: "api", ...profile });

    const out = await call("get", "/app-profiles/:id/recommendations", {
      params: { id: "ap1" },
    });

    expect(out.status).toBe(200);
    const [cf] = out.body as Priced[];
    expect(cf.pricing.steadyStateMonthlyCents).toBe(1500);
    expect(cf.pricing.applied).toEqual([]);
  });

  it("looks the profile up within the caller's org only", async () => {
    // What Postgres does with { id, orgId } for another org's id: no row.
    h.profile.mockImplementation(async ({ where }: { where: { id: string; orgId?: string } }) =>
      where.orgId === "org-b" ? { id: where.id, orgId: "org-b", name: "api", ...profile } : null
    );

    const out = await call("get", "/app-profiles/:id/recommendations", {
      params: { id: "ap-of-org-b" },
    });

    expect(out.status).toBe(404);
    expect(h.profile).toHaveBeenCalledWith({ where: { id: "ap-of-org-b", orgId: "org-a" } });
    expect(h.queryRaw).not.toHaveBeenCalled();
  });
});
