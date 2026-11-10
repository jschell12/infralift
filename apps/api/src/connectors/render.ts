import type { ResourceInventoryItem } from "@infralift/shared";
import type { Connector, ConnectorAssessment } from "./types.js";

const API = "https://api.render.com/v1";

async function rFetch(token: string, path: string): Promise<any> {
  const res = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`Render API ${path} -> ${res.status}`);
  }
  return res.json();
}

// Rough monthly cost for Render service plans, USD cents.
const PLAN_COST_CENTS: Record<string, number> = {
  free: 0,
  starter: 700,
  "starter plus": 1500,
  standard: 2500,
  pro: 8500,
  "pro plus": 17500,
  "pro max": 35000,
  "pro ultra": 70000,
};

export const renderConnector: Connector = {
  provider: "render",

  async verify(token) {
    const res = await fetch(`${API}/owners?limit=1`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return res.ok;
  },

  async assess(token): Promise<ConnectorAssessment> {
    const inventory: ResourceInventoryItem[] = [];
    const findings: ConnectorAssessment["findings"] = [];
    let totalCostCents = 0;

    // Services (web services, private services, background workers, cron jobs, static sites)
    const servicesRes: any[] = await rFetch(token, "/services?limit=100");

    for (const entry of servicesRes) {
      const s = entry.service ?? entry;
      const plan = String(s.servicePlan?.name ?? s.plan ?? "").toLowerCase();
      const cost = PLAN_COST_CENTS[plan] ?? 0;
      totalCostCents += cost;

      inventory.push({
        provider: "render",
        type: `render:${s.type ?? "service"}`,
        externalId: s.id,
        name: s.name,
        region: s.region ?? null,
        monthlyCostCents: cost || undefined,
        metadata: {
          type: s.type ?? null,
          plan: s.plan ?? s.servicePlan?.name ?? null,
          runtime: s.env ?? s.runtime ?? null,
          repo: s.repo ?? null,
          autoDeploy: s.autoDeploy ?? null,
        },
      });
    }

    // Postgres databases
    try {
      const dbsRes: any[] = await rFetch(token, "/postgres?limit=100");
      for (const entry of dbsRes) {
        const db = entry.postgres ?? entry;
        inventory.push({
          provider: "render",
          type: "render:postgres",
          externalId: db.id,
          name: db.name ?? db.databaseName,
          region: db.region ?? null,
          metadata: {
            plan: db.plan ?? null,
            version: db.version ?? null,
            status: db.status ?? null,
          },
        });
        findings.push({
          category: "recommendation",
          severity: "info",
          title: `${db.name ?? db.databaseName}: Render Postgres`,
          detail:
            "Render managed Postgres migrates via pg_dump/pg_restore to Neon, a VPS Postgres, or any managed provider. Connection strings move to Terraform-managed env vars.",
          resourceRef: db.id,
        });
      }
    } catch {
      // Postgres API may not be accessible; skip.
    }

    // Redis instances
    try {
      const redisRes: any[] = await rFetch(token, "/redis?limit=100");
      for (const entry of redisRes) {
        const r = entry.redis ?? entry;
        inventory.push({
          provider: "render",
          type: "render:redis",
          externalId: r.id,
          name: r.name,
          region: r.region ?? null,
          metadata: { plan: r.plan ?? null, status: r.status ?? null },
        });
      }
    } catch {
      // Redis API may not be accessible; skip.
    }

    // Env groups (shared environment variables)
    try {
      const envGroups: any[] = await rFetch(
        token,
        "/env-groups?limit=100"
      );
      for (const entry of envGroups) {
        const g = entry.envGroup ?? entry;
        inventory.push({
          provider: "render",
          type: "render:env_group",
          externalId: g.id,
          name: g.name,
          metadata: {
            envVarCount: Array.isArray(g.envVars) ? g.envVars.length : null,
          },
        });
      }
    } catch {
      // Env groups may not be accessible; skip.
    }

    if (totalCostCents > 0) {
      findings.push({
        category: "cost",
        severity: totalCostCents > 10000 ? "high" : "medium",
        title: `~$${(totalCostCents / 100).toFixed(0)}/mo on Render services`,
        detail: `Inventoried services total roughly $${(totalCostCents / 100).toFixed(2)}/mo. Equivalent workloads on a VPS (Docker Compose behind Caddy) or Cloudflare Workers typically run $10-$40/mo.`,
      });
      return {
        inventory,
        findings,
        estimatedMonthlyCostCents: totalCostCents,
      };
    }

    return {
      inventory,
      findings,
      estimatedMonthlyCostCents: totalCostCents || null,
    };
  },
};
