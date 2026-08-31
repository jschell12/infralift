import type { ResourceInventoryItem } from "@infralift/shared";
import type { Connector, ConnectorAssessment } from "./types.js";

const API = "https://api.vercel.com";

async function vfetch(token: string, path: string): Promise<any> {
  const res = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`Vercel API ${path} -> ${res.status}`);
  }
  return res.json();
}

export const vercelConnector: Connector = {
  provider: "vercel",

  async verify(token) {
    const res = await fetch(`${API}/v2/user`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return res.ok;
  },

  async assess(token): Promise<ConnectorAssessment> {
    const inventory: ResourceInventoryItem[] = [];
    const findings: ConnectorAssessment["findings"] = [];

    const projectsRes = await vfetch(token, "/v9/projects?limit=100");
    const projects: any[] = projectsRes.projects ?? [];

    for (const p of projects) {
      inventory.push({
        provider: "vercel",
        type: "vercel:project",
        externalId: p.id,
        name: p.name,
        metadata: {
          framework: p.framework ?? null,
          nodeVersion: p.nodeVersion ?? null,
          serverlessFunctionRegion: p.serverlessFunctionRegion ?? null,
          envVarCount: Array.isArray(p.env) ? p.env.length : undefined,
          // Build settings. Without these, generated HCL carries only name and
          // framework, so importing a real project plans "to change" and wipes
          // whatever the project actually had configured.
          buildCommand: p.buildCommand ?? null,
          outputDirectory: p.outputDirectory ?? null,
          rootDirectory: p.rootDirectory ?? null,
          installCommand: p.installCommand ?? null,
          devCommand: p.devCommand ?? null,
          gitRepoType: p.link?.type ?? null,
          gitRepo:
            p.link?.org && p.link?.repo
              ? `${p.link.org}/${p.link.repo}`
              : (p.link?.repo ?? null),
          productionBranch: p.link?.productionBranch ?? null,
        },
      });

      // Env vars: names only — never values.
      if (Array.isArray(p.env) && p.env.length > 0) {
        findings.push({
          category: "inventory",
          severity: "info",
          title: `${p.name}: ${p.env.length} environment variables`,
          detail: `Project "${p.name}" has ${p.env.length} env vars to migrate (names inventoried; values are never read).`,
          resourceRef: p.id,
        });
      }

      if (p.framework === "nextjs") {
        findings.push({
          category: "recommendation",
          severity: "info",
          title: `${p.name}: Next.js — Cloudflare or VPS candidate`,
          detail:
            "Next.js apps port to Cloudflare Workers (OpenNext) or a VPS (standalone output behind a reverse proxy). Both remove per-seat and usage-based pricing.",
          resourceRef: p.id,
        });
      }
    }

    let domains: any[] = [];
    try {
      const domainsRes = await vfetch(token, "/v5/domains?limit=100");
      domains = domainsRes.domains ?? [];
    } catch {
      // Domains scope may be excluded from a minimal token; skip.
    }
    for (const d of domains) {
      inventory.push({
        provider: "vercel",
        type: "vercel:domain",
        externalId: d.id ?? d.name,
        name: d.name,
        metadata: { serviceType: d.serviceType ?? null },
      });
    }

    if (projects.length > 0) {
      findings.push({
        category: "cost",
        severity: "medium",
        title: "Vercel Pro seats and usage-based billing",
        detail: `Found ${projects.length} project(s). Vercel Pro is $20/seat/mo plus usage (bandwidth, function invocations, image optimization). A typical small team ($40–$400/mo) lands at $5–$25/mo on Cloudflare or a fixed-price VPS.`,
      });
    }

    return {
      inventory,
      findings,
      estimatedMonthlyCostCents: null, // Vercel has no billing read API on standard tokens
      estimatedMonthlySavingsCents: null,
    };
  },
};
