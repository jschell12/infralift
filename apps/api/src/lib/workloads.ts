// Per-workload costs: the assessment's inventory split into the apps and
// services the connectors already model, each priced today and sized on the
// two executable targets on its own.
//
// The comparison table answers "what does the whole account cost there". The
// question after it is "which app is the expensive one", and the inventory
// already knows: a Heroku dyno names its app, a Fly machine is <app>/<id>, a
// Render service is its own row. Anything no single workload owns (a Render
// Postgres, a Railway plugin, a DigitalOcean database, billed usage, platform
// fees) goes in a shared row instead of being split by a guess.
//
// Current costs here are always the connector's list prices. A bill the
// customer reported is one number for the whole account, and dividing it by
// list-price proportions would invent a per-app figure nobody read anywhere.

import type {
  ResourceInventoryItem,
  WorkloadCost,
  WorkloadShared,
  WorkloadTargetCost,
} from "@infralift/shared";
import { computeFootprint, planTarget, sizeTarget } from "./sizing.js";

const SIZED_TARGETS = ["hetzner", "cloudflare"] as const;

// Render rows that carry a plan but are not services.
const RENDER_NON_SERVICE = new Set([
  "render:postgres",
  "render:redis",
  "render:env_group",
  "render:usage",
]);

interface Owner {
  key: string;
  name: string;
  kind: string;
}

/** Which workload an item belongs to, or null when no single one owns it. */
function ownerOf(
  item: ResourceInventoryItem,
  herokuAppName: Map<string, string>
): Owner | null {
  const meta = (item.metadata ?? {}) as Record<string, unknown>;
  switch (item.type) {
    case "heroku:dyno": {
      const appId = item.externalId.split(":")[0] ?? "";
      const name = herokuAppName.get(appId) ?? item.name.split(" ")[0];
      return { key: `heroku:${name}`, name, kind: "Heroku app" };
    }
    case "heroku:addon": {
      // The connector records the owning app; an add-on attached to several
      // apps is still billed to that one.
      const name = typeof meta.appName === "string" ? meta.appName : null;
      return name ? { key: `heroku:${name}`, name, kind: "Heroku app" } : null;
    }
    case "flyio:machine":
    case "flyio:volume": {
      const name = item.name.split("/")[0];
      return { key: `flyio:${name}`, name, kind: "Fly app" };
    }
    case "railway:service":
      return { key: `railway:${item.externalId}`, name: item.name, kind: "Railway service" };
    case "digitalocean:droplet":
      return { key: `do:${item.externalId}`, name: item.name, kind: "DigitalOcean droplet" };
    case "digitalocean:app":
      return { key: `do:${item.externalId}`, name: item.name, kind: "DigitalOcean app" };
    default:
      // Same test computeFootprint uses for a Render service.
      if (
        item.type.startsWith("render:") &&
        !RENDER_NON_SERVICE.has(item.type) &&
        meta.plan !== undefined
      ) {
        return { key: `render:${item.externalId}`, name: item.name, kind: "Render service" };
      }
      return null;
  }
}

function sizedTargets(items: ResourceInventoryItem[]): WorkloadTargetCost[] {
  const footprint = computeFootprint(items);
  return SIZED_TARGETS.map((slug) => ({
    slug,
    monthlyCents: sizeTarget(slug, footprint)?.monthlyCents ?? 0,
  }));
}

const usd = (cents: number) => `$${Math.round(cents / 100).toLocaleString("en-US")}`;

export interface WorkloadBreakdown {
  workloads: WorkloadCost[];
  workloadsShared: WorkloadShared | null;
  workloadsNote: string | null;
}

export function buildWorkloadBreakdown(
  inventory: ResourceInventoryItem[],
  totals: {
    estimatedMonthlyCostCents: number | null;
    reportedMonthlySpendCents: number | null;
  }
): WorkloadBreakdown {
  const herokuAppName = new Map<string, string>();
  for (const i of inventory) {
    if (i.type === "heroku:app") herokuAppName.set(i.externalId, i.name);
  }

  const groups = new Map<string, Owner & { items: ResourceInventoryItem[] }>();
  const rest: ResourceInventoryItem[] = [];
  for (const item of inventory) {
    const owner = ownerOf(item, herokuAppName);
    if (!owner) {
      rest.push(item);
      continue;
    }
    const g = groups.get(owner.key) ?? { ...owner, items: [] };
    g.items.push(item);
    groups.set(owner.key, g);
  }

  if (groups.size === 0) {
    return { workloads: [], workloadsShared: null, workloadsNote: null };
  }

  const workloads: WorkloadCost[] = [...groups.values()].map((g) => {
    const priced = g.items.filter((i) => i.monthlyCostCents !== undefined);
    return {
      name: g.name,
      kind: g.kind,
      currentMonthlyCents: priced.length
        ? priced.reduce((s, i) => s + (i.monthlyCostCents ?? 0), 0)
        : null,
      targets: sizedTargets(g.items),
    };
  });
  workloads.sort(
    (a, b) => (b.currentMonthlyCents ?? -1) - (a.currentMonthlyCents ?? -1)
  );

  // Shared: what is left of the list-price total, and the data services the
  // unowned items size to. Compute is never in here, so sizing the leftovers
  // whole would add a server nobody runs; only the Postgres and Redis lines
  // are taken from the plan.
  const allocated = workloads.reduce((s, w) => s + (w.currentMonthlyCents ?? 0), 0);
  const restPriced = rest.filter((i) => (i.monthlyCostCents ?? 0) > 0);
  const sharedCurrent =
    totals.estimatedMonthlyCostCents !== null
      ? Math.max(0, totals.estimatedMonthlyCostCents - allocated)
      : restPriced.length
        ? restPriced.reduce((s, i) => s + (i.monthlyCostCents ?? 0), 0)
        : null;
  const restFootprint = computeFootprint(rest);
  const sharedTargets = SIZED_TARGETS.map((slug) => {
    const plan = planTarget(slug, restFootprint);
    return {
      slug,
      monthlyCents:
        (plan?.postgres?.monthlyCents ?? 0) + (plan?.redis?.monthlyCents ?? 0),
    };
  });
  const sharedItems = rest
    .filter(
      (i) =>
        (i.monthlyCostCents ?? 0) > 0 ||
        /postgres|redis|database|plugin/.test(i.type)
    )
    .map((i) => i.name);
  const hasShared =
    sharedItems.length > 0 ||
    (sharedCurrent ?? 0) > 0 ||
    sharedTargets.some((t) => t.monthlyCents > 0);
  const workloadsShared: WorkloadShared | null = hasShared
    ? { items: sharedItems, currentMonthlyCents: sharedCurrent, targets: sharedTargets }
    : null;

  const notes: string[] = [];
  if (workloadsShared) {
    notes.push(
      "Shared databases, add-ons and platform fees belong to no single workload, so they are a row of their own rather than split by a guess."
    );
  }
  const whole = sizedTargets(inventory);
  const apart = whole
    .map((t) => {
      const sum =
        workloads.reduce(
          (s, w) => s + (w.targets.find((x) => x.slug === t.slug)?.monthlyCents ?? 0),
          0
        ) +
        (workloadsShared?.targets.find((x) => x.slug === t.slug)?.monthlyCents ?? 0);
      return { slug: t.slug, sum, whole: t.monthlyCents };
    })
    .filter((t) => t.sum !== t.whole);
  if (apart.length) {
    notes.push(
      `Each workload is sized on its own, with its own server and base fees, so the rows add up to ${apart
        .map((t) => `${usd(t.sum)} on ${t.slug === "hetzner" ? "Hetzner" : "Cloudflare"} against ${usd(t.whole)} sized together`)
        .join(" and ")}; the comparison above is the sized-together figure.`
    );
  }
  if (totals.reportedMonthlySpendCents !== null) {
    notes.push(
      "Current costs per workload are the connector's list prices. The bill you reported is for the whole account and is not split by workload."
    );
  }

  return {
    workloads,
    workloadsShared,
    workloadsNote: notes.length ? notes.join(" ") : null,
  };
}
