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

// Cost drivers, itemized the way the bill bleeds. `vercel:usage` items are
// not migratable resources — codegen skips them — but they make the report's
// inventory table read like the invoice, which is the demo.
const VC_USAGE: {
  id: string;
  name: string;
  cents: number;
  metadata: Record<string, unknown>;
}[] = [
  {
    id: "usage_demo_seats",
    name: "Pro seats ×20",
    cents: 40000,
    metadata: { kind: "seats", quantity: 20 },
  },
  {
    id: "usage_demo_bandwidth",
    name: "Bandwidth overage (9TB beyond the included 1TB @ $0.15/GB)",
    cents: 135000,
    metadata: { kind: "bandwidth", gbMonth: 10000 },
  },
  // Split because a single "invocations" line at $300 did not reconcile: at
  // Vercel's published $0.60 per million, 50M invocations is $30, not $300.
  // The $300 was right for the workload and wrong for the label — function
  // cost at this volume is dominated by execution time, not by the count of
  // invocations. Two items, each checkable against a published rate, summing
  // to what the single item claimed.
  {
    id: "usage_demo_invocations",
    name: "Function invocations (~50M/mo at $0.60/M)",
    cents: 3000,
    metadata: { kind: "invocations", millions: 50, ratePerMillionCents: 60 },
  },
  {
    id: "usage_demo_function_duration",
    name: "Function duration (~1,500 GB-Hrs at $0.18/GB-Hr)",
    cents: 27000,
    metadata: {
      kind: "function_duration",
      gbHours: 1500,
      ratePerGbHourCents: 18,
    },
  },
  {
    id: "usage_demo_images",
    name: "Image optimization",
    cents: 25000,
    metadata: { kind: "image_optimization" },
  },
  {
    id: "usage_demo_storage",
    name: "Edge config reads + blob storage (~500GB)",
    cents: 46000,
    metadata: { kind: "storage", storedGb: 500 },
  },
];

const VC_MODELED_MONTHLY_CENTS = VC_USAGE.reduce((s, u) => s + u.cents, 0); // 276,000

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
        // Build settings the connector reads off /v9/projects. Generated HCL
        // that omits these imports cleanly and then plans "to change",
        // wiping them on the first apply.
        buildCommand: "pnpm turbo build",
        outputDirectory: ".next",
        rootDirectory: `apps/${p.key}`,
        installCommand: "pnpm install --frozen-lockfile",
        gitRepoType: "github",
        gitRepo: "northwind/platform",
        productionBranch: "main",
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

  // The bill, itemized.
  for (const u of VC_USAGE) {
    inventory.push({
      provider: "vercel",
      type: "vercel:usage",
      externalId: u.id,
      name: u.name,
      monthlyCostCents: u.cents,
      metadata: u.metadata,
    });
  }
  findings.push({
    category: "cost",
    severity: "high",
    title: "Bandwidth overage is half the bill",
    detail:
      "~10TB/mo beyond the included 1TB, billed at $0.15/GB, is roughly $1,350 of the $2,760 monthly run-rate. Cloudflare and most VPS providers do not bill egress at all — this line item disappears on migration.",
    resourceRef: "usage_demo_bandwidth",
  });
  findings.push({
    category: "cost",
    severity: "medium",
    title: "20 Pro seats bill $400/mo before any traffic",
    detail:
      "Vercel charges $20/seat/mo for every team member who deploys. Targets without per-seat pricing (Cloudflare Workers, any VPS) zero this out.",
    resourceRef: "usage_demo_seats",
  });

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
      "Estimated from account shape, not billing (Vercel exposes no billing read API): 20 Pro seats at $20 ($400), 10TB/mo bandwidth of which 9TB bills beyond the included 1TB at $0.15/GB (~$1,350), plus function invocations and duration, edge config reads, and blob storage (~$1,010). Actual invoices vary with usage.",
    monthlySavingsCents: savings,
  });

  return {
    inventory,
    findings,
    estimatedMonthlyCostCents: VC_MODELED_MONTHLY_CENTS,
    estimatedMonthlySavingsCents: savings,
  };
}

// ---------------------------------------------------------------------------
// Render: 5 services, managed Postgres + Redis — ~$1,189/mo
// Service plans are priced by the connector's PLAN_COST_CENTS; databases,
// seats, and bandwidth arrive as render:usage items because the connector
// cannot price them from the API.
// ---------------------------------------------------------------------------

export function buildDemoRenderAssessment(): DemoAssessment {
  const inventory: ResourceInventoryItem[] = [];
  const findings: Omit<AssessmentFinding, "id">[] = [];

  const service = (
    n: number,
    name: string,
    type: string,
    plan: string,
    cents: number
  ) => {
    inventory.push({
      provider: "render",
      type: `render:${type}`,
      externalId: `srv-demo-northwind-${n}`,
      name,
      region: "oregon",
      monthlyCostCents: cents,
      metadata: {
        type,
        plan,
        runtime: "node",
        repo: "https://github.com/northwind/platform",
        autoDeploy: "yes",
      },
    });
  };
  service(1, "northwind-web", "web_service", "pro plus", 17500);
  service(2, "northwind-api", "web_service", "pro plus", 17500);
  service(3, "northwind-admin", "web_service", "pro plus", 17500);
  service(4, "northwind-worker", "background_worker", "pro", 8500);
  service(5, "northwind-emails", "background_worker", "pro", 8500);

  inventory.push({
    provider: "render",
    type: "render:postgres",
    externalId: "dpg-demo-northwind-1",
    name: "northwind-db",
    region: "oregon",
    metadata: { plan: "pro_4gb", version: "16", status: "available" },
  });
  inventory.push({
    provider: "render",
    type: "render:redis",
    externalId: "red-demo-northwind-1",
    name: "northwind-cache",
    region: "oregon",
    metadata: { plan: "pro", status: "available" },
  });
  inventory.push({
    provider: "render",
    type: "render:env_group",
    externalId: "evg-demo-northwind-1",
    name: "northwind-shared-env",
    metadata: { envVarCount: 24 },
  });

  const usage = (
    id: string,
    name: string,
    cents: number,
    metadata: Record<string, unknown>
  ) => {
    inventory.push({
      provider: "render",
      type: "render:usage",
      externalId: id,
      name,
      monthlyCostCents: cents,
      metadata,
    });
  };
  usage("usage_demo_render_pg", "Managed Postgres pro (4GB RAM, 256GB)", 19000, {
    kind: "database",
  });
  usage("usage_demo_render_redis", "Managed Redis pro (5GB)", 3200, {
    kind: "database",
  });
  usage(
    "usage_demo_render_bw",
    "Bandwidth beyond included 500GB (~600GB total @ $0.30/GB)",
    12000,
    { kind: "bandwidth", gbMonth: 600 }
  );
  usage("usage_demo_render_seats", "Organization seats ×8", 15200, {
    kind: "seats",
    quantity: 8,
  });

  const total = inventory.reduce((s, i) => s + (i.monthlyCostCents ?? 0), 0);

  findings.push({
    category: "recommendation",
    severity: "info",
    title: "northwind-db: Render Postgres",
    detail:
      "Render managed Postgres migrates via pg_dump/pg_restore to Neon, a VPS Postgres, or any managed provider. Connection strings move to Terraform-managed env vars.",
    resourceRef: "dpg-demo-northwind-1",
  });
  const savings = Math.max(0, total - 2000);
  findings.push({
    category: "cost",
    severity: "high",
    title: `~$${(total / 100).toFixed(0)}/mo on Render services`,
    detail: `Five always-on services, managed Postgres and Redis, seats, and bandwidth total roughly $${(total / 100).toFixed(2)}/mo. Per-instance plan pricing compounds fast once every service needs pro-tier RAM.`,
    monthlySavingsCents: savings,
  });

  return {
    inventory,
    findings,
    estimatedMonthlyCostCents: total,
    estimatedMonthlySavingsCents: savings,
  };
}

// ---------------------------------------------------------------------------
// Railway: usage-billed everything — ~$980/mo
// The connector only prices subscriptions; compute, egress, and plugin
// storage arrive as railway:usage items.
// ---------------------------------------------------------------------------

export function buildDemoRailwayAssessment(): DemoAssessment {
  const inventory: ResourceInventoryItem[] = [];
  const findings: Omit<AssessmentFinding, "id">[] = [];

  inventory.push({
    provider: "railway",
    type: "railway:project",
    externalId: "prj-demo-northwind-rw",
    name: "northwind",
    metadata: { description: "Northwind production" },
  });

  const services = [
    "web",
    "api",
    "admin",
    "worker",
    "scheduler-cron",
    "webhooks",
  ];
  for (const [i, s] of services.entries()) {
    inventory.push({
      provider: "railway",
      type: "railway:service",
      externalId: `svc-demo-northwind-rw-${i + 1}`,
      name: `northwind/${s}`,
      metadata: { icon: null },
    });
  }
  inventory.push({
    provider: "railway",
    type: "railway:plugin",
    externalId: "plg-demo-northwind-pg",
    name: "northwind/PostgreSQL",
    metadata: { pluginType: "postgresql" },
  });
  inventory.push({
    provider: "railway",
    type: "railway:plugin",
    externalId: "plg-demo-northwind-redis",
    name: "northwind/Redis",
    metadata: { pluginType: "redis" },
  });
  for (const env of ["production", "staging"]) {
    inventory.push({
      provider: "railway",
      type: "railway:environment",
      externalId: `env-demo-northwind-${env}`,
      name: `northwind/${env}`,
    });
  }

  const usage = (
    id: string,
    name: string,
    cents: number,
    metadata: Record<string, unknown>
  ) => {
    inventory.push({
      provider: "railway",
      type: "railway:usage",
      externalId: id,
      name,
      monthlyCostCents: cents,
      metadata,
    });
  };
  usage("usage_demo_rw_seats", "Pro seats ×8", 16000, {
    kind: "seats",
    quantity: 8,
  });
  usage(
    "usage_demo_rw_compute",
    "Service compute (vCPU-hours + GB-hours, 6 always-on services)",
    52000,
    { kind: "compute" }
  );
  usage("usage_demo_rw_egress", "Egress (~1.5TB @ $0.10/GB)", 15000, {
    kind: "bandwidth",
    gbMonth: 1500,
  });
  usage(
    "usage_demo_rw_plugins",
    "Plugin compute + storage (Postgres, Redis)",
    15000,
    { kind: "database" }
  );

  const total = inventory.reduce((s, i) => s + (i.monthlyCostCents ?? 0), 0);

  findings.push({
    category: "recommendation",
    severity: "info",
    title: "northwind: Railway Postgres plugin",
    detail:
      "Railway Postgres migrates via pg_dump/pg_restore to Neon, a VPS Postgres, or any managed provider.",
    resourceRef: "plg-demo-northwind-pg",
  });
  const savings = Math.max(0, total - 2000);
  findings.push({
    category: "cost",
    severity: "high",
    title: `~$${(total / 100).toFixed(0)}/mo of Railway usage billing`,
    detail: `Usage-based compute, egress, and per-seat pricing total roughly $${(total / 100).toFixed(2)}/mo, and the bill moves with traffic instead of with plan changes you approve.`,
    monthlySavingsCents: savings,
  });

  return {
    inventory,
    findings,
    estimatedMonthlyCostCents: total,
    estimatedMonthlySavingsCents: savings,
  };
}

// ---------------------------------------------------------------------------
// DigitalOcean: droplets + DOKS + managed databases — ~$1,066/mo
// ---------------------------------------------------------------------------

export function buildDemoDigitaloceanAssessment(): DemoAssessment {
  const inventory: ResourceInventoryItem[] = [];
  const findings: Omit<AssessmentFinding, "id">[] = [];

  const droplet = (
    n: number,
    name: string,
    sizeSlug: string,
    memoryMb: number,
    vcpus: number,
    cents: number
  ) => {
    inventory.push({
      provider: "digitalocean",
      type: "digitalocean:droplet",
      externalId: String(400000000 + n),
      name,
      region: "nyc3",
      monthlyCostCents: cents,
      metadata: {
        sizeSlug,
        image: "docker-20-04",
        vcpus,
        memoryMb,
        diskGb: 160,
        status: "active",
      },
    });
  };
  droplet(1, "northwind-web-1", "gd-2vcpu-8gb", 8192, 2, 7200);
  droplet(2, "northwind-web-2", "gd-2vcpu-8gb", 8192, 2, 7200);
  droplet(3, "northwind-web-3", "gd-2vcpu-8gb", 8192, 2, 7200);
  droplet(4, "northwind-worker-1", "gd-2vcpu-8gb", 8192, 2, 7200);
  droplet(5, "doks-node-pool-1", "s-4vcpu-8gb", 8192, 4, 4800);
  droplet(6, "doks-node-pool-2", "s-4vcpu-8gb", 8192, 4, 4800);
  droplet(7, "doks-node-pool-3", "s-4vcpu-8gb", 8192, 4, 4800);

  inventory.push({
    provider: "digitalocean",
    type: "digitalocean:database",
    externalId: "db-demo-northwind-pg",
    name: "northwind-pg",
    region: "nyc3",
    monthlyCostCents: 24000,
    metadata: {
      engine: "pg",
      version: "16",
      size: "gd-2vcpu-8gb",
      numNodes: 3,
      status: "online",
    },
  });
  inventory.push({
    provider: "digitalocean",
    type: "digitalocean:database",
    externalId: "db-demo-northwind-redis",
    name: "northwind-redis",
    region: "nyc3",
    monthlyCostCents: 18000,
    metadata: {
      engine: "redis",
      version: "7",
      size: "gd-1vcpu-4gb",
      numNodes: 2,
      status: "online",
    },
  });
  inventory.push({
    provider: "digitalocean",
    type: "digitalocean:kubernetes",
    externalId: "k8s-demo-northwind",
    name: "northwind-doks",
    region: "nyc3",
    metadata: { version: "1.31", nodePoolCount: 1, status: "running" },
  });
  for (const s of ["northwind-uploads", "northwind-assets"]) {
    inventory.push({
      provider: "digitalocean",
      type: "digitalocean:space",
      externalId: s,
      name: s,
      region: "nyc3",
      monthlyCostCents: 500,
      metadata: {},
    });
  }
  inventory.push({
    provider: "digitalocean",
    type: "digitalocean:usage",
    externalId: "usage_demo_do_extras",
    name: "Load balancers, backups, snapshots, bandwidth overage",
    monthlyCostCents: 20400,
    metadata: { kind: "bandwidth", gbMonth: 2200 },
  });

  const total = inventory.reduce((s, i) => s + (i.monthlyCostCents ?? 0), 0);

  findings.push({
    category: "recommendation",
    severity: "info",
    title: "northwind-pg: DO Managed Postgres",
    detail:
      "DigitalOcean managed Postgres migrates via pg_dump/pg_restore. A 3-node HA cluster at $240/mo compares against Neon with built-in replication.",
    resourceRef: "db-demo-northwind-pg",
  });
  findings.push({
    category: "risk",
    severity: "medium",
    title: "northwind-doks: DOKS Kubernetes cluster",
    detail:
      "Kubernetes adds an operations tax most teams this size do not need. The workloads on it are containers that run anywhere.",
    resourceRef: "k8s-demo-northwind",
  });
  const savings = Math.max(0, total - 2000);
  findings.push({
    category: "cost",
    severity: "high",
    title: `~$${(total / 100).toFixed(0)}/mo on DigitalOcean`,
    detail: `Seven droplets, two managed database clusters, DOKS, and extras total roughly $${(total / 100).toFixed(2)}/mo.`,
    monthlySavingsCents: savings,
  });

  return {
    inventory,
    findings,
    estimatedMonthlyCostCents: total,
    estimatedMonthlySavingsCents: savings,
  };
}

// ---------------------------------------------------------------------------
// Firebase: per-operation billing at scale — ~$2,570/mo
// The connector prices nothing (billing needs the Cloud Billing API), so the
// whole bill arrives as firebase:usage items.
// ---------------------------------------------------------------------------

export function buildDemoFirebaseAssessment(): DemoAssessment {
  const inventory: ResourceInventoryItem[] = [];
  const findings: Omit<AssessmentFinding, "id">[] = [];

  inventory.push({
    provider: "firebase",
    type: "firebase:project",
    externalId: "northwind-prod",
    name: "northwind-prod",
  });
  for (const s of ["northwind-app", "northwind-marketing", "northwind-docs"]) {
    inventory.push({
      provider: "firebase",
      type: "firebase:hosting_site",
      externalId: `projects/northwind-prod/sites/${s}`,
      name: s,
      metadata: { defaultUrl: `https://${s}.web.app`, type: "DEFAULT_SITE" },
    });
  }
  const fns: { name: string; trigger: string }[] = [
    { name: "api", trigger: "https" },
    { name: "webhooks", trigger: "https" },
    { name: "auth-hooks", trigger: "https" },
    { name: "image-resize", trigger: "google.storage.object.finalize" },
    { name: "search-index", trigger: "google.firestore.document.write" },
    { name: "notifications", trigger: "google.firestore.document.create" },
    { name: "daily-rollup", trigger: "google.pubsub.topic.publish" },
    { name: "hourly-sync", trigger: "google.pubsub.topic.publish" },
    { name: "billing-check", trigger: "google.pubsub.topic.publish" },
    { name: "cleanup", trigger: "google.pubsub.topic.publish" },
    { name: "export-reports", trigger: "https" },
    { name: "stripe-events", trigger: "https" },
  ];
  for (const f of fns) {
    inventory.push({
      provider: "firebase",
      type: "firebase:function",
      externalId: `projects/northwind-prod/locations/us-central1/functions/${f.name}`,
      name: f.name,
      region: "us-central1",
      metadata: { runtime: "nodejs22", trigger: f.trigger, state: "ACTIVE" },
    });
  }
  inventory.push({
    provider: "firebase",
    type: "firebase:firestore_database",
    externalId: "projects/northwind-prod/databases/(default)",
    name: "(default)",
    metadata: { locationId: "nam5", firestoreType: "FIRESTORE_NATIVE" },
  });

  const usage = (
    id: string,
    name: string,
    cents: number,
    metadata: Record<string, unknown>
  ) => {
    inventory.push({
      provider: "firebase",
      type: "firebase:usage",
      externalId: id,
      name,
      monthlyCostCents: cents,
      metadata,
    });
  };
  usage(
    "usage_demo_fb_firestore",
    "Firestore reads/writes/deletes (~1.4B reads/mo)",
    90000,
    { kind: "operations" }
  );
  usage("usage_demo_fb_egress", "Network egress (~6TB/mo)", 70000, {
    kind: "bandwidth",
    gbMonth: 6000,
  });
  usage(
    "usage_demo_fb_functions",
    "Cloud Functions invocations + GB-seconds (~120M/mo)",
    40000,
    { kind: "invocations", millions: 120 }
  );
  usage("usage_demo_fb_hosting", "Hosting bandwidth beyond free tier", 30000, {
    kind: "bandwidth",
    gbMonth: 1500,
  });
  usage("usage_demo_fb_auth", "Firebase Auth MAU beyond free tier", 27000, {
    kind: "seats",
  });

  const total = inventory.reduce((s, i) => s + (i.monthlyCostCents ?? 0), 0);

  findings.push({
    category: "risk",
    severity: "medium",
    title: "Firestore data model is the migration's critical path",
    detail:
      "Firestore's document model and per-operation billing shape the whole app. Migration means a relational redesign (usually Postgres) and a data backfill; infralift scopes this phase explicitly before quoting.",
  });
  const savings = Math.max(0, total - 20000);
  findings.push({
    category: "cost",
    severity: "high",
    title: `~$${(total / 100).toFixed(0)}/mo of per-operation Firebase billing`,
    detail: `Reads, writes, egress, invocations, and MAU pricing total roughly $${(total / 100).toFixed(2)}/mo, and every one of those meters scales with growth. This is the bill that produced the famous $70k-in-a-day stories.`,
    monthlySavingsCents: savings,
  });

  return {
    inventory,
    findings,
    estimatedMonthlyCostCents: total,
    estimatedMonthlySavingsCents: savings,
  };
}
