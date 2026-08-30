// Workload-sized target pricing.
//
// The options page used to price every target at its flat catalog "typical"
// number, which claimed a $3,229/mo Heroku workload fits in $20 of Railway.
// Nobody who owns that infrastructure believes that, so the savings headline
// read as a scam. This module sizes the two executable targets (Cloudflare,
// Hetzner — the ones codegen can produce) from what the assessment actually
// found; everything else returns null and the UI makes no savings claim.
//
// Prices verified against published pricing, August 2026:
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
      case "vercel:project": {
        frontendProjects += 1;
        break;
      }
      case "vercel:usage": {
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
        break;
      }
      default:
        break;
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
// Companion sizing shared by both targets
// ---------------------------------------------------------------------------

function dataLineItems(footprint: WorkloadFootprint): SizingLineItem[] {
  const items: SizingLineItem[] = [];
  if (footprint.postgresTier === "large") {
    items.push({
      label: "Neon Postgres (2 CU always-on + storage)",
      monthlyCents: 18000,
      note: "Replaces a premium/standard Heroku Postgres; usage-based, scales to zero off-peak.",
    });
  } else if (footprint.postgresTier === "small") {
    items.push({
      label: "Neon Postgres (1 CU + storage)",
      monthlyCents: 8000,
      note: "Usage-based; scales to zero when idle.",
    });
  }
  if (footprint.redisTier === "large") {
    items.push({
      label: "Upstash Redis (5GB fixed)",
      monthlyCents: 10000,
      note: "Flat-rate serverless Redis.",
    });
  } else if (footprint.redisTier === "small") {
    items.push({
      label: "Upstash Redis (250MB fixed)",
      monthlyCents: 1000,
      note: "Flat-rate serverless Redis.",
    });
  }
  return items;
}

// ---------------------------------------------------------------------------
// Target models
// ---------------------------------------------------------------------------

// Hetzner dedicated-vCPU instances, USD cents/mo (EUR list ~+10%, Aug 2026).
const HETZNER_CCX: { name: string; ramGb: number; vcpu: number; cents: number }[] = [
  { name: "CCX43", ramGb: 64, vcpu: 16, cents: 10700 },
  { name: "CCX33", ramGb: 32, vcpu: 8, cents: 5400 },
  { name: "CCX23", ramGb: 16, vcpu: 4, cents: 2700 },
  { name: "CCX13", ramGb: 8, vcpu: 2, cents: 1400 },
];

function sizeHetzner(footprint: WorkloadFootprint): OptionSizing {
  const items: SizingLineItem[] = [];

  // Cover total RAM with ~30% headroom using the largest instances first.
  let neededGb = Math.ceil((footprint.totalRamMb / 1024) * 1.3);
  if (neededGb < 4) neededGb = 4;
  const picks = new Map<string, number>();
  while (neededGb > 0) {
    const fit =
      HETZNER_CCX.find((i) => i.ramGb <= neededGb) ??
      HETZNER_CCX[HETZNER_CCX.length - 1];
    picks.set(fit.name, (picks.get(fit.name) ?? 0) + 1);
    neededGb -= fit.ramGb;
  }
  for (const [name, count] of picks) {
    const spec = HETZNER_CCX.find((i) => i.name === name)!;
    items.push({
      label: `${count}× ${name} (${spec.vcpu} vCPU / ${spec.ramGb}GB, dedicated)`,
      monthlyCents: spec.cents * count,
      note: "Sized to cover measured RAM with 30% headroom. 20TB+ egress included per instance.",
    });
  }

  if (footprint.webInstances > 1) {
    items.push({
      label: "Load balancer (LB11)",
      monthlyCents: 700,
      note: "Spreads web traffic across instances; health checks included.",
    });
  }

  items.push({
    label: `Egress (~${Math.round(footprint.bandwidthGbMonth)}GB/mo)`,
    monthlyCents: 0,
    note: "Included — every instance ships with 20TB+ of free egress.",
  });

  items.push(...dataLineItems(footprint));

  return {
    lineItems: items,
    monthlyCents: items.reduce((s, i) => s + i.monthlyCents, 0),
    confidence: "corroborated",
  };
}

function sizeCloudflare(footprint: WorkloadFootprint): OptionSizing {
  const items: SizingLineItem[] = [];

  items.push({
    label: "Workers Paid plan",
    monthlyCents: 500,
    note: "Includes 10M requests and 30M CPU-ms per month. No per-seat pricing.",
  });

  const overageM = Math.max(0, footprint.requestsMillionsMonth - 10);
  if (overageM > 0) {
    items.push({
      label: `Requests beyond included (~${Math.round(overageM)}M/mo)`,
      monthlyCents: Math.round(overageM * 30),
      note: "$0.30 per million requests.",
    });
    // ~10ms CPU per request is a generous SSR estimate; billed on active
    // CPU only, not wall-clock waiting on fetches or the database.
    const cpuOverageM = Math.max(
      0,
      footprint.requestsMillionsMonth * 10 - 30
    );
    if (cpuOverageM > 0) {
      items.push({
        label: "CPU time beyond included",
        monthlyCents: Math.round(cpuOverageM * 2),
        note: "$0.02 per million CPU-ms; you pay for active CPU, not waiting.",
      });
    }
  }

  if (footprint.objectStorageGb > 0) {
    items.push({
      label: `R2 storage (~${Math.round(footprint.objectStorageGb)}GB)`,
      monthlyCents: Math.round(footprint.objectStorageGb * 1.5),
      note: "$0.015/GB-month, and reads leave the building free.",
    });
  }

  items.push({
    label: `Egress (~${Math.round(footprint.bandwidthGbMonth)}GB/mo)`,
    monthlyCents: 0,
    note: "Cloudflare does not bill bandwidth. This line is usually why people leave Vercel.",
  });

  items.push({
    label: "Team seats",
    monthlyCents: 0,
    note: "No per-seat pricing on Workers. Everyone deploys.",
  });

  items.push(...dataLineItems(footprint));

  return {
    lineItems: items,
    monthlyCents: items.reduce((s, i) => s + i.monthlyCents, 0),
    confidence: "corroborated",
  };
}

const MODELS: Record<string, (f: WorkloadFootprint) => OptionSizing> = {
  cloudflare: sizeCloudflare,
  hetzner: sizeHetzner,
};

/** Sized estimate for a target, or null when no model exists — callers make
 * no savings claim for unsized targets. */
export function sizeTarget(
  slug: string,
  footprint: WorkloadFootprint
): OptionSizing | null {
  const model = MODELS[slug];
  return model ? model(footprint) : null;
}
