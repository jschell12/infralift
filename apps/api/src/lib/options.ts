// Migration options: turn an assessment's inventory into a ranked list of
// target providers with effective pricing, savings vs current spend, and
// companion services for capabilities a target lacks.
//
// The inference layer is deliberately simple and explainable — every need it
// derives carries the inventory item that implied it, and the profile it
// builds is returned to the caller so the UI can show its work.

import type {
  CompanionSuggestion,
  InferredNeed,
  MigrationOption,
  MigrationOptionsReport,
  Provider,
  ResourceInventoryItem,
} from "@infralift/shared";
import { prisma } from "./db.js";
import { computeExitToll } from "./exit-toll.js";
import { recommend, type RecommendInput } from "./recommend.js";
import { computeFootprint, sizeTarget } from "./sizing.js";

// ---------------------------------------------------------------------------
// Need inference
// ---------------------------------------------------------------------------

const NEED_LABELS: Record<string, string> = {
  ssr: "Server-side rendering",
  full_node_runtime: "Long-running Node process",
  managed_postgres: "Managed Postgres",
  managed_redis: "Managed Redis",
  background_workers: "Background workers",
  cron: "Scheduled jobs",
  object_storage: "Object storage",
};

interface InferredProfile {
  runtime: RecommendInput["runtime"];
  needs: InferredNeed[];
}

export function inferProfile(
  inventory: ResourceInventoryItem[]
): InferredProfile {
  const needs = new Map<string, InferredNeed>();
  const add = (key: string, evidence: string) => {
    if (!needs.has(key)) {
      needs.set(key, { key, label: NEED_LABELS[key] ?? key, evidence });
    }
  };

  let hasWebDyno = false;
  let hasFrontendProject = false;
  let hasServerlessFns = false;

  for (const item of inventory) {
    const meta = (item.metadata ?? {}) as Record<string, unknown>;
    const name = item.name.toLowerCase();

    switch (item.type) {
      case "vercel:project":
      case "netlify:site": {
        hasFrontendProject = true;
        if ((meta.framework as string) === "nextjs" || name.includes("next")) {
          add("ssr", item.name);
        }
        if (name.includes("cron") || name.includes("worker")) {
          add("cron", item.name);
        }
        break;
      }
      case "heroku:dyno": {
        const processType =
          (meta.processType as string) ?? item.externalId.split(":")[1] ?? "";
        if (processType === "web") {
          hasWebDyno = true;
          add("full_node_runtime", item.name);
        } else {
          add("background_workers", item.name);
        }
        break;
      }
      case "heroku:addon": {
        const plan = ((meta.plan as string) ?? "").toLowerCase();
        if (plan.includes("postgres") || name.includes("postgres")) {
          add("managed_postgres", item.name);
        }
        if (plan.includes("redis") || name.includes("redis")) {
          add("managed_redis", item.name);
        }
        if (plan.includes("scheduler")) {
          add("cron", item.name);
        }
        break;
      }
      case "vercel:postgres":
      case "render:postgres": {
        add("managed_postgres", item.name);
        break;
      }
      case "render:redis": {
        add("managed_redis", item.name);
        break;
      }
      case "railway:service": {
        hasWebDyno = true;
        add("full_node_runtime", item.name);
        if (name.includes("cron") || name.includes("worker")) {
          add("background_workers", item.name);
        }
        break;
      }
      case "railway:plugin": {
        const kind = `${meta.pluginType ?? ""} ${name}`.toLowerCase();
        if (kind.includes("postgres")) add("managed_postgres", item.name);
        if (kind.includes("redis")) add("managed_redis", item.name);
        break;
      }
      case "digitalocean:droplet":
      case "digitalocean:app": {
        hasWebDyno = true;
        add("full_node_runtime", item.name);
        break;
      }
      case "digitalocean:database": {
        const engine = String(meta.engine ?? "").toLowerCase();
        if (engine === "pg" || engine.includes("postgres")) {
          add("managed_postgres", item.name);
        }
        if (engine.includes("redis") || engine.includes("valkey")) {
          add("managed_redis", item.name);
        }
        break;
      }
      case "firebase:hosting_site": {
        hasFrontendProject = true;
        break;
      }
      case "firebase:function": {
        hasServerlessFns = true;
        const trigger = String(meta.trigger ?? "").toLowerCase();
        if (trigger.includes("schedule") || trigger.includes("pubsub")) {
          add("cron", item.name);
        }
        break;
      }
      default: {
        // Render services arrive as render:<type>; anything with a plan and
        // a service-ish type is compute.
        if (item.type.startsWith("render:") && meta.plan !== undefined) {
          const svcType = String(meta.type ?? item.type.slice(7));
          if (svcType.includes("worker")) {
            add("background_workers", item.name);
          } else if (svcType.includes("cron")) {
            add("cron", item.name);
          } else {
            hasWebDyno = true;
            add("full_node_runtime", item.name);
          }
        }
        break;
      }
    }
  }

  const runtime: RecommendInput["runtime"] = hasWebDyno
    ? "node_server"
    : hasServerlessFns
      ? "serverless_fn"
      : hasFrontendProject
        ? "ssr"
        : "static";

  return { runtime, needs: Array.from(needs.values()) };
}

// ---------------------------------------------------------------------------
// Companion services
// ---------------------------------------------------------------------------

// managed_redis is not a catalog capability, so a redis need always attaches
// a companion. managed_postgres attaches one only when the target's own
// capability score is weak.
const COMPANIONS: Record<string, CompanionSuggestion> = {
  managed_postgres: {
    name: "Neon Postgres",
    covers: "managed_postgres",
    monthlyCents: 1900,
    note: "Serverless Postgres with branching; free tier covers dev/staging. Heroku Postgres migrations are pg_dump/pg_restore.",
  },
  managed_redis: {
    name: "Upstash Redis",
    covers: "managed_redis",
    monthlyCents: 1000,
    note: "Serverless Redis, per-request pricing; free tier for light use. Or the target's own add-on where one exists.",
  },
};

// Capability keys recommend() should treat as hard requirements. Everything
// else inferred stays preferred-only so it influences ranking without
// filtering out targets a companion could complete.
const HARD_REQUIREMENT_KEYS = new Set(["background_workers"]);

// ---------------------------------------------------------------------------
// Options builder
// ---------------------------------------------------------------------------

const CODEGEN_TARGETS: Record<string, "cloudflare" | "hetzner"> = {
  cloudflare: "cloudflare",
  hetzner: "hetzner",
};

export async function buildMigrationOptions(assessment: {
  id: string;
  provider: string;
  estimatedMonthlyCostCents: number | null;
  inventory: ResourceInventoryItem[];
}): Promise<MigrationOptionsReport> {
  const { runtime, needs } = inferProfile(assessment.inventory);
  const currentMonthlyCents = assessment.estimatedMonthlyCostCents ?? 0;

  const required = needs
    .filter((n) => HARD_REQUIREMENT_KEYS.has(n.key))
    .map((n) => n.key);
  const preferred = needs
    .filter((n) => !HARD_REQUIREMENT_KEYS.has(n.key))
    .map((n) => n.key);

  // Budget: current spend, floored so a tiny account still gets ranked
  // against realistic entry pricing.
  const budgetMonthlyCents = Math.max(currentMonthlyCents, 2000);

  const input: RecommendInput = {
    runtime,
    requiredCapabilities: required,
    preferredCapabilities: preferred,
    budgetMonthlyCents,
    opsTolerance: 1, // PaaS customers by definition; VPS targets rank lower, honestly
    trafficGbMonth: 50,
    annualSpendCents: Math.max(currentMonthlyCents, 2000) * 12,
    startupCreditsEligible: false,
  };

  const ranked = await recommend(input);

  // Everything except the provider being left, top 6 — plus any target we can
  // generate IaC for that cleared the hard filter but ranked below the cut.
  // Those are the migrations infralift can actually execute; a customer
  // should always see them (ranked honestly) rather than have the cut hide
  // them. Hetzner routinely lands at #7 for PaaS workloads because its
  // managedLevel of 0 is penalized by opsFit.
  const eligible = ranked.filter((r) => r.slug !== assessment.provider);
  const candidates = [
    ...eligible.slice(0, 6),
    ...eligible.slice(6).filter((r) => CODEGEN_TARGETS[r.slug] !== undefined),
  ];

  // Capability scores for gap/companion detection.
  const needKeys = needs.map((n) => n.key);
  const capRows = needKeys.length
    ? await prisma.providerCapability.findMany({
        where: {
          key: { in: needKeys },
          provider: { slug: { in: candidates.map((c) => c.slug) } },
        },
        select: { key: true, score: true, provider: { select: { slug: true } } },
      })
    : [];
  const capScore = new Map<string, number>();
  for (const row of capRows) {
    capScore.set(`${row.provider.slug}:${row.key}`, row.score);
  }

  // Workload footprint for sized target pricing.
  const footprint = computeFootprint(assessment.inventory);

  const options: MigrationOption[] = candidates.map((c) => {
    const companions: CompanionSuggestion[] = [];
    const gaps: string[] = [];

    for (const need of needs) {
      // Missing capability rows score 0 (managed_redis has no rows at all).
      const score = capScore.get(`${c.slug}:${need.key}`) ?? 0;
      if (score >= 2) continue;
      gaps.push(need.key);
      const companion = COMPANIONS[need.key];
      if (companion) companions.push(companion);
    }

    // Sized targets: the estimate is built from the measured workload
    // (data services folded into the line items) and owns the savings math.
    // Unsized targets: flat catalog pricing stays visible but no savings
    // claim is made — an absent number beats an absurd one.
    const sizing = sizeTarget(c.slug, footprint);
    let monthlySavingsCents: number | null = null;
    if (sizing) {
      monthlySavingsCents = currentMonthlyCents - sizing.monthlyCents;
    }

    return {
      slug: c.slug,
      name: c.name,
      category: c.category,
      score: c.score,
      pricing: c.pricing,
      sizing,
      monthlySavingsCents,
      benefits: c.benefits,
      drawbacks: c.drawbacks,
      managedLevel: c.managedLevel,
      // Sized line items already include the data services; keep companions
      // only for unsized targets so nothing double-counts.
      companions: sizing ? [] : companions,
      gaps,
      codegenTarget: CODEGEN_TARGETS[c.slug] ?? null,
    };
  });

  // Sized options lead: their numbers are defensible line by line, and they
  // are the migrations infralift can execute. Within each group, best
  // savings first, then score.
  options.sort((a, b) => {
    if (!!a.sizing !== !!b.sizing) return a.sizing ? -1 : 1;
    if (a.sizing && b.sizing) {
      return (b.monthlySavingsCents ?? 0) - (a.monthlySavingsCents ?? 0);
    }
    return b.score - a.score;
  });

  return {
    assessmentId: assessment.id,
    provider: assessment.provider as Provider,
    currentMonthlyCents,
    needs,
    profile: {
      runtime,
      requiredCapabilities: required,
      budgetMonthlyCents,
      trafficGbMonth: input.trafficGbMonth,
    },
    // The migration doc promises this before approval, and it is the question
    // every buyer asks after seeing the monthly savings.
    exitToll: computeExitToll(
      assessment.provider as Provider,
      assessment.inventory
    ),
    options,
  };
}
