import type { NotInventoried, ResourceInventoryItem } from "@infralift/shared";
import { ProviderHttpError, type Connector, type ConnectorAssessment } from "./types.js";
import { httpFetch } from "../lib/http.js";
import { DEFAULT_ENDPOINTS, type Endpoints } from "../lib/endpoints.js";

/** `api` is the base URL, DEFAULT_ENDPOINTS.digitaloceanApi unless overridden
 *  (lib/endpoints.ts). */
async function doFetch(api: string, token: string, path: string): Promise<any> {
  const res = await httpFetch(`${api}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) {
    throw new ProviderHttpError(`DigitalOcean API ${path} -> ${res.status}`, res.status);
  }
  return res.json();
}

/** Spaces are not in the DigitalOcean API this connection's token reads.
 *  They are listed over the S3 API (ListBuckets at
 *  <region>.digitaloceanspaces.com), signed with a Spaces access key and
 *  secret, which a DigitalOcean connection does not hold. The connector used
 *  to call GET /v2/spaces, which does not exist (#153 finding 2), and left
 *  Spaces out without saying so. */
export const DO_SPACES_NOT_INVENTORIED: NotInventoried = {
  type: "digitalocean:space",
  label: "Spaces buckets",
  reason:
    "Spaces were not inventoried. DigitalOcean lists them only through its S3-compatible API with a Spaces access key, and a DigitalOcean connection holds an API token, not Spaces keys. Count your Spaces in the control panel if you plan to move them.",
};

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

/** The DigitalOcean connector, calling endpoints.digitaloceanApi (lib/endpoints.ts). */
export function createDigitaloceanConnector(endpoints: Pick<Endpoints, "digitaloceanApi"> = DEFAULT_ENDPOINTS): Connector {
  const api = endpoints.digitaloceanApi;
  const connector: Connector = {
    provider: "digitalocean",

    async verify(token) {
      const res = await httpFetch(`${api}/account`, {
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
        const body = await doFetch(api, token, "/droplets?per_page=200");
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
        const body = await doFetch(api, token, "/apps?per_page=200");
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
        const body = await doFetch(api, token, "/databases?per_page=200");
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

      // Domains
      try {
        const body = await doFetch(api, token, "/domains?per_page=200");
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
          api,
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

      findings.push({
        category: "inventory",
        severity: "low",
        title: "Spaces not inventoried",
        detail: DO_SPACES_NOT_INVENTORIED.reason,
      });
      const notInventoried = [DO_SPACES_NOT_INVENTORIED];

      if (totalCostCents > 0) {
        findings.push({
          category: "cost",
          severity: totalCostCents > 10000 ? "high" : "medium",
          title: `~$${(totalCostCents / 100).toFixed(0)}/mo on DigitalOcean`,
          detail: `Inventoried resources total roughly $${(totalCostCents / 100).toFixed(2)}/mo. Consolidating onto a Hetzner VPS ($5-$40/mo) or Cloudflare Workers reduces cost and complexity.`,
        });
        return {
          inventory,
          findings,
          estimatedMonthlyCostCents: totalCostCents,
          notInventoried,
        };
      }

      return {
        inventory,
        findings,
        estimatedMonthlyCostCents: totalCostCents || null,
        notInventoried,
      };
    },
  };
  return connector;
}

export const digitaloceanConnector: Connector = createDigitaloceanConnector();
