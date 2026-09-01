import type { ResourceInventoryItem } from "@infralift/shared";
import {
  collect as collectVercel,
  type VercelSnapshot,
} from "@infralift/collectors/vercel";
import type { Connector, ConnectorAssessment } from "./types.js";

const API = "https://api.vercel.com";

// Collection lives in @infralift/collectors — the same dependency-free file a
// customer runs themselves when they would rather not hand over a token (see
// packages/collectors/README.md). Importing it rather than reimplementing the
// API calls here is what keeps the two intake paths honest: there is one
// collector, so a token-based assessment and an uploaded snapshot cannot
// describe the same account differently.
//
// Everything below the collect() call is analysis: findings, cost model,
// recommendations. That half is deliberately NOT in the published collector.

/**
 * Turn a snapshot into an assessment. Pure — no I/O, no clock, no token — so
 * it runs identically over a live collection and over a snapshot a customer
 * uploaded weeks ago.
 */
export function analyzeVercel(snapshot: VercelSnapshot): ConnectorAssessment {
  const inventory: ResourceInventoryItem[] = [];
  const findings: ConnectorAssessment["findings"] = [];

  for (const p of snapshot.projects) {
    inventory.push({
      provider: "vercel",
      type: "vercel:project",
      externalId: p.id ?? "",
      name: p.name ?? "",
      metadata: {
        framework: p.framework,
        nodeVersion: p.nodeVersion,
        serverlessFunctionRegion: p.serverlessFunctionRegion,
        // undefined rather than null when the account exposed no env array,
        // matching what this connector has always written.
        envVarCount: p.envVarCount ?? undefined,
        // Build settings. Without these, generated HCL carries only name and
        // framework, so importing a real project plans "to change" and wipes
        // whatever the project actually had configured.
        buildCommand: p.buildCommand,
        outputDirectory: p.outputDirectory,
        rootDirectory: p.rootDirectory,
        installCommand: p.installCommand,
        devCommand: p.devCommand,
        gitRepoType: p.link?.type ?? null,
        gitRepo:
          p.link?.org && p.link?.repo
            ? `${p.link.org}/${p.link.repo}`
            : (p.link?.repo ?? null),
        productionBranch: p.link?.productionBranch ?? null,
      },
    });

    // Env vars: count only — the collector never reads names or values.
    if ((p.envVarCount ?? 0) > 0) {
      findings.push({
        category: "inventory",
        severity: "info",
        title: `${p.name}: ${p.envVarCount} environment variables`,
        detail: `Project "${p.name}" has ${p.envVarCount} env vars to migrate (names inventoried; values are never read).`,
        resourceRef: p.id ?? undefined,
      });
    }

    if (p.framework === "nextjs") {
      findings.push({
        category: "recommendation",
        severity: "info",
        title: `${p.name}: Next.js — Cloudflare or VPS candidate`,
        detail:
          "Next.js apps port to Cloudflare Workers (OpenNext) or a VPS (standalone output behind a reverse proxy). Both remove per-seat and usage-based pricing.",
        resourceRef: p.id ?? undefined,
      });
    }
  }

  for (const d of snapshot.domains) {
    inventory.push({
      provider: "vercel",
      type: "vercel:domain",
      externalId: d.id ?? "",
      name: d.name ?? "",
      metadata: { serviceType: d.serviceType },
    });
  }

  if (snapshot.projects.length > 0) {
    findings.push({
      category: "cost",
      severity: "medium",
      title: "Vercel Pro seats and usage-based billing",
      detail: `Found ${snapshot.projects.length} project(s). Vercel Pro is $20/seat/mo plus usage (bandwidth, function invocations, image optimization). A typical small team ($40–$400/mo) lands at $5–$25/mo on Cloudflare or a fixed-price VPS.`,
    });
  }

  return {
    inventory,
    findings,
    estimatedMonthlyCostCents: null, // Vercel has no billing read API on standard tokens
    estimatedMonthlySavingsCents: null,
  };
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
    return analyzeVercel(await collectVercel({ token }));
  },
};
