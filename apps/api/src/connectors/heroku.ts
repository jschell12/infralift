import type { ResourceInventoryItem } from "@infralift/shared";
import type { Connector, ConnectorAssessment } from "./types.js";

const API = "https://api.heroku.com";

async function hFetch(token: string, path: string): Promise<any> {
  const res = await fetch(`${API}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.heroku+json; version=3",
    },
  });
  if (!res.ok) {
    throw new Error(`Heroku API ${path} -> ${res.status}`);
  }
  return res.json();
}

// Rough monthly cost of common dyno sizes, USD cents.
const DYNO_COST_CENTS: Record<string, number> = {
  eco: 500,
  basic: 700,
  "standard-1x": 2500,
  "standard-2x": 5000,
  "performance-m": 25000,
  "performance-l": 50000,
};

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
    const inventory: ResourceInventoryItem[] = [];
    const findings: ConnectorAssessment["findings"] = [];
    let totalCostCents = 0;

    const apps: any[] = await hFetch(token, "/apps");

    for (const app of apps) {
      inventory.push({
        provider: "heroku",
        type: "heroku:app",
        externalId: app.id,
        name: app.name,
        region: app.region?.name,
        metadata: {
          stack: app.stack?.name ?? null,
          maintenance: app.maintenance ?? false,
        },
      });

      // Dyno formation
      try {
        const formation: any[] = await hFetch(
          token,
          `/apps/${app.id}/formation`
        );
        for (const f of formation) {
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
      } catch {
        // formation may 403 on collaborator-scoped keys
      }

      // Add-ons
      try {
        const addons: any[] = await hFetch(token, `/apps/${app.id}/addons`);
        for (const a of addons) {
          const cents = a.billed_price?.cents ?? null;
          if (typeof cents === "number") totalCostCents += cents;
          inventory.push({
            provider: "heroku",
            type: "heroku:addon",
            externalId: a.id,
            name: `${app.name}: ${a.addon_service?.name ?? a.name}`,
            monthlyCostCents: typeof cents === "number" ? cents : undefined,
            // appName is what codegen uses to reference the owning heroku_app.
            // Without it, it has to parse the display name above, where the
            // app name carries a trailing colon.
            metadata: { plan: a.plan?.name ?? null, appName: app.name },
          });
          if ((a.addon_service?.name ?? "").includes("postgresql")) {
            findings.push({
              category: "recommendation",
              severity: "info",
              title: `${app.name}: Heroku Postgres`,
              detail:
                "Heroku Postgres migrates cleanly via pg_dump/pg_restore to Neon, a VPS Postgres, or RDS. Connection strings move to env vars managed in Terraform.",
              resourceRef: a.id,
            });
          }
        }
      } catch {
        // ignore addon read failures per-app
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
  },
};
