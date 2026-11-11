import type { ResourceInventoryItem } from "@infralift/shared";
import { ProviderHttpError, type Connector, type ConnectorAssessment } from "./types.js";
import { httpFetch } from "../lib/http.js";

const API = "https://api.cloudflare.com/client/v4";

async function cfFetch(token: string, path: string): Promise<any> {
  const res = await httpFetch(`${API}${path}`, {
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

/** Pages read from a paged list before it is cut off, and DNS records kept
 *  across all zones. Both are bounded so one huge account cannot stall an
 *  assessment; when either bound is hit, a finding says so. */
export const MAX_PAGES = 20;
export const DNS_RECORD_CAP = 2000;

/** Every page of a paged list, following result_info.total_pages. A response
 *  without result_info is one page, and an empty page ends the walk. */
async function cfPaged(token: string, path: string, perPage: number, maxPages = MAX_PAGES): Promise<{ items: any[]; capped: boolean }> {
  const items: any[] = [];
  const sep = path.includes("?") ? "&" : "?";
  for (let page = 1; page <= maxPages; page++) {
    const body = await cfFetch(token, `${path}${sep}per_page=${perPage}&page=${page}`);
    const result: any[] = Array.isArray(body.result) ? body.result : [];
    items.push(...result);
    const total = Number(body.result_info?.total_pages ?? 1);
    if (!result.length || page >= total) return { items, capped: false };
  }
  return { items, capped: true };
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
    const res = await httpFetch(`${API}/user/tokens/verify`, {
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

    const capped: string[] = [];

    // Accounts. Account-scoped resources import as "<account_id>/<name>", so
    // each item records its account.
    const { items: accounts, capped: accountsCapped } = await cfPaged(token, "/accounts", 50);
    if (accountsCapped) capped.push(`accounts (first ${accounts.length})`);

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
            metadata: { accountId: account.id, modifiedOn: s.modified_on ?? null },
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
              accountId: account.id,
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
            metadata: { accountId: account.id, jurisdiction: b.jurisdiction ?? "default", creationDate: b.creation_date ?? null },
          });
        }
      } catch {
        // R2 scope missing; skip.
      }
    }

    // DNS zones, then the records in each.
    let zones: any[] = [];
    try {
      const listed = await cfPaged(token, "/zones", 50);
      zones = listed.items;
      if (listed.capped) capped.push(`zones (first ${zones.length})`);
      for (const z of zones) {
        inventory.push({
          provider: "cloudflare",
          type: "cloudflare:zone",
          externalId: z.id,
          name: z.name,
          metadata: { accountId: z.account?.id ?? null, status: z.status, plan: z.plan?.name ?? null },
        });
      }
    } catch {
      // Zone scope missing; skip.
    }

    let records = 0;
    for (const [n, z] of zones.entries()) {
      if (records >= DNS_RECORD_CAP) {
        capped.push(`DNS records (first ${DNS_RECORD_CAP}, from ${n} of ${zones.length} zones)`);
        break;
      }
      try {
        const listed = await cfPaged(token, `/zones/${z.id}/dns_records`, 100);
        const kept = listed.items.slice(0, DNS_RECORD_CAP - records);
        if (listed.capped || kept.length < listed.items.length) capped.push(`DNS records in ${z.name} (first ${kept.length})`);
        for (const r of kept) {
          inventory.push({
            provider: "cloudflare",
            type: "cloudflare:dns_record",
            externalId: r.id,
            name: r.name,
            metadata: { zoneId: z.id, recordType: r.type ?? null, proxied: r.proxied ?? null },
          });
        }
        records += kept.length;
      } catch {
        // DNS read scope missing for this zone; skip.
      }
    }

    if (capped.length) {
      findings.push({
        category: "inventory",
        severity: "info",
        title: "Cloudflare inventory was cut off",
        detail: `infralift stopped listing at its bound for: ${capped.join("; ")}. Resources past it were not assessed.`,
      });
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
