import type { ResourceInventoryItem } from "@infralift/shared";
import {
  collect as collectHeroku,
  type HerokuSnapshot,
} from "@infralift/collectors/heroku";
import type { Connector, ConnectorAssessment } from "./types.js";

const API = "https://api.heroku.com";

// See the note in vercel.ts: collection is the shared, published half; the
// cost model and findings below stay here.

// Rough monthly cost of common dyno sizes, USD cents.
const DYNO_COST_CENTS: Record<string, number> = {
  eco: 500,
  basic: 700,
  "standard-1x": 2500,
  "standard-2x": 5000,
  "performance-m": 25000,
  "performance-l": 50000,
};

/** Pure: snapshot in, assessment out. No I/O. */
export function analyzeHeroku(snapshot: HerokuSnapshot): ConnectorAssessment {
  const inventory: ResourceInventoryItem[] = [];
  const findings: ConnectorAssessment["findings"] = [];
  let totalCostCents = 0;

  for (const app of snapshot.apps) {
    inventory.push({
      provider: "heroku",
      type: "heroku:app",
      externalId: app.id ?? "",
      name: app.name ?? "",
      region: app.region ?? undefined,
      metadata: {
        stack: app.stack,
        maintenance: app.maintenance,
      },
    });

    for (const f of app.formation) {
      if (f.quantity > 0) {
        const size = String(f.size ?? "").toLowerCase();
        const unit = DYNO_COST_CENTS[size] ?? 0;
        const cost = unit * f.quantity;
        totalCostCents += cost;
        inventory.push({
          provider: "heroku",
          type: "heroku:dyno",
          externalId: `${app.id}:${f.type}`,
          name: `${app.name} ${f.type} (${f.size} x${f.quantity})`,
          monthlyCostCents: cost || undefined,
          metadata: { size: f.size, quantity: f.quantity },
        });
      }
    }

    for (const a of app.addons) {
      const cents = a.billedPriceCents;
      if (typeof cents === "number") totalCostCents += cents;
      inventory.push({
        provider: "heroku",
        type: "heroku:addon",
        externalId: a.id ?? "",
        name: `${app.name}: ${a.addonServiceName ?? a.name}`,
        monthlyCostCents: typeof cents === "number" ? cents : undefined,
        // appName is what codegen uses to reference the owning heroku_app.
        // Without it, it has to parse the display name above, where the
        // app name carries a trailing colon.
        metadata: { plan: a.planName, appName: app.name },
      });
      if ((a.addonServiceName ?? "").includes("postgresql")) {
        findings.push({
          category: "recommendation",
          severity: "info",
          title: `${app.name}: Heroku Postgres`,
          detail:
            "Heroku Postgres migrates cleanly via pg_dump/pg_restore to Neon, a VPS Postgres, or RDS. Connection strings move to env vars managed in Terraform.",
          resourceRef: a.id ?? undefined,
        });
      }
    }
  }

  if (totalCostCents > 0) {
    const vpsEstimate = 2000; // $20/mo VPS baseline
    const savings = Math.max(0, totalCostCents - vpsEstimate);
    findings.push({
      category: "cost",
      severity: totalCostCents > 10000 ? "high" : "medium",
      title: `~$${(totalCostCents / 100).toFixed(0)}/mo on Heroku dynos + add-ons`,
      detail: `Inventoried dynos and add-ons total roughly $${(totalCostCents / 100).toFixed(2)}/mo. Equivalent workloads on a VPS (Docker Compose or systemd behind Caddy) typically run $10–$40/mo total.`,
      monthlySavingsCents: savings,
    });
    return {
      inventory,
      findings,
      estimatedMonthlyCostCents: totalCostCents,
      estimatedMonthlySavingsCents: savings,
    };
  }

  return {
    inventory,
    findings,
    estimatedMonthlyCostCents: totalCostCents || null,
    estimatedMonthlySavingsCents: null,
  };
}

export const herokuConnector: Connector = {
  provider: "heroku",

  async verify(token) {
    const res = await fetch(`${API}/account`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.heroku+json; version=3",
      },
    });
    return res.ok;
  },

  async assess(token): Promise<ConnectorAssessment> {
    return analyzeHeroku(await collectHeroku({ token }));
  },
};
