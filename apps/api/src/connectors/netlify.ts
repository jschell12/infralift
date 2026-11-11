import type { ResourceInventoryItem } from "@infralift/shared";
import { ProviderHttpError, type Connector, type ConnectorAssessment } from "./types.js";
import { httpFetch } from "../lib/http.js";

const API = "https://api.netlify.com/api/v1";

async function nfFetch(token: string, path: string): Promise<any> {
  const res = await httpFetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new ProviderHttpError(`Netlify API ${path} -> ${res.status}`, res.status);
  }
  return res.json();
}

export const netlifyConnector: Connector = {
  provider: "netlify",

  async verify(token) {
    const res = await httpFetch(`${API}/user`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return res.ok;
  },

  async assess(token): Promise<ConnectorAssessment> {
    const inventory: ResourceInventoryItem[] = [];
    const findings: ConnectorAssessment["findings"] = [];

    const sites: any[] = await nfFetch(token, "/sites?per_page=100");

    for (const s of sites) {
      inventory.push({
        provider: "netlify",
        type: "netlify:site",
        externalId: s.id,
        name: s.name ?? s.subdomain,
        metadata: {
          customDomain: s.custom_domain ?? null,
          framework: s.build_settings?.cmd ? "custom" : null,
          repo: s.build_settings?.repo_url ?? null,
          publishDir: s.build_settings?.dir ?? null,
        },
      });

      if (s.build_settings?.functions_dir) {
        findings.push({
          category: "inventory",
          severity: "info",
          title: `${s.name}: serverless functions directory`,
          detail: `Site "${s.name}" has a functions directory at "${s.build_settings.functions_dir}". These Netlify Functions port to Cloudflare Workers or a VPS Express/Fastify server.`,
          resourceRef: s.id,
        });
      }
    }

    // DNS zones
    try {
      const zones: any[] = await nfFetch(token, "/dns_zones");
      for (const z of zones) {
        inventory.push({
          provider: "netlify",
          type: "netlify:dns_zone",
          externalId: z.id,
          name: z.name,
          metadata: { recordCount: z.records?.length ?? null },
        });
      }
    } catch {
      // DNS scope may not be available; skip.
    }

    // Forms
    try {
      const forms: any[] = await nfFetch(token, "/forms?per_page=100");
      if (forms.length > 0) {
        findings.push({
          category: "risk",
          severity: "low",
          title: `${forms.length} Netlify Form(s) — platform-specific feature`,
          detail:
            "Netlify Forms is a platform lock-in point. Migration replaces them with a serverless form handler (Workers or a simple POST endpoint on VPS) backed by a database or email service.",
        });
        for (const f of forms) {
          inventory.push({
            provider: "netlify",
            type: "netlify:form",
            externalId: f.id,
            name: f.name ?? f.id,
            metadata: { submissionCount: f.submission_count ?? 0 },
          });
        }
      }
    } catch {
      // Forms API may 404 if none exist; skip.
    }

    // Build hooks (indicates CI/CD integration)
    try {
      for (const s of sites.slice(0, 10)) {
        const hooks: any[] = await nfFetch(
          token,
          `/sites/${s.id}/build_hooks`
        );
        if (hooks.length > 0) {
          inventory.push({
            provider: "netlify",
            type: "netlify:build_hook",
            externalId: `${s.id}:hooks`,
            name: `${s.name}: ${hooks.length} build hook(s)`,
            metadata: { count: hooks.length },
          });
        }
      }
    } catch {
      // Build hooks may not be accessible; skip.
    }

    if (sites.length > 0) {
      findings.push({
        category: "cost",
        severity: "medium",
        title: "Netlify Pro seats and usage-based billing",
        detail: `Found ${sites.length} site(s). Netlify Pro is $19/seat/mo plus usage (bandwidth, build minutes, function invocations). Cloudflare Workers or a VPS eliminates per-seat and usage pricing.`,
      });

      findings.push({
        category: "recommendation",
        severity: "info",
        title: "Netlify sites port to Cloudflare or VPS",
        detail:
          "Static sites move directly to Cloudflare Workers (static assets) or a VPS behind Caddy/nginx. SSR frameworks (Next.js, Remix, Astro) use OpenNext or standalone builds. Netlify redirects/_redirects translate to Worker routing rules or server config.",
      });
    }

    return {
      inventory,
      findings,
      estimatedMonthlyCostCents: null, // Netlify has no billing read API on standard tokens
    };
  },
};
