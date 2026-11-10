import type { ResourceInventoryItem } from "@infralift/shared";
import { ProviderHttpError, type Connector, type ConnectorAssessment } from "./types.js";

// Azure assessment via a service principal (client credentials flow). The
// connection "token" is a JSON object: { tenantId, clientId, clientSecret,
// subscriptionId }. The principal needs Reader role on the subscription.

const LOGIN_URL = "https://login.microsoftonline.com";
const MGMT_API = "https://management.azure.com";
const API_VERSION_COMPUTE = "2024-07-01";
const API_VERSION_WEB = "2024-04-01";
const API_VERSION_SQL = "2023-08-01-preview";
const API_VERSION_STORAGE = "2023-05-01";

interface AzureCredentials {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  subscriptionId: string;
}

function parseCredentials(token: string): AzureCredentials | null {
  try {
    const creds = JSON.parse(token);
    if (
      typeof creds?.tenantId === "string" &&
      typeof creds?.clientId === "string" &&
      typeof creds?.clientSecret === "string" &&
      typeof creds?.subscriptionId === "string"
    ) {
      return creds;
    }
    return null;
  } catch {
    return null;
  }
}

async function mintAccessToken(creds: AzureCredentials): Promise<string> {
  const res = await fetch(
    `${LOGIN_URL}/${creds.tenantId}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
        scope: "https://management.azure.com/.default",
      }),
    }
  );
  if (!res.ok) {
    throw new ProviderHttpError(`Azure token exchange failed: ${res.status}`, res.status);
  }
  const body: any = await res.json();
  return body.access_token as string;
}

async function azFetch(accessToken: string, url: string): Promise<any> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new ProviderHttpError(`Azure API ${new URL(url).pathname} -> ${res.status}`, res.status);
  }
  return res.json();
}

export const azureConnector: Connector = {
  provider: "azure",

  async verify(token) {
    const creds = parseCredentials(token);
    if (!creds) return false;
    try {
      await mintAccessToken(creds);
      return true;
    } catch {
      return false;
    }
  },

  async assess(token): Promise<ConnectorAssessment> {
    const creds = parseCredentials(token);
    if (!creds) {
      throw new Error(
        "Azure connection must be JSON: { tenantId, clientId, clientSecret, subscriptionId }"
      );
    }
    const accessToken = await mintAccessToken(creds);
    const sub = creds.subscriptionId;
    const base = `${MGMT_API}/subscriptions/${sub}`;

    const inventory: ResourceInventoryItem[] = [];
    const findings: ConnectorAssessment["findings"] = [];

    inventory.push({
      provider: "azure",
      type: "azure:subscription",
      externalId: sub,
      name: `Azure subscription ${sub}`,
    });

    // App Services (Web Apps + Function Apps)
    try {
      const sites = await azFetch(
        accessToken,
        `${base}/providers/Microsoft.Web/sites?api-version=${API_VERSION_WEB}`
      );
      for (const s of sites.value ?? []) {
        const kind = String(s.kind ?? "").toLowerCase();
        const isFunctionApp = kind.includes("functionapp");
        inventory.push({
          provider: "azure",
          type: isFunctionApp ? "azure:function_app" : "azure:app_service",
          externalId: s.id,
          name: s.name,
          region: s.location ?? null,
          metadata: {
            kind: s.kind ?? null,
            state: s.properties?.state ?? null,
            defaultHostName: s.properties?.defaultHostName ?? null,
            httpsOnly: s.properties?.httpsOnly ?? null,
            linuxFxVersion:
              s.properties?.siteConfig?.linuxFxVersion ?? null,
          },
        });

        if (isFunctionApp) {
          findings.push({
            category: "recommendation",
            severity: "info",
            title: `${s.name}: Azure Function App`,
            detail:
              "HTTP-triggered Azure Functions port to Cloudflare Workers. Timer/queue-triggered functions map to Workers Cron Triggers or Queues. Event Grid triggers need re-architecture.",
            resourceRef: s.id,
          });
        }
      }

      const appCount = (sites.value ?? []).filter(
        (s: any) => !String(s.kind ?? "").toLowerCase().includes("functionapp")
      ).length;
      if (appCount > 0) {
        findings.push({
          category: "recommendation",
          severity: "info",
          title: `${appCount} App Service(s) — VPS or Workers candidates`,
          detail:
            "App Services run containerized or code-based web apps. Docker-based apps run unchanged on a VPS. Code-based .NET/Node/Python apps port to Cloudflare Workers or a VPS behind Caddy.",
        });
      }
    } catch {
      // Web provider may not be registered; skip.
    }

    // App Service Plans (compute backing App Services)
    try {
      const plans = await azFetch(
        accessToken,
        `${base}/providers/Microsoft.Web/serverfarms?api-version=${API_VERSION_WEB}`
      );
      for (const p of plans.value ?? []) {
        inventory.push({
          provider: "azure",
          type: "azure:app_service_plan",
          externalId: p.id,
          name: p.name,
          region: p.location ?? null,
          metadata: {
            sku: p.sku?.name ?? null,
            tier: p.sku?.tier ?? null,
            capacity: p.sku?.capacity ?? null,
            kind: p.kind ?? null,
          },
        });
      }
    } catch {
      // App Service Plans may not be accessible; skip.
    }

    // Virtual Machines
    try {
      const vms = await azFetch(
        accessToken,
        `${base}/providers/Microsoft.Compute/virtualMachines?api-version=${API_VERSION_COMPUTE}`
      );
      for (const vm of vms.value ?? []) {
        inventory.push({
          provider: "azure",
          type: "azure:virtual_machine",
          externalId: vm.id,
          name: vm.name,
          region: vm.location ?? null,
          metadata: {
            vmSize: vm.properties?.hardwareProfile?.vmSize ?? null,
            osType:
              vm.properties?.storageProfile?.osDisk?.osType ?? null,
            provisioningState:
              vm.properties?.provisioningState ?? null,
          },
        });
      }
      if ((vms.value ?? []).length > 0) {
        findings.push({
          category: "recommendation",
          severity: "info",
          title: `${(vms.value ?? []).length} VM(s) — VPS migration candidates`,
          detail:
            "Azure VMs move to Hetzner or DigitalOcean VPS instances at a fraction of the cost. Workloads containerized with Docker port directly; bare-metal installs need image conversion or re-provisioning.",
        });
      }
    } catch {
      // Compute provider may not be registered; skip.
    }

    // Azure SQL databases
    try {
      const servers = await azFetch(
        accessToken,
        `${base}/providers/Microsoft.Sql/servers?api-version=${API_VERSION_SQL}`
      );
      for (const srv of servers.value ?? []) {
        inventory.push({
          provider: "azure",
          type: "azure:sql_server",
          externalId: srv.id,
          name: srv.name,
          region: srv.location ?? null,
          metadata: {
            state: srv.properties?.state ?? null,
            version: srv.properties?.version ?? null,
          },
        });

        // Databases on this server
        try {
          const dbs = await azFetch(
            accessToken,
            `${MGMT_API}${srv.id}/databases?api-version=${API_VERSION_SQL}`
          );
          for (const db of dbs.value ?? []) {
            if (db.name === "master") continue;
            inventory.push({
              provider: "azure",
              type: "azure:sql_database",
              externalId: db.id,
              name: `${srv.name}/${db.name}`,
              region: db.location ?? null,
              metadata: {
                sku: db.sku?.name ?? null,
                tier: db.sku?.tier ?? null,
                maxSizeBytes:
                  db.properties?.maxSizeBytes ?? null,
                status: db.properties?.status ?? null,
              },
            });
          }
        } catch {
          // Per-server DB listing may fail; skip.
        }

        findings.push({
          category: "recommendation",
          severity: "info",
          title: `${srv.name}: Azure SQL Server`,
          detail:
            "Azure SQL databases (if using Postgres-compatible features) migrate via standard dump/restore. SQL Server databases need schema compatibility assessment before moving to Postgres.",
          resourceRef: srv.id,
        });
      }
    } catch {
      // SQL provider may not be registered; skip.
    }

    // Storage accounts
    try {
      const accounts = await azFetch(
        accessToken,
        `${base}/providers/Microsoft.Storage/storageAccounts?api-version=${API_VERSION_STORAGE}`
      );
      for (const a of accounts.value ?? []) {
        inventory.push({
          provider: "azure",
          type: "azure:storage_account",
          externalId: a.id,
          name: a.name,
          region: a.location ?? null,
          metadata: {
            kind: a.kind ?? null,
            sku: a.sku?.name ?? null,
            tier: a.sku?.tier ?? null,
            accessTier:
              a.properties?.accessTier ?? null,
          },
        });
      }
      const storageCount = (accounts.value ?? []).length;
      if (storageCount > 0) {
        findings.push({
          category: "recommendation",
          severity: "info",
          title: `${storageCount} Storage Account(s) — R2 or VPS candidates`,
          detail:
            "Azure Blob Storage migrates to Cloudflare R2 (zero egress, S3-compatible API) using azcopy/rclone. R2 is preferred for public assets; VPS local storage works for private data.",
        });
      }
    } catch {
      // Storage provider may not be registered; skip.
    }

    findings.push({
      category: "cost",
      severity: "medium",
      title: "Azure usage-based billing",
      detail:
        "Azure charges per-service with metered compute, storage, egress, and license fees. Full cost analysis requires Cost Management API access, which is confirmed during the assessment engagement. Typical small Azure accounts ($200-$500/mo) consolidate onto a VPS at $10-$40/mo.",
    });

    return {
      inventory,
      findings,
      estimatedMonthlyCostCents: null, // Cost Management API requires billing scope
    };
  },
};
