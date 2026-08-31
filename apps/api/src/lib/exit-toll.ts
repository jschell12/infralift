// One-time cost of getting stored data out of the source provider.
//
// docs/migration-process.md promises this number before a customer approves
// anything, and it is deliberately a different number from the monthly egress
// line on the options page. Two things get conflated:
//
//   - Monthly egress is serving traffic. It stops at cutover and shows up as
//     recurring savings.
//   - The exit toll is stored data leaving, once. A production Postgres is
//     gigabytes, not the terabytes per month it serves, so this is usually
//     small. Large object stores are the exception.
//
// Redis is excluded on purpose: a cache warms on the new side rather than
// migrating, which is the same thing the migration doc tells customers.
//
// Egress rates verified against published pricing, August 2026.

import type { Provider, ResourceInventoryItem } from "@infralift/shared";

export interface ExitTollComponent {
  label: string;
  gb: number;
  centsPerGb: number;
  cents: number;
  /** true when the volume came from the provider's API rather than a plan tier */
  measured: boolean;
  note: string;
}

export interface ExitTollEstimate {
  /** one-time cost to move stored data out, in cents, before any waiver */
  cents: number;
  /** what the customer actually pays once a migration waiver is granted */
  centsAfterWaiver: number;
  totalGb: number;
  components: ExitTollComponent[];
  waiverAvailable: boolean;
  waiverNote: string | null;
  /** measured = every component came from an API; estimated = some inferred
   * from plan tiers, which are ceilings rather than actual usage */
  confidence: "measured" | "estimated" | "none";
  notes: string[];
}

// Per-GB egress out of each source, in cents.
const EXIT_EGRESS: Partial<
  Record<Provider, { centsPerGb: number; waiver: boolean; note: string }>
> = {
  aws: {
    centsPerGb: 9,
    waiver: true,
    note: "AWS waives egress fees for customers migrating off, on request. Formalized after the EU Data Act.",
  },
  gcp: {
    centsPerGb: 12,
    waiver: true,
    note: "Google Cloud waives egress fees for customers migrating off, on request.",
  },
  firebase: {
    centsPerGb: 12,
    waiver: true,
    note: "Firebase bills GCP egress rates, and Google waives them for migrations on request.",
  },
  azure: {
    centsPerGb: 8,
    waiver: true,
    note: "Azure waives egress fees for customers migrating off, on request.",
  },
  vercel: {
    centsPerGb: 15,
    waiver: false,
    note: "Data pulled out counts against Fast Data Transfer at the same rate as serving traffic.",
  },
  netlify: {
    centsPerGb: 55,
    waiver: false,
    note: "Netlify bandwidth overage is the most expensive per GB of any source here.",
  },
  render: {
    centsPerGb: 10,
    waiver: false,
    note: "Render bills bandwidth above the included allowance.",
  },
  railway: {
    centsPerGb: 5,
    waiver: false,
    note: "Railway bills egress per GB with no included tier.",
  },
  digitalocean: {
    centsPerGb: 1,
    waiver: false,
    note: "DigitalOcean transfer overage is $0.01/GB, and droplet allowances usually absorb a one-time dump.",
  },
  flyio: {
    centsPerGb: 2,
    waiver: false,
    note: "Fly.io bills outbound transfer per GB by region.",
  },
  heroku: {
    centsPerGb: 0,
    waiver: false,
    note: "Heroku does not meter egress, so pulling a dump costs nothing beyond the dyno hours to run it.",
  },
  cloudflare: {
    centsPerGb: 0,
    waiver: false,
    note: "Cloudflare does not bill egress, including out of R2.",
  },
};

// Storage ceilings by plan, used when the API does not report actual size.
// These are plan limits, not measured usage, so they overstate.
const HEROKU_PG_GB: Record<string, number> = {
  "essential-0": 1,
  "essential-1": 10,
  "essential-2": 32,
  "standard-0": 64,
  "standard-2": 256,
  "premium-0": 64,
  "premium-2": 256,
  "premium-3": 512,
  "premium-4": 1024,
};

const RENDER_PG_GB: Record<string, number> = {
  free: 1,
  basic_256mb: 1,
  basic_1gb: 16,
  basic_4gb: 64,
  pro: 96,
  pro_plus: 256,
  standard: 64,
};

function herokuPgSize(plan: string): number {
  const tier = plan.split(":").pop() ?? "";
  for (const [key, gb] of Object.entries(HEROKU_PG_GB)) {
    if (tier.includes(key)) return gb;
  }
  // Unknown paid tier: assume a mid-size production database rather than a
  // ceiling that would inflate the toll.
  return 32;
}

export function computeExitToll(
  provider: Provider,
  inventory: ResourceInventoryItem[]
): ExitTollEstimate {
  const rate = EXIT_EGRESS[provider];
  const centsPerGb = rate?.centsPerGb ?? 9;
  const components: ExitTollComponent[] = [];
  const notes: string[] = [];

  const add = (
    label: string,
    gb: number,
    measured: boolean,
    note: string
  ) => {
    if (gb <= 0) return;
    components.push({
      label,
      gb,
      centsPerGb,
      cents: Math.round(gb * centsPerGb),
      measured,
      note,
    });
  };

  let sawRedis = false;

  for (const item of inventory) {
    const meta = (item.metadata ?? {}) as Record<string, unknown>;

    // Object storage volumes are reported directly on usage items.
    if (item.type.endsWith(":usage")) {
      if (String(meta.kind ?? "") === "storage") {
        const gb = Number(meta.storedGb ?? 0);
        add(
          "Object storage",
          gb,
          true,
          "Stored bytes leaving once. This is the component that makes an exit toll material.",
        );
      }
      continue;
    }

    switch (item.type) {
      case "heroku:addon": {
        const plan = String(meta.plan ?? "").toLowerCase();
        if (plan.includes("postgres")) {
          add(
            `Postgres (${item.name})`,
            herokuPgSize(plan),
            false,
            "Estimated from the add-on plan's storage limit; the real dump is usually smaller.",
          );
        }
        if (plan.includes("redis")) sawRedis = true;
        break;
      }
      case "render:postgres": {
        const plan = String(meta.plan ?? "")
          .toLowerCase()
          .replace(/[\s-]+/g, "_");
        add(
          `Postgres (${item.name})`,
          RENDER_PG_GB[plan] ?? 32,
          false,
          "Estimated from the instance plan's disk size.",
        );
        break;
      }
      case "render:redis":
        sawRedis = true;
        break;
      case "digitalocean:database": {
        const engine = String(meta.engine ?? "").toLowerCase();
        if (engine.includes("redis") || engine.includes("valkey")) {
          sawRedis = true;
          break;
        }
        const diskGb = Number(meta.diskSizeGb ?? 0);
        add(
          `Database (${item.name})`,
          diskGb > 0 ? diskGb : 30,
          diskGb > 0,
          diskGb > 0
            ? "Reported disk size for the cluster."
            : "Estimated; the API did not report a disk size for this cluster.",
        );
        break;
      }
      case "firebase:cloud_sql":
      case "gcp:cloud_sql": {
        const diskGb = Number(meta.dataDiskSizeGb ?? 0);
        add(
          `Cloud SQL (${item.name})`,
          diskGb > 0 ? diskGb : 32,
          diskGb > 0,
          diskGb > 0
            ? "Reported data disk size."
            : "Estimated; the API did not report a disk size.",
        );
        break;
      }
      case "firebase:firestore_database":
      case "gcp:firestore_database": {
        // The Firestore admin API lists databases but reports no size, so this
        // is a placeholder volume until an export is actually run.
        const gb = Number(meta.storedGb ?? 0);
        add(
          `Firestore (${item.name})`,
          gb > 0 ? gb : 10,
          gb > 0,
          "Firestore exports to Cloud Storage first, so the export is billed as egress when it leaves. Size is not exposed by the API.",
        );
        break;
      }
      case "railway:plugin": {
        const kind = `${meta.pluginType ?? ""} ${item.name}`.toLowerCase();
        if (kind.includes("redis")) sawRedis = true;
        else if (kind.includes("postgres")) {
          add(
            `Postgres (${item.name})`,
            32,
            false,
            "Estimated; Railway does not expose volume size through its API.",
          );
        }
        break;
      }
      case "vercel:postgres":
        add(
          `Postgres (${item.name})`,
          32,
          false,
          "Estimated; Vercel Postgres is now Neon-backed and reports no size through the projects API.",
        );
        break;
    }
  }

  const cents = components.reduce((sum, c) => sum + c.cents, 0);
  const totalGb = components.reduce((sum, c) => sum + c.gb, 0);
  const waiverAvailable = rate?.waiver ?? false;

  if (rate) notes.push(rate.note);

  if (sawRedis) {
    notes.push(
      "Redis is not counted. A cache warms on the new side rather than being copied, so it never leaves.",
    );
  }

  if (components.length === 0) {
    notes.push(
      "No stored data was found that has to leave. The migration moves configuration and code, not bytes.",
    );
  } else if (components.every((c) => c.measured)) {
    notes.push("Every volume here was reported by the provider's API.");
  } else {
    notes.push(
      "Volumes marked estimated come from plan limits rather than measured usage, so the real toll is usually lower.",
    );
  }

  return {
    cents,
    centsAfterWaiver: waiverAvailable ? 0 : cents,
    totalGb,
    components,
    waiverAvailable,
    waiverNote: waiverAvailable ? (rate?.note ?? null) : null,
    confidence:
      components.length === 0
        ? "none"
        : components.every((c) => c.measured)
          ? "measured"
          : "estimated",
    notes,
  };
}
