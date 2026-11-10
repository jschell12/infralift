// Workload-sized target pricing.
//
// The options page used to price every target at its flat catalog "typical"
// number, which claimed a $3,229/mo Heroku workload fits in $20 of Railway.
// Nobody who owns that infrastructure believes that, so the savings headline
// read as a scam. This module sizes the two executable targets (Cloudflare,
// Hetzner — the ones codegen can produce) from what the assessment actually
// found; everything else returns null and the UI makes no savings claim.
//
// Prices verified against published pricing on PRICES_VERIFIED_AT
// (lib/pricing.ts), which the UI shows and a test keeps from going stale:
//   - Hetzner CCX (dedicated vCPU), post-June-2026 increase, EUR list
//     converted to USD cents (~1.1) and rounded up
//   - Cloudflare Workers Paid: $5/mo incl 10M requests + 30M CPU-ms;
//     $0.30/M requests, $0.02/M CPU-ms beyond; R2 $0.015/GB-mo; egress $0
//   - Neon: usage-based, ~$0.106/CU-hour (1 CU = 1 vCPU/4GB) on Launch,
//     storage $0.35/GB-mo; always-on 1 CU ≈ $77/mo
//   - Upstash Redis fixed: 250MB $10, 1GB $20, 5GB $100

import type {
  OptionSizing,
  ResourceInventoryItem,
  SizingLineItem,
} from "@infralift/shared";

// ---------------------------------------------------------------------------
// Footprint: what the workload actually consumes
// ---------------------------------------------------------------------------

export interface WorkloadFootprint {
  /** always-on RAM across web + worker processes, MB */
  totalRamMb: number;
  webInstances: number;
  workerInstances: number;
  bandwidthGbMonth: number;
  requestsMillionsMonth: number;
  /** null = no postgres need; small ≈ hobby/essential; large ≈ standard/premium */
  postgresTier: "small" | "large" | null;
  redisTier: "small" | "large" | null;
  objectStorageGb: number;
}

// RAM per Heroku dyno size. Published dyno specs; performance dynos are
// dedicated instances.
const HEROKU_DYNO_RAM_MB: Record<string, number> = {
  eco: 512,
  basic: 512,
  "standard-1x": 512,
  "standard-2x": 1024,
  "performance-m": 2560,
  "performance-l": 14336,
};

// RAM per Render instance plan (published specs).
const RENDER_PLAN_RAM_MB: Record<string, number> = {
  free: 512,
  starter: 512,
  "starter plus": 1024,
  standard: 2048,
  pro: 4096,
  "pro plus": 8192,
  "pro max": 16384,
  "pro ultra": 32768,
};

export function computeFootprint(
  inventory: ResourceInventoryItem[]
): WorkloadFootprint {
  let totalRamMb = 0;
  let webInstances = 0;
  let workerInstances = 0;
  let bandwidthGbMonth = 0;
  let requestsMillionsMonth = 0;
  let postgresTier: WorkloadFootprint["postgresTier"] = null;
  let redisTier: WorkloadFootprint["redisTier"] = null;
  let objectStorageGb = 0;
  let frontendProjects = 0;

  for (const item of inventory) {
    const meta = (item.metadata ?? {}) as Record<string, unknown>;

    // Usage items (any provider): observed billing volumes, not resources.
    if (item.type.endsWith(":usage")) {
      const kind = String(meta.kind ?? "");
      if (kind === "bandwidth") {
        bandwidthGbMonth += Number(meta.gbMonth ?? 0);
      }
      if (kind === "invocations") {
        requestsMillionsMonth += Number(meta.millions ?? 0);
      }
      if (kind === "storage") {
        objectStorageGb += Number(meta.storedGb ?? 0);
      }
      continue;
    }

    switch (item.type) {
      case "heroku:dyno": {
        const size = String(meta.size ?? "").toLowerCase();
        const quantity = Number(meta.quantity ?? 1);
        const ram = HEROKU_DYNO_RAM_MB[size] ?? 512;
        totalRamMb += ram * quantity;
        const processType = item.externalId.split(":")[1] ?? "web";
        if (processType === "web") webInstances += quantity;
        else workerInstances += quantity;
        break;
      }
      case "digitalocean:droplet":
      case "flyio:machine": {
        const ram = Number(meta.memoryMb ?? 1024);
        totalRamMb += ram;
        webInstances += 1;
        break;
      }
      case "heroku:addon": {
        const plan = String(meta.plan ?? "").toLowerCase();
        if (plan.includes("postgres")) {
          postgresTier =
            plan.includes("premium") || plan.includes("standard")
              ? "large"
              : (postgresTier ?? "small");
        }
        if (plan.includes("redis")) {
          redisTier = plan.includes("premium")
            ? "large"
            : (redisTier ?? "small");
        }
        break;
      }
      case "vercel:project":
      case "firebase:hosting_site": {
        frontendProjects += 1;
        break;
      }
      case "render:postgres": {
        const plan = String(meta.plan ?? "").toLowerCase();
        postgresTier =
          plan.includes("pro") || plan.includes("standard")
            ? "large"
            : (postgresTier ?? "small");
        break;
      }
      case "render:redis": {
        const plan = String(meta.plan ?? "").toLowerCase();
        redisTier = plan.includes("pro") ? "large" : (redisTier ?? "small");
        break;
      }
      case "railway:service": {
        // Railway's API exposes no instance sizes; a service is a container,
        // assume a modest node process.
        totalRamMb += 1024;
        webInstances += 1;
        break;
      }
      case "railway:plugin": {
        const kind =
          `${meta.pluginType ?? ""} ${item.name}`.toLowerCase();
        if (kind.includes("postgres")) postgresTier = postgresTier ?? "small";
        if (kind.includes("redis")) redisTier = redisTier ?? "small";
        break;
      }
      case "digitalocean:app": {
        totalRamMb += 1024;
        webInstances += 1;
        break;
      }
      case "digitalocean:database": {
        const engine = String(meta.engine ?? "").toLowerCase();
        const size = String(meta.size ?? "").toLowerCase();
        const nodes = Number(meta.numNodes ?? 1);
        const large = nodes > 1 || !size.includes("db-s");
        if (engine === "pg" || engine.includes("postgres")) {
          postgresTier = large ? "large" : (postgresTier ?? "small");
        }
        if (engine.includes("redis") || engine.includes("valkey")) {
          redisTier = large ? "large" : (redisTier ?? "small");
        }
        break;
      }
      default: {
        // Render services arrive as render:<type> with type in metadata.
        if (item.type.startsWith("render:") && meta.plan !== undefined) {
          const plan = String(meta.plan ?? "").toLowerCase();
          const ram = RENDER_PLAN_RAM_MB[plan] ?? 512;
          totalRamMb += ram;
          const svcType = String(meta.type ?? item.type.slice(7));
          if (svcType.includes("worker") || svcType.includes("cron")) {
            workerInstances += 1;
          } else {
            webInstances += 1;
          }
        }
        break;
      }
    }
  }

  // Frontend platforms hide their compute; approximate a small node server
  // per two projects for VPS sizing purposes.
  if (totalRamMb === 0 && frontendProjects > 0) {
    webInstances = Math.max(1, Math.ceil(frontendProjects / 2));
    totalRamMb = webInstances * 1024;
  }

  // Defaults where the assessment could not observe usage.
  if (bandwidthGbMonth === 0) bandwidthGbMonth = 50;
  if (requestsMillionsMonth === 0) requestsMillionsMonth = 5;

  return {
    totalRamMb,
    webInstances,
    workerInstances,
    bandwidthGbMonth,
    requestsMillionsMonth,
    postgresTier,
    redisTier,
    objectStorageGb,
  };
}

// ---------------------------------------------------------------------------
// Target plan: the architecture decision, shared by pricing and codegen
// ---------------------------------------------------------------------------
//
// Pricing and code generation used to decide the target shape independently.
// This module fitted CCX instances to the measured RAM; codegen emitted a
// comment recommending a CPX31 and no servers at all. A customer could read
// "$422/mo across a CCX43 and two CCX13s" on the options page and then
// generate Terraform that stood up none of it. Both now read the same plan, so
// the estimate and the HCL describe the same infrastructure by construction.

export interface HetznerInstanceGroup {
  /** hcloud `server_type` argument, e.g. "ccx43" */
  serverType: string;
  /** name as it appears in pricing labels, e.g. "CCX43" */
  displayName: string;
  vcpu: number;
  ramGb: number;
  count: number;
  monthlyCentsEach: number;
}

export interface PostgresPlan {
  tier: "small" | "large";
  /** Neon autoscaling bounds, in compute units */
  minComputeUnits: number;
  maxComputeUnits: number;
  monthlyCents: number;
  label: string;
  note: string;
}

export interface RedisPlan {
  tier: "small" | "large";
  /** headline size the price is quoted against */
  sizeLabel: string;
  /** Upstash spend cap, whole dollars */
  budgetUsd: number;
  monthlyCents: number;
  label: string;
  note: string;
}

export interface TargetPlan {
  target: string;
  hetzner: { instances: HetznerInstanceGroup[]; loadBalancer: boolean } | null;
  cloudflare: { r2Gb: number; requestsMillionsMonth: number } | null;
  postgres: PostgresPlan | null;
  redis: RedisPlan | null;
  webInstances: number;
  workerInstances: number;
  bandwidthGbMonth: number;
}

function planData(footprint: WorkloadFootprint): {
  postgres: PostgresPlan | null;
  redis: RedisPlan | null;
} {
  let postgres: PostgresPlan | null = null;
  if (footprint.postgresTier === "large") {
    postgres = {
      tier: "large",
      minComputeUnits: 0.5,
      maxComputeUnits: 2,
      monthlyCents: 18000,
      label: "Neon Postgres (2 CU always-on + storage)",
      note: "Replaces a premium/standard Heroku Postgres; usage-based, scales to zero off-peak.",
    };
  } else if (footprint.postgresTier === "small") {
    postgres = {
      tier: "small",
      minComputeUnits: 0.25,
      maxComputeUnits: 1,
      monthlyCents: 8000,
      label: "Neon Postgres (1 CU + storage)",
      note: "Usage-based; scales to zero when idle.",
    };
  }

  let redis: RedisPlan | null = null;
  if (footprint.redisTier === "large") {
    redis = {
      tier: "large",
      sizeLabel: "5GB",
      budgetUsd: 100,
      monthlyCents: 10000,
      label: "Upstash Redis (5GB fixed)",
      note: "Flat-rate serverless Redis.",
    };
  } else if (footprint.redisTier === "small") {
    redis = {
      tier: "small",
      sizeLabel: "250MB",
      budgetUsd: 10,
      monthlyCents: 1000,
      label: "Upstash Redis (250MB fixed)",
      note: "Flat-rate serverless Redis.",
    };
  }

  return { postgres, redis };
}

function dataLineItems(plan: TargetPlan): SizingLineItem[] {
  const items: SizingLineItem[] = [];
  if (plan.postgres) {
    items.push({
      label: plan.postgres.label,
      monthlyCents: plan.postgres.monthlyCents,
      note: plan.postgres.note,
    });
  }
  if (plan.redis) {
    items.push({
      label: plan.redis.label,
      monthlyCents: plan.redis.monthlyCents,
      note: plan.redis.note,
    });
  }
  return items;
}

// ---------------------------------------------------------------------------
// Target models
// ---------------------------------------------------------------------------

// Hetzner dedicated-vCPU instances, USD cents/mo (EUR list ~+10%, as of
// PRICES_VERIFIED_AT).
const HETZNER_CCX: { name: string; ramGb: number; vcpu: number; cents: number }[] = [
  { name: "CCX43", ramGb: 64, vcpu: 16, cents: 10700 },
  { name: "CCX33", ramGb: 32, vcpu: 8, cents: 5400 },
  { name: "CCX23", ramGb: 16, vcpu: 4, cents: 2700 },
  { name: "CCX13", ramGb: 8, vcpu: 2, cents: 1400 },
];

function planHetzner(footprint: WorkloadFootprint): {
  instances: HetznerInstanceGroup[];
  loadBalancer: boolean;
} {
  // Cover total RAM with ~30% headroom using the largest instances first.
  let neededGb = Math.ceil((footprint.totalRamMb / 1024) * 1.3);
  if (neededGb < 4) neededGb = 4;
  const picks = new Map<string, number>();
  let instanceCount = 0;
  while (neededGb > 0) {
    const fit =
      HETZNER_CCX.find((i) => i.ramGb <= neededGb) ??
      HETZNER_CCX[HETZNER_CCX.length - 1];
    picks.set(fit.name, (picks.get(fit.name) ?? 0) + 1);
    instanceCount += 1;
    neededGb -= fit.ramGb;
  }

  // Heavy traffic needs boxes, not just RAM: one small instance per ~5TB/mo
  // keeps the claim believable (a lone 2-vCPU box "serving 10TB" is the same
  // kind of too-good number this module exists to kill).
  const minForBandwidth = Math.ceil(footprint.bandwidthGbMonth / 5000);
  if (instanceCount < minForBandwidth) {
    const smallest = HETZNER_CCX[HETZNER_CCX.length - 1];
    picks.set(
      smallest.name,
      (picks.get(smallest.name) ?? 0) + (minForBandwidth - instanceCount)
    );
    instanceCount = minForBandwidth;
  }

  const instances: HetznerInstanceGroup[] = [];
  for (const [name, count] of picks) {
    const spec = HETZNER_CCX.find((i) => i.name === name)!;
    instances.push({
      serverType: name.toLowerCase(),
      displayName: name,
      vcpu: spec.vcpu,
      ramGb: spec.ramGb,
      count,
      monthlyCentsEach: spec.cents,
    });
  }

  return { instances, loadBalancer: footprint.webInstances > 1 };
}

/** The target architecture inferred from the workload, or null when no model
 * exists for the slug. Both the priced estimate and the generated HCL are
 * derived from this. */
export function planTarget(
  slug: string,
  footprint: WorkloadFootprint
): TargetPlan | null {
  if (slug !== "hetzner" && slug !== "cloudflare") return null;

  const { postgres, redis } = planData(footprint);
  const base = {
    target: slug,
    postgres,
    redis,
    webInstances: footprint.webInstances,
    workerInstances: footprint.workerInstances,
    bandwidthGbMonth: footprint.bandwidthGbMonth,
  };

  if (slug === "hetzner") {
    return { ...base, hetzner: planHetzner(footprint), cloudflare: null };
  }
  return {
    ...base,
    hetzner: null,
    cloudflare: {
      r2Gb: footprint.objectStorageGb,
      requestsMillionsMonth: footprint.requestsMillionsMonth,
    },
  };
}

function sizeHetzner(plan: TargetPlan): OptionSizing {
  const items: SizingLineItem[] = [];
  const hetzner = plan.hetzner!;

  for (const group of hetzner.instances) {
    items.push({
      label: `${group.count}× ${group.displayName} (${group.vcpu} vCPU / ${group.ramGb}GB, dedicated)`,
      monthlyCents: group.monthlyCentsEach * group.count,
      note: "Sized to cover measured RAM with 30% headroom. 20TB+ egress included per instance.",
    });
  }

  if (hetzner.loadBalancer) {
    items.push({
      label: "Load balancer (LB11)",
      monthlyCents: 700,
      note: "Spreads web traffic across instances; health checks included.",
    });
  }

  items.push({
    label: `Egress (~${Math.round(plan.bandwidthGbMonth)}GB/mo)`,
    monthlyCents: 0,
    note: "Included — every instance ships with 20TB+ of free egress.",
  });

  items.push(...dataLineItems(plan));

  return {
    lineItems: items,
    monthlyCents: items.reduce((s, i) => s + i.monthlyCents, 0),
    confidence: "corroborated",
  };
}

function sizeCloudflare(plan: TargetPlan): OptionSizing {
  const items: SizingLineItem[] = [];
  const { r2Gb, requestsMillionsMonth } = plan.cloudflare!;

  items.push({
    label: "Workers Paid plan",
    monthlyCents: 500,
    note: "Includes 10M requests and 30M CPU-ms per month. No per-seat pricing.",
  });

  const overageM = Math.max(0, requestsMillionsMonth - 10);
  if (overageM > 0) {
    items.push({
      label: `Requests beyond included (~${Math.round(overageM)}M/mo)`,
      monthlyCents: Math.round(overageM * 30),
      note: "$0.30 per million requests.",
    });
    // ~10ms CPU per request is a generous SSR estimate; billed on active
    // CPU only, not wall-clock waiting on fetches or the database.
    const cpuOverageM = Math.max(0, requestsMillionsMonth * 10 - 30);
    if (cpuOverageM > 0) {
      items.push({
        label: "CPU time beyond included",
        monthlyCents: Math.round(cpuOverageM * 2),
        note: "$0.02 per million CPU-ms; you pay for active CPU, not waiting.",
      });
    }
  }

  if (r2Gb > 0) {
    items.push({
      label: `R2 storage (~${Math.round(r2Gb)}GB)`,
      monthlyCents: Math.round(r2Gb * 1.5),
      note: "$0.015/GB-month, and reads leave the building free.",
    });
  }

  items.push({
    label: `Egress (~${Math.round(plan.bandwidthGbMonth)}GB/mo)`,
    monthlyCents: 0,
    note: "Cloudflare does not bill bandwidth. This line is usually why people leave Vercel.",
  });

  items.push({
    label: "Team seats",
    monthlyCents: 0,
    note: "No per-seat pricing on Workers. Everyone deploys.",
  });

  items.push(...dataLineItems(plan));

  return {
    lineItems: items,
    monthlyCents: items.reduce((s, i) => s + i.monthlyCents, 0),
    confidence: "corroborated",
  };
}

const MODELS: Record<string, (p: TargetPlan) => OptionSizing> = {
  cloudflare: sizeCloudflare,
  hetzner: sizeHetzner,
};

/** Sized estimate for a target, or null when no model exists — callers make
 * no savings claim for unsized targets. */
export function sizeTarget(
  slug: string,
  footprint: WorkloadFootprint
): OptionSizing | null {
  const plan = planTarget(slug, footprint);
  const model = plan ? MODELS[slug] : undefined;
  return plan && model ? model(plan) : null;
}
