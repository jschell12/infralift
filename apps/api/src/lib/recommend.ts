import { Prisma } from "@prisma/client";
import { prisma } from "./db.js";

export interface RecommendInput {
  runtime: "static" | "ssr" | "node_server" | "container" | "serverless_fn";
  requiredCapabilities: string[];
  preferredCapabilities: string[];
  budgetMonthlyCents: number;
  opsTolerance: number; // 0 wants zero devops … 3 happy to run servers
  trafficGbMonth: number;
}

export interface Recommendation {
  slug: string;
  name: string;
  category: string;
  pricingModel: string;
  minMonthlyCents: number;
  typicalMonthlyCents: number;
  managedLevel: number;
  egressFreeGb: number;
  benefits: string;
  drawbacks: string;
  score: number;
  scoreBreakdown: {
    requiredFit: number;
    preferredFit: number;
    budgetFit: number;
    opsFit: number;
    egressFit: number;
  };
}

// Each runtime implies one hard capability requirement.
const RUNTIME_CAP: Record<RecommendInput["runtime"], string> = {
  static: "static_hosting",
  ssr: "ssr",
  node_server: "full_node_runtime",
  container: "containers",
  serverless_fn: "autoscaling",
};

/**
 * Score providers against an app profile, in Postgres.
 *
 * Hard filter: every required capability (including the runtime's implied
 * capability) must score >= 2 on the provider. Ranking:
 *   requiredFit  = sum(required cap scores) * 2
 *   preferredFit = sum(preferred cap scores)
 *   budgetFit    = +6 within budget, +3 within 2x budget, else 0
 *   opsFit       = +4 when managedLevel covers the ops the user won't do,
 *                  else -3 per level of missing management
 *   egressFit    = +2 when free egress covers expected traffic
 */
export async function recommend(
  input: RecommendInput
): Promise<Recommendation[]> {
  const required = Array.from(
    new Set([RUNTIME_CAP[input.runtime], ...input.requiredCapabilities])
  );
  const preferred = input.preferredCapabilities;
  const neededManagedLevel = 3 - Math.min(3, Math.max(0, input.opsTolerance));

  const rows = await prisma.$queryRaw<
    Array<{
      slug: string;
      name: string;
      category: string;
      pricingModel: string;
      minMonthlyCents: number;
      typicalMonthlyCents: number;
      managedLevel: number;
      egressFreeGb: number;
      benefits: string;
      drawbacks: string;
      required_fit: number;
      preferred_fit: number;
      budget_fit: number;
      ops_fit: number;
      egress_fit: number;
      score: number;
    }>
  >(Prisma.sql`
    WITH scored AS (
      SELECT
        p.slug, p.name, p.category, p."pricingModel",
        p."minMonthlyCents", p."typicalMonthlyCents",
        p."managedLevel", p."egressFreeGb", p.benefits, p.drawbacks,
        rq.met_count, rq.req_score * 2 AS required_fit,
        COALESCE(pf.pref_score, 0) AS preferred_fit,
        CASE
          WHEN p."typicalMonthlyCents" <= ${input.budgetMonthlyCents} THEN 6
          WHEN p."typicalMonthlyCents" <= ${input.budgetMonthlyCents} * 2 THEN 3
          ELSE 0
        END AS budget_fit,
        CASE
          WHEN p."managedLevel" >= ${neededManagedLevel} THEN 4
          ELSE (p."managedLevel" - ${neededManagedLevel}) * 3
        END AS ops_fit,
        CASE
          WHEN p."egressFreeGb" = -1 OR p."egressFreeGb" >= ${input.trafficGbMonth} THEN 2
          ELSE 0
        END AS egress_fit
      FROM "HostingProvider" p
      CROSS JOIN LATERAL (
        SELECT
          COUNT(*) FILTER (WHERE c.score >= 2) AS met_count,
          COALESCE(SUM(c.score), 0)::int AS req_score
        FROM unnest(${required}::text[]) AS r(key)
        LEFT JOIN "ProviderCapability" c
          ON c."providerId" = p.id AND c.key = r.key
      ) rq
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(c.score), 0)::int AS pref_score
        FROM unnest(${preferred}::text[]) AS r(key)
        JOIN "ProviderCapability" c
          ON c."providerId" = p.id AND c.key = r.key
      ) pf ON true
      WHERE rq.met_count = cardinality(${required}::text[])
    )
    SELECT *,
      (required_fit + preferred_fit + budget_fit + ops_fit + egress_fit)::int AS score
    FROM scored
    ORDER BY score DESC, "typicalMonthlyCents" ASC
  `);

  return rows.map((r) => ({
    slug: r.slug,
    name: r.name,
    category: r.category,
    pricingModel: r.pricingModel,
    minMonthlyCents: r.minMonthlyCents,
    typicalMonthlyCents: r.typicalMonthlyCents,
    managedLevel: r.managedLevel,
    egressFreeGb: r.egressFreeGb,
    benefits: r.benefits,
    drawbacks: r.drawbacks,
    score: Number(r.score),
    scoreBreakdown: {
      requiredFit: Number(r.required_fit),
      preferredFit: Number(r.preferred_fit),
      budgetFit: Number(r.budget_fit),
      opsFit: Number(r.ops_fit),
      egressFit: Number(r.egress_fit),
    },
  }));
}
