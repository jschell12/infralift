import type { ResourceInventoryItem } from "@infralift/shared";
import type { Connector, ConnectorAssessment } from "./types.js";

const API = "https://api.digitalocean.com/v2";

async function doFetch(token: string, path: string): Promise<any> {
  const res = await fetch(`${API}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) {
    throw new Error(`DigitalOcean API ${path} -> ${res.status}`);
  }
  return res.json();
}

// Rough monthly cost for common Droplet slugs, USD cents.
const DROPLET_COST_CENTS: Record<string, number> = {
  "s-1vcpu-512mb-10gb": 400,
  "s-1vcpu-1gb": 600,
  "s-1vcpu-2gb": 1200,
  "s-2vcpu-2gb": 1800,
  "s-2vcpu-4gb": 2400,
  "s-4vcpu-8gb": 4800,
  "s-8vcpu-16gb": 9600,
  "g-2vcpu-8gb": 6300,
  "g-4vcpu-16gb": 12600,
  "gd-2vcpu-8gb": 7200,
};

export const digitaloceanConnector: Connector = {
  provider: "digitalocean",

  async verify(token) {
    const res = await fetch(`${API}/account`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return res.ok;
  },

  async assess(token): Promise<ConnectorAssessment> {
    const inventory: ResourceInventoryItem[] = [];
    const findings: ConnectorAssessment["findings"] = [];
    let totalCostCents = 0;

    // Droplets
    try {
      const body = await doFetch(token, "/droplets?per_page=200");
      const droplets: any[] = body.droplets ?? [];
      for (const d of droplets) {
        const slug = String(d.size_slug ?? "").toLowerCase();
        const cost =
          DROPLET_COST_CENTS[slug] ??
          (d.size?.price_monthly ? Math.round(d.size.price_monthly * 100) : 0);
        totalCostCents += cost;

        inventory.push({
          provider: "digitalocean",
          type: "digitalocean:droplet",
          externalId: String(d.id),
          name: d.name,
          region: d.region?.slug ?? null,
          monthlyCostCents: cost || undefined,
          metadata: {
            sizeSlug: d.size_slug ?? null,
            image: d.image?.slug ?? d.image?.name ?? null,
            vcpus: d.vcpus ?? null,
            memoryMb: d.memory ?? null,
            diskGb: d.disk ?? null,
            status: d.status ?? null,
          },
        });
      }
    } catch {
      // Droplets scope may not be available; skip.
    }

    // App Platform apps
    try {
      const body = await doFetch(token, "/apps?per_page=200");
      const apps: any[] = body.apps ?? [];
      for (const a of apps) {
        inventory.push({
          provider: "digitalocean",
          type: "digitalocean:app",
          externalId: a.id,
          name: a.spec?.name ?? a.id,
          region: a.region?.slug ?? null,
          metadata: {
            tier: a.tier_slug ?? null,
            liveUrl: a.live_url ?? null,
            serviceCount: a.spec?.services?.length ?? 0,
            staticSiteCount: a.spec?.static_sites?.length ?? 0,
            workerCount: a.spec?.workers?.length ?? 0,
          },
        });

        if (a.tier_slug === "basic") totalCostCents += 500;
        else if (a.tier_slug === "professional") totalCostCents += 1200;
      }
    } catch {
      // App Platform may not be accessible; skip.
    }

    // Managed databases
    try {
      const body = await doFetch(token, "/databases?per_page=200");
      const dbs: any[] = body.databases ?? [];
      for (const db of dbs) {
        const cost = db.size
          ? Math.round((db.monthly_cost ?? 0) * 100)
          : 0;
        totalCostCents += cost;

        inventory.push({
          provider: "digitalocean",
          type: "digitalocean:database",
          externalId: db.id,
          name: db.name,
          region: db.region ?? null,
          monthlyCostCents: cost || undefined,
          metadata: {
            engine: db.engine ?? null,
            version: db.version ?? null,
            size: db.size ?? null,
            numNodes: db.num_nodes ?? null,
            status: db.status ?? null,
          },
        });

        if (db.engine === "pg") {
          findings.push({
            category: "recommendation",
            severity: "info",
            title: `${db.name}: DO Managed Postgres`,
            detail:
              "DigitalOcean managed Postgres migrates via pg_dump/pg_restore to Neon, a VPS Postgres, or any provider. Connection strings move to Terraform-managed env vars.",
            resourceRef: db.id,
          });
        }
      }
    } catch {
      // Databases may not be accessible; skip.
    }

    // Spaces (S3-compatible object storage)
    try {
      const body = await doFetch(token, "/spaces?per_page=200");
      // Spaces API may return under different keys
      const spaces: any[] = body.spaces ?? [];
      for (const s of spaces) {
        totalCostCents += 500; // $5/mo per Space
        inventory.push({
          provider: "digitalocean",
          type: "digitalocean:space",
          externalId: s.name,
          name: s.name,
          region: s.region?.slug ?? null,
          monthlyCostCents: 500,
          metadata: {},
        });
      }
    } catch {
      // Spaces API may not be accessible or may 404; skip.
    }

    // Domains
    try {
      const body = await doFetch(token, "/domains?per_page=200");
      const domains: any[] = body.domains ?? [];
      for (const d of domains) {
        inventory.push({
          provider: "digitalocean",
          type: "digitalocean:domain",
          externalId: d.name,
          name: d.name,
          metadata: { ttl: d.ttl ?? null },
        });
      }
    } catch {
      // Domains may not be accessible; skip.
    }

    // Kubernetes clusters
    try {
      const body = await doFetch(
        token,
        "/kubernetes/clusters?per_page=200"
      );
      const clusters: any[] = body.kubernetes_clusters ?? [];
      for (const c of clusters) {
        inventory.push({
          provider: "digitalocean",
          type: "digitalocean:kubernetes",
          externalId: c.id,
          name: c.name,
          region: c.region ?? null,
          metadata: {
            version: c.version ?? null,
            nodePoolCount: c.node_pools?.length ?? null,
            status: c.status?.state ?? null,
          },
        });
        findings.push({
          category: "risk",
          severity: "medium",
          title: `${c.name}: DOKS Kubernetes cluster`,
          detail:
            "Kubernetes clusters require workload-by-workload migration planning. Simple apps move to Docker Compose on a VPS or Cloudflare Workers; stateful workloads need careful data migration.",
          resourceRef: c.id,
        });
      }
    } catch {
      // K8s may not be accessible; skip.
    }

    if (totalCostCents > 0) {
      const vpsEstimate = 2000;
      const savings = Math.max(0, totalCostCents - vpsEstimate);
      findings.push({
        category: "cost",
        severity: totalCostCents > 10000 ? "high" : "medium",
        title: `~$${(totalCostCents / 100).toFixed(0)}/mo on DigitalOcean`,
        detail: `Inventoried resources total roughly $${(totalCostCents / 100).toFixed(2)}/mo. Consolidating onto a Hetzner VPS ($5-$40/mo) or Cloudflare Workers reduces cost and complexity.`,
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
