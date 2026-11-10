import type { ResourceInventoryItem } from "@infralift/shared";
import type { Connector, ConnectorAssessment } from "./types.js";

// Fly.io Machines API (REST). The legacy platform API at api.fly.io has been
// superseded by the Machines API at api.machines.dev for app/machine management.

const MACHINES_API = "https://api.machines.dev/v1";
const FLAPS_API = "https://api.fly.io";

async function flyFetch(token: string, url: string): Promise<any> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`Fly.io API ${new URL(url).pathname} -> ${res.status}`);
  }
  return res.json();
}

// Rough monthly cost for common Fly VM presets, USD cents.
const VM_COST_CENTS: Record<string, number> = {
  shared: 200,
  "shared-cpu-1x": 200,
  "shared-cpu-2x": 600,
  "shared-cpu-4x": 1200,
  "shared-cpu-8x": 2400,
  performance: 3100,
  "performance-1x": 3100,
  "performance-2x": 6200,
  "performance-4x": 12400,
  "performance-8x": 24800,
};

export const flyioConnector: Connector = {
  provider: "flyio",

  async verify(token) {
    // Use the GraphQL API for auth verification (lightweight)
    const res = await fetch("https://api.fly.io/graphql", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: "{ viewer { id } }" }),
    });
    if (!res.ok) return false;
    const body: any = await res.json();
    return !!body?.data?.viewer?.id;
  },

  async assess(token): Promise<ConnectorAssessment> {
    const inventory: ResourceInventoryItem[] = [];
    const findings: ConnectorAssessment["findings"] = [];
    let totalCostCents = 0;

    // List apps via the platform GraphQL API (Machines API has no list-all-apps)
    let apps: any[] = [];
    try {
      const res = await fetch("https://api.fly.io/graphql", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query: `{
            apps {
              nodes {
                id
                name
                status
                organization { slug }
                regions { code name }
              }
            }
          }`,
        }),
      });
      if (res.ok) {
        const body: any = await res.json();
        apps = body?.data?.apps?.nodes ?? [];
      }
    } catch {
      // GraphQL may fail; will have empty app list.
    }

    for (const app of apps) {
      inventory.push({
        provider: "flyio",
        type: "flyio:app",
        externalId: app.id ?? app.name,
        name: app.name,
        region: app.regions?.[0]?.code ?? null,
        metadata: {
          status: app.status ?? null,
          org: app.organization?.slug ?? null,
          regionCount: app.regions?.length ?? null,
        },
      });

      // Machines for this app
      try {
        const machines: any[] = await flyFetch(
          token,
          `${MACHINES_API}/apps/${app.name}/machines`
        );
        for (const m of machines) {
          const size = String(
            m.config?.guest?.cpu_kind ??
              m.config?.size ??
              ""
          ).toLowerCase();
          const cpus = m.config?.guest?.cpus ?? 1;
          const cost = (VM_COST_CENTS[size] ?? 200) * cpus;
          totalCostCents += cost;

          inventory.push({
            provider: "flyio",
            type: "flyio:machine",
            externalId: m.id,
            name: `${app.name}/${m.id}`,
            region: m.region ?? null,
            monthlyCostCents: cost,
            metadata: {
              state: m.state ?? null,
              image: m.config?.image ?? null,
              cpuKind: m.config?.guest?.cpu_kind ?? null,
              cpus: m.config?.guest?.cpus ?? null,
              memoryMb: m.config?.guest?.memory_mb ?? null,
            },
          });
        }
      } catch {
        // Machine listing may fail per-app; skip.
      }

      // Volumes
      try {
        const volumes: any[] = await flyFetch(
          token,
          `${MACHINES_API}/apps/${app.name}/volumes`
        );
        for (const v of volumes) {
          const gbCents = (v.size_gb ?? 0) * 15; // ~$0.15/GB/mo
          totalCostCents += gbCents;
          inventory.push({
            provider: "flyio",
            type: "flyio:volume",
            externalId: v.id,
            name: `${app.name}/${v.name ?? v.id}`,
            region: v.region ?? null,
            monthlyCostCents: gbCents || undefined,
            metadata: {
              sizeGb: v.size_gb ?? null,
              state: v.state ?? null,
              encrypted: v.encrypted ?? null,
            },
          });
        }
      } catch {
        // Volume listing may fail; skip.
      }
    }

    if (apps.length > 0) {
      findings.push({
        category: "recommendation",
        severity: "info",
        title: "Fly.io apps run as Firecracker VMs",
        detail:
          "Fly.io Machines are micro-VMs from Docker images. The same images run unchanged on a VPS (Docker Compose + systemd) or port to Cloudflare Workers if the workload fits the edge runtime. Multi-region deployments simplify to a single VPS or Cloudflare's built-in edge.",
      });
    }

    // Postgres detection (Fly Postgres is user-managed, not SaaS)
    const pgApps = apps.filter(
      (a: any) =>
        String(a.name ?? "").includes("postgres") ||
        String(a.name ?? "").includes("-db")
    );
    if (pgApps.length > 0) {
      findings.push({
        category: "risk",
        severity: "medium",
        title: `${pgApps.length} likely Postgres app(s) on Fly`,
        detail:
          "Fly Postgres is 'unmanaged managed' — you own backups, failover, and upgrades. Migration to Neon, a VPS Postgres, or RDS gains true managed backups and point-in-time recovery.",
      });
    }

    if (totalCostCents > 0) {
      findings.push({
        category: "cost",
        severity: totalCostCents > 10000 ? "high" : "medium",
        title: `~$${(totalCostCents / 100).toFixed(0)}/mo on Fly.io VMs + volumes`,
        detail: `Estimated compute and storage total ~$${(totalCostCents / 100).toFixed(2)}/mo. Equivalent workloads on a Hetzner VPS typically cost $10-$40/mo with 20TB egress included.`,
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
