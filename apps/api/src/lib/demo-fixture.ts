// Demo fixture: a synthetic large-tier customer ("Northwind") whose numbers
// mirror the infralift-testenv large tier, without paying for it.
//
// Everything here emits EXACTLY what the real connectors would — same item
// types, same externalId shapes, same metadata keys, same finding text —
// because downstream code depends on those details:
//   - heroku:dyno externalId must be "<appUuid>:<processType>";
//     options.ts inferProfile reads the process type from it
//   - heroku:addon metadata.appName is what codegen uses to reference the
//     owning heroku_app resource
//   - dyno sizes must exist in the connector's DYNO_COST_CENTS table so the
//     fixture's costs reproduce through the same pricing the connector uses
//
// Seeded by scripts/seed-demo.ts; safe to regenerate (UUIDs are hardcoded).

import type {
  AssessmentFinding,
  ResourceInventoryItem,
} from "@infralift/shared";

export interface DemoAssessment {
  inventory: ResourceInventoryItem[];
  findings: Omit<AssessmentFinding, "id">[];
  estimatedMonthlyCostCents: number | null;
  estimatedMonthlySavingsCents: number | null;
}

// ---------------------------------------------------------------------------
// Heroku: 4 apps, 9 always-on dynos, 5 add-ons — ~$3,229/mo
// Mirrors infralift-testenv heroku/{core,data,workers} at tier=large.
// ---------------------------------------------------------------------------

const HK_APP = {
  web: "6b1f6f2e-4c1a-4c1e-9d2a-000000000001",
  staging: "6b1f6f2e-4c1a-4c1e-9d2a-000000000002",
  data: "6b1f6f2e-4c1a-4c1e-9d2a-000000000003",
  worker: "6b1f6f2e-4c1a-4c1e-9d2a-000000000004",
} as const;

const HK_ADDON = {
  postgres: "7c2a7a3f-5d2b-4d2f-8e3b-000000000001",
  redis: "7c2a7a3f-5d2b-4d2f-8e3b-000000000002",
  papertrail: "7c2a7a3f-5d2b-4d2f-8e3b-000000000003",
  scheduler: "7c2a7a3f-5d2b-4d2f-8e3b-000000000004",
  cloudamqp: "7c2a7a3f-5d2b-4d2f-8e3b-000000000005",
} as const;

export function buildDemoHerokuAssessment(): DemoAssessment {
  const inventory: ResourceInventoryItem[] = [];
  const findings: Omit<AssessmentFinding, "id">[] = [];

  const app = (id: string, name: string) => {
    inventory.push({
      provider: "heroku",
      type: "heroku:app",
      externalId: id,
      name,
      region: "us",
      metadata: { stack: "heroku-24", maintenance: false },
    });
  };
  app(HK_APP.web, "northwind-web");
  app(HK_APP.staging, "northwind-staging");
  app(HK_APP.data, "northwind-data");
  app(HK_APP.worker, "northwind-worker");

  // Dynos: connector prices size × quantity from DYNO_COST_CENTS.
  const dyno = (
    appId: string,
    appName: string,
    type: string,
    size: string,
    quantity: number,
    unitCents: number
  ) => {
    inventory.push({
      provider: "heroku",
      type: "heroku:dyno",
      externalId: `${appId}:${type}`,
      name: `${appName} ${type} (${size} x${quantity})`,
      monthlyCostCents: unitCents * quantity,
      metadata: { size, quantity },
    });
  };
  dyno(HK_APP.web, "northwind-web", "web", "Performance-L", 4, 50000); // $2,000
  dyno(HK_APP.staging, "northwind-staging", "web", "Standard-1X", 1, 2500); // $25
  dyno(HK_APP.worker, "northwind-worker", "worker", "Standard-2X", 4, 5000); // $200

  const addon = (
    id: string,
    appName: string,
    service: string,
    plan: string,
    cents: number
  ) => {
    inventory.push({
      provider: "heroku",
      type: "heroku:addon",
      externalId: id,
      name: `${appName}: ${service}`,
      monthlyCostCents: cents,
      metadata: { plan, appName },
    });
  };
  addon(HK_ADDON.postgres, "northwind-data", "heroku-postgresql", "heroku-postgresql:premium-0", 75000);
  addon(HK_ADDON.redis, "northwind-data", "heroku-redis", "heroku-redis:premium-3", 20000);
  addon(HK_ADDON.papertrail, "northwind-web", "papertrail", "papertrail:firehose", 3500);
  addon(HK_ADDON.scheduler, "northwind-worker", "scheduler", "scheduler:standard", 0);
  addon(HK_ADDON.cloudamqp, "northwind-worker", "cloudamqp", "cloudamqp:tiger", 1900);

  const totalCostCents = inventory.reduce(
    (sum, i) => sum + (i.monthlyCostCents ?? 0),
    0
  ); // 322,900

  // Findings match the connector's text verbatim.
  findings.push({
    category: "recommendation",
    severity: "info",
    title: "northwind-data: Heroku Postgres",
    detail:
      "Heroku Postgres migrates cleanly via pg_dump/pg_restore to Neon, a VPS Postgres, or RDS. Connection strings move to env vars managed in Terraform.",
    resourceRef: HK_ADDON.postgres,
  });

  const vpsEstimate = 2000;
  const savings = Math.max(0, totalCostCents - vpsEstimate);
  findings.push({
    category: "cost",
    severity: "high",
    title: `~$${(totalCostCents / 100).toFixed(0)}/mo on Heroku dynos + add-ons`,
    detail: `Inventoried dynos and add-ons total roughly $${(totalCostCents / 100).toFixed(2)}/mo. Equivalent workloads on a VPS (Docker Compose or systemd behind Caddy) typically run $10–$40/mo total.`,
    monthlySavingsCents: savings,
  });

  return {
    inventory,
    findings,
    estimatedMonthlyCostCents: totalCostCents,
    estimatedMonthlySavingsCents: savings,
  };
}

// ---------------------------------------------------------------------------
// Vercel: 11 Next.js projects + 4 domains — modeled ~$2,760/mo
// Mirrors infralift-testenv vercel/{core,data,workers} at tier=large.
//
// The real connector returns null for cost (Vercel has no billing read API on
// standard tokens), so the demo sets the assessment-level estimate directly
// and explains the model in a finding. When the connector learns to estimate
// from seats + usage, this fixture is the target it should reproduce.
// ---------------------------------------------------------------------------

const VC_PROJECTS: { key: string; envVarCount: number }[] = [
  { key: "web", envVarCount: 3 },
  { key: "api", envVarCount: 2 },
  { key: "admin", envVarCount: 2 },
  { key: "docs", envVarCount: 2 },
  { key: "marketing", envVarCount: 2 },
  { key: "blog", envVarCount: 2 },
  { key: "staging", envVarCount: 2 },
  { key: "preview", envVarCount: 2 },
  { key: "worker-cron", envVarCount: 3 },
  { key: "worker-queue-processor", envVarCount: 3 },
  { key: "worker-webhooks", envVarCount: 2 },
];

const VC_DOMAINS = [
  "app.northwind.dev",
  "api.northwind.dev",
  "admin.northwind.dev",
  "northwind.dev",
];

// 20 Pro seats ($400) + ~10TB bandwidth overage (~$1,350) + worker/cron
// invocations, edge config, blob storage (~$1,010).
const VC_MODELED_MONTHLY_CENTS = 276000;

export function buildDemoVercelAssessment(): DemoAssessment {
  const inventory: ResourceInventoryItem[] = [];
  const findings: Omit<AssessmentFinding, "id">[] = [];

  for (const [i, p] of VC_PROJECTS.entries()) {
    const id = `prj_demo_northwind_${String(i + 1).padStart(2, "0")}`;
    const name = `northwind-${p.key}`;
    inventory.push({
      provider: "vercel",
      type: "vercel:project",
      externalId: id,
      name,
      metadata: {
        framework: "nextjs",
        nodeVersion: "22.x",
        serverlessFunctionRegion: "iad1",
        envVarCount: p.envVarCount,
      },
    });
    findings.push({
      category: "inventory",
      severity: "info",
      title: `${name}: ${p.envVarCount} environment variables`,
      detail: `Project "${name}" has ${p.envVarCount} env vars to migrate (names inventoried; values are never read).`,
      resourceRef: id,
    });
    findings.push({
      category: "recommendation",
      severity: "info",
      title: `${name}: Next.js — Cloudflare or VPS candidate`,
      detail:
        "Next.js apps port to Cloudflare Workers (OpenNext) or a VPS (standalone output behind a reverse proxy). Both remove per-seat and usage-based pricing.",
      resourceRef: id,
    });
  }

  for (const domain of VC_DOMAINS) {
    inventory.push({
      provider: "vercel",
      type: "vercel:domain",
      externalId: domain,
      name: domain,
      metadata: { serviceType: "external" },
    });
  }

  findings.push({
    category: "cost",
    severity: "medium",
    title: "Vercel Pro seats and usage-based billing",
    detail: `Found ${VC_PROJECTS.length} project(s). Vercel Pro is $20/seat/mo plus usage (bandwidth, function invocations, image optimization). A typical small team ($40–$400/mo) lands at $5–$25/mo on Cloudflare or a fixed-price VPS.`,
  });

  // Demo-only: the estimate the connector cannot make yet.
  const savings = VC_MODELED_MONTHLY_CENTS - 20000; // vs ~$200/mo modern stack
  findings.push({
    category: "cost",
    severity: "high",
    title: `Modeled ~$${(VC_MODELED_MONTHLY_CENTS / 100).toFixed(0)}/mo Vercel run-rate`,
    detail:
      "Estimated from account shape, not billing (Vercel exposes no billing read API): 20 Pro seats at $20 ($400), ~10TB/mo bandwidth beyond the included 1TB at $0.15/GB (~$1,350), plus worker/cron invocations, edge config reads, and blob storage (~$1,010). Actual invoices vary with usage.",
    monthlySavingsCents: savings,
  });

  return {
    inventory,
    findings,
    estimatedMonthlyCostCents: VC_MODELED_MONTHLY_CENTS,
    estimatedMonthlySavingsCents: savings,
  };
}
