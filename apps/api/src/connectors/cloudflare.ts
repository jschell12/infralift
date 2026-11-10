import type { ResourceInventoryItem } from "@infralift/shared";
import { ProviderHttpError, type Connector, type ConnectorAssessment } from "./types.js";

const API = "https://api.cloudflare.com/client/v4";

async function cfFetch(token: string, path: string): Promise<any> {
  const res = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new ProviderHttpError(`Cloudflare API ${path} -> ${res.status}`, res.status);
  }
  const body: any = await res.json();
  if (body.success === false) {
    throw new Error(
      `Cloudflare API ${path} -> ${JSON.stringify(body.errors ?? [])}`
    );
  }
  return body;
}

export const cloudflareConnector: Connector = {
  provider: "cloudflare",

  async verify(token) {
    return (await cloudflareConnector.check!(token)).valid;
  },

  // /user/tokens/verify answers {result: {id, status, expires_on?}}, status
  // one of active | disabled | expired; expires_on is absent for a token
  // without an expiry. A refused token is a 401 whose errors[] says why.
  async check(token) {
    const res = await fetch(`${API}/user/tokens/verify`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body: any = await res.json().catch(() => null);
    if (!res.ok) {
      const why = typeof body?.errors?.[0]?.message === "string" ? `: ${body.errors[0].message.slice(0, 120)}` : "";
      return { valid: false, reason: `Cloudflare answered ${res.status}${why}`, expiresAt: null };
    }
    const status = body?.result?.status;
    const expires = typeof body?.result?.expires_on === "string" ? new Date(body.result.expires_on) : null;
    const expiresAt = expires && !Number.isNaN(expires.getTime()) ? expires : null;
    if (status !== "active") {
      return { valid: false, reason: `Cloudflare reports this token as ${String(status ?? "unknown")}`, expiresAt };
    }
    return { valid: true, reason: null, expiresAt };
  },

  async assess(token): Promise<ConnectorAssessment> {
    const inventory: ResourceInventoryItem[] = [];
    const findings: ConnectorAssessment["findings"] = [];

    // Accounts
    const accountsBody = await cfFetch(token, "/accounts?per_page=50");
    const accounts: any[] = accountsBody.result ?? [];

    for (const account of accounts) {
      // Workers scripts
      try {
        const scriptsBody = await cfFetch(
          token,
          `/accounts/${account.id}/workers/scripts`
        );
        for (const s of scriptsBody.result ?? []) {
          inventory.push({
            provider: "cloudflare",
            type: "cloudflare:worker",
            externalId: s.id,
            name: s.id,
            metadata: { modifiedOn: s.modified_on ?? null },
          });
        }
      } catch {
        // Token may not include Workers scope.
      }

      // Pages projects
      try {
        const pagesBody = await cfFetch(
          token,
          `/accounts/${account.id}/pages/projects`
        );
        for (const p of pagesBody.result ?? []) {
          inventory.push({
            provider: "cloudflare",
            type: "cloudflare:pages_project",
            externalId: p.name,
            name: p.name,
            metadata: {
              productionBranch: p.production_branch ?? null,
              framework: p.build_config?.framework ?? null,
            },
          });
          findings.push({
            category: "recommendation",
            severity: "low",
            title: `${p.name}: Pages project — consider Workers`,
            detail:
              "Cloudflare is converging Pages onto Workers (static assets on Workers). New investment should target Workers; existing Pages projects keep working.",
            resourceRef: p.name,
          });
        }
      } catch {
        // Pages scope missing; skip.
      }

      // R2 buckets
      try {
        const r2Body = await cfFetch(
          token,
          `/accounts/${account.id}/r2/buckets`
        );
        for (const b of r2Body.result?.buckets ?? []) {
          inventory.push({
            provider: "cloudflare",
            type: "cloudflare:r2_bucket",
            externalId: b.name,
            name: b.name,
            metadata: { creationDate: b.creation_date ?? null },
          });
        }
      } catch {
        // R2 scope missing; skip.
      }
    }

    // DNS zones
    try {
      const zonesBody = await cfFetch(token, "/zones?per_page=50");
      for (const z of zonesBody.result ?? []) {
        inventory.push({
          provider: "cloudflare",
          type: "cloudflare:zone",
          externalId: z.id,
          name: z.name,
          metadata: { status: z.status, plan: z.plan?.name ?? null },
        });
      }
    } catch {
      // Zone scope missing; skip.
    }

    const unmanagedCount = inventory.length;
    if (unmanagedCount > 0) {
      findings.push({
        category: "iac_standard",
        severity: "medium",
        title: `${unmanagedCount} Cloudflare resources to bring under Terraform`,
        detail:
          "Resources found via API are candidates for `terraform import` into a Cloudflare provider workspace so drift is visible and changes go through code review.",
      });
    }

    return {
      inventory,
      findings,
      estimatedMonthlyCostCents: null,
    };
  },
};
