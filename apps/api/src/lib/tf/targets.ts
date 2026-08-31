// Migration-target HCL, generated from the workload plan.
//
// The source half of codegen maps discovered resources one-for-one so they can
// be imported. The target half cannot work that way: nothing on Hetzner
// corresponds to a Heroku dyno, and a customer migrating off Vercel has no
// resource that becomes a Worker. What carries across is the *workload* — how
// much RAM runs always-on, how much bandwidth leaves the building, whether
// there is a Postgres and a Redis behind it.
//
// So these renderers take the TargetPlan that priced the migration and emit
// exactly the infrastructure it was priced against. If the options page says
// "1× CCX43, 2× CCX13, LB11, Neon 2CU, Upstash 5GB — $422/mo", this file
// stands up those nine resources and nothing else.
//
// Resource schemas verified against the registry, August 2026:
//   hetznercloud/hcloud 1.68, cloudflare/cloudflare 5.24,
//   kislerdm/neon 0.15, upstash/upstash 2.1

import type { ResourceInventoryItem } from "@infralift/shared";
import type { TargetPlan } from "../sizing.js";

export type MigrationTarget = "cloudflare" | "hetzner";

export interface TargetProviderRequirement {
  name: string;
  source: string;
  version: string;
}

/** Providers the generated target file actually references. versions.tf must
 * declare these or `init` fails — the previous generator emitted a
 * neon_project into target-hetzner.tf while only ever declaring the neon
 * provider on the cloudflare path. */
export function targetProviders(
  target: MigrationTarget,
  plan: TargetPlan
): TargetProviderRequirement[] {
  const reqs: TargetProviderRequirement[] = [];

  if (target === "cloudflare") {
    reqs.push({
      name: "cloudflare",
      source: "cloudflare/cloudflare",
      version: "~> 5.0",
    });
  } else {
    reqs.push({
      name: "hcloud",
      source: "hetznercloud/hcloud",
      version: "~> 1.68",
    });
  }

  if (plan.postgres) {
    reqs.push({ name: "neon", source: "kislerdm/neon", version: "~> 0.15" });
  }
  if (plan.redis) {
    reqs.push({ name: "upstash", source: "upstash/upstash", version: "~> 2.1" });
  }

  return reqs;
}

function tfName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_]/g, "_").replace(/^[0-9]/, "_$&");
}

function dollars(cents: number): string {
  return "$" + (cents / 100).toFixed(2);
}

// ---------------------------------------------------------------------------
// What the plan replaces, and what it does not
// ---------------------------------------------------------------------------

type ItemRole = "compute" | "postgres" | "redis" | "other";

const COMPUTE_TYPES = new Set([
  "heroku:dyno",
  "vercel:project",
  "railway:service",
  "digitalocean:droplet",
  "digitalocean:app",
  "flyio:machine",
  "firebase:hosting_site",
  "firebase:function",
  "firebase:cloud_run",
  "gcp:cloud_run",
  "netlify:site",
]);

function itemRole(item: ResourceInventoryItem): ItemRole {
  if (COMPUTE_TYPES.has(item.type)) return "compute";

  const meta = (item.metadata ?? {}) as Record<string, unknown>;
  const haystack = (
    String(meta.plan ?? "") +
    " " +
    String(meta.pluginType ?? "") +
    " " +
    String(meta.engine ?? "") +
    " " +
    item.type +
    " " +
    item.name
  ).toLowerCase();

  if (haystack.includes("postgres") || haystack.includes("cloud_sql")) {
    return "postgres";
  }
  if (haystack.includes("redis") || haystack.includes("valkey")) return "redis";

  // Render services arrive as render:<type> with the plan in metadata.
  if (item.type.startsWith("render:") && meta.plan !== undefined) return "compute";

  return "other";
}

/** The old generator listed every paid source resource under "decommission",
 * which quietly implied the target replaced things it does not — a log drain,
 * a message broker. Splitting the list is the difference between a cutover
 * checklist and a surprise during one. */
function renderCoverage(
  plan: TargetPlan,
  inventory: ResourceInventoryItem[]
): string[] {
  const replaced: ResourceInventoryItem[] = [];
  const unreplaced: ResourceInventoryItem[] = [];

  for (const item of inventory) {
    if (item.type.endsWith(":usage")) continue;
    switch (itemRole(item)) {
      case "compute":
        replaced.push(item);
        break;
      case "postgres":
        (plan.postgres ? replaced : unreplaced).push(item);
        break;
      case "redis":
        (plan.redis ? replaced : unreplaced).push(item);
        break;
      default:
        unreplaced.push(item);
    }
  }

  const describe = (i: ResourceInventoryItem) => {
    const cost = i.monthlyCostCents ?? 0;
    return (
      "#   " + i.type + " " + i.name + (cost > 0 ? " — " + dollars(cost) + "/mo" : "")
    );
  };

  const lines: string[] = [];

  if (replaced.length > 0) {
    lines.push(
      "# Replaced by this configuration. Decommission after cutover completes",
      "# and the rollback window closes (docs/migration-process.md):",
      ...replaced.map(describe),
      ""
    );
  }

  if (unreplaced.length > 0) {
    lines.push(
      "# NOT replaced by this configuration. Each needs a decision before",
      "# cutover — keep it where it is, or migrate it separately:",
      ...unreplaced.map(describe),
      ""
    );
  }

  const usage = inventory.filter(
    (i) => i.type.endsWith(":usage") && (i.monthlyCostCents ?? 0) > 0
  );
  if (usage.length > 0) {
    lines.push(
      "# Usage-based charges on the current bill. These stop when traffic moves,",
      "# and they are where the savings on this migration come from:",
      ...usage.map(describe),
      ""
    );
  }

  return lines;
}

// ---------------------------------------------------------------------------
// Shared data services
// ---------------------------------------------------------------------------

function renderNeon(plan: TargetPlan, projectName: string): string[] {
  const pg = plan.postgres;
  if (!pg) return [];

  return [
    "# Managed Postgres. Priced at " + dollars(pg.monthlyCents) + "/mo: " + pg.note,
    'resource "neon_project" "main" {',
    '  name       = "' + projectName + '"',
    "  region_id  = var.neon_region_id",
    "  pg_version = var.postgres_version",
    "",
    "  default_endpoint_settings {",
    "    autoscaling_limit_min_cu = " + pg.minComputeUnits,
    "    autoscaling_limit_max_cu = " + pg.maxComputeUnits,
    // Keep the primary warm; a cold start on every request is the usual
    // complaint after moving off an always-on managed Postgres.
    "    suspend_timeout_seconds  = " + (pg.tier === "large" ? "-1" : "300"),
    "  }",
    "",
    "  branch {",
    '    name          = "main"',
    '    database_name = "' + tfName(projectName) + '"',
    '    role_name     = "app"',
    "  }",
    "}",
    "",
  ];
}

function renderUpstash(plan: TargetPlan, projectName: string): string[] {
  const redis = plan.redis;
  if (!redis) return [];

  return [
    "# Managed Redis. Priced at " + dollars(redis.monthlyCents) +
      "/mo against a " + redis.sizeLabel + " working set.",
    'resource "upstash_redis_database" "cache" {',
    '  database_name  = "' + projectName + '-cache"',
    '  region         = "global"',
    "  primary_region = var.upstash_primary_region",
    "  tls            = true",
    "  eviction       = true",
    // budget is Upstash's spend cap; pinning it to the quoted price means an
    // unexpected traffic spike throttles instead of silently outrunning the
    // estimate this file was generated from.
    "  budget         = " + redis.budgetUsd,
    "}",
    "",
  ];
}

// ---------------------------------------------------------------------------
// Hetzner
// ---------------------------------------------------------------------------

const CLOUD_INIT = [
  "locals {",
  "  cloud_init = <<-EOT",
  "    #cloud-config",
  "    package_update: true",
  "    packages:",
  "      - ca-certificates",
  "      - curl",
  "    runcmd:",
  "      - install -m 0755 -d /etc/apt/keyrings",
  "      - curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc",
  "      - chmod a+r /etc/apt/keyrings/docker.asc",
  '      - echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" > /etc/apt/sources.list.d/docker.list',
  "      - apt-get update",
  "      - apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin",
  "      - systemctl enable --now docker",
  "      # Application deploy runs from CI after cutover; see docs/migration-process.md",
  "  EOT",
  "}",
  "",
];

function renderHetzner(
  plan: TargetPlan,
  projectName: string,
  inventory: ResourceInventoryItem[]
): string[] {
  const hetzner = plan.hetzner!;
  const lines: string[] = [];

  lines.push(
    'resource "hcloud_ssh_key" "infralift" {',
    '  name       = "' + projectName + '"',
    "  public_key = var.hetzner_ssh_public_key",
    "}",
    "",
    'resource "hcloud_network" "main" {',
    '  name     = "' + projectName + '"',
    '  ip_range = "10.0.0.0/16"',
    "}",
    "",
    'resource "hcloud_network_subnet" "app" {',
    "  network_id   = hcloud_network.main.id",
    '  type         = "cloud"',
    "  network_zone = var.hetzner_network_zone",
    '  ip_range     = "10.0.1.0/24"',
    "}",
    "",
    'resource "hcloud_firewall" "app" {',
    '  name = "' + projectName + '"',
    "",
    "  rule {",
    '    direction  = "in"',
    '    protocol   = "tcp"',
    '    port       = "80"',
    '    source_ips = ["0.0.0.0/0", "::/0"]',
    "  }",
    "",
    "  rule {",
    '    direction  = "in"',
    '    protocol   = "tcp"',
    '    port       = "443"',
    '    source_ips = ["0.0.0.0/0", "::/0"]',
    "  }",
    "",
    "  rule {",
    '    direction  = "in"',
    '    protocol   = "tcp"',
    '    port       = "22"',
    "    source_ips = var.hetzner_ssh_source_ips",
    "  }",
    "}",
    "",
    ...CLOUD_INIT
  );

  for (const group of hetzner.instances) {
    const resName = "app_" + tfName(group.serverType);
    lines.push(
      "# " + group.count + "× " + group.displayName + " — " + group.vcpu +
        " vCPU / " + group.ramGb + "GB dedicated, " +
        dollars(group.monthlyCentsEach) + "/mo each",
      'resource "hcloud_server" "' + resName + '" {',
      "  count        = " + group.count,
      '  name         = "' + projectName + "-" + group.serverType +
        '-${count.index + 1}"',
      '  server_type  = "' + group.serverType + '"',
      "  image        = var.hetzner_image",
      "  location     = var.hetzner_location",
      "  ssh_keys     = [hcloud_ssh_key.infralift.id]",
      "  firewall_ids = [hcloud_firewall.app.id]",
      "  user_data    = local.cloud_init",
      "",
      "  public_net {",
      "    ipv4_enabled = true",
      "    ipv6_enabled = true",
      "  }",
      "",
      "  network {",
      "    subnet_id = hcloud_network_subnet.app.id",
      "",
      "    # Terraform 1.4+ detaches and reattaches the network on every apply",
      "    # unless alias_ips is set explicitly. hetznercloud/terraform-provider-hcloud#650",
      "    alias_ips = []",
      "  }",
      "",
      "  labels = {",
      '    managed_by = "infralift"',
      '    role       = "app"',
      "  }",
      "",
      "  # Subnets cannot be referenced through the API until they exist, and",
      "  # the provider would otherwise create both in parallel.",
      "  depends_on = [hcloud_network_subnet.app]",
      "}",
      ""
    );
  }

  if (hetzner.loadBalancer) {
    lines.push(
      "# " + plan.webInstances +
        " web processes were found, so traffic needs a front door. TLS is passed",
      "# through to Caddy on each instance rather than terminated here.",
      'resource "hcloud_load_balancer" "web" {',
      '  name               = "' + projectName + '"',
      '  load_balancer_type = "lb11"',
      "  location           = var.hetzner_location",
      "}",
      "",
      'resource "hcloud_load_balancer_network" "web" {',
      "  load_balancer_id = hcloud_load_balancer.web.id",
      "  subnet_id        = hcloud_network_subnet.app.id",
      "}",
      ""
    );

    for (const group of hetzner.instances) {
      const resName = "app_" + tfName(group.serverType);
      lines.push(
        'resource "hcloud_load_balancer_target" "' + resName + '" {',
        "  count            = " + group.count,
        '  type             = "server"',
        "  load_balancer_id = hcloud_load_balancer.web.id",
        "  server_id        = hcloud_server." + resName + "[count.index].id",
        "  use_private_ip   = true",
        "",
        "  depends_on = [hcloud_load_balancer_network.web]",
        "}",
        ""
      );
    }

    for (const [name, port] of [
      ["http", 80],
      ["https", 443],
    ] as const) {
      lines.push(
        'resource "hcloud_load_balancer_service" "' + name + '" {',
        "  load_balancer_id = hcloud_load_balancer.web.id",
        '  protocol         = "tcp"',
        "  listen_port      = " + port,
        "  destination_port = " + port,
        "}",
        ""
      );
    }
  }

  lines.push(...renderNeon(plan, projectName), ...renderUpstash(plan, projectName));

  // Variables
  lines.push(
    'variable "hetzner_ssh_public_key" {',
    '  description = "SSH public key injected into every instance at creation"',
    "  type        = string",
    "}",
    "",
    'variable "hetzner_ssh_source_ips" {',
    '  description = "CIDRs allowed to reach SSH. Default is deliberately closed."',
    "  type        = list(string)",
    "  default     = []",
    "}",
    "",
    'variable "hetzner_location" {',
    '  description = "Hetzner location (nbg1, fsn1, hel1, ash, hil, sin)"',
    "  type        = string",
    '  default     = "nbg1"',
    "}",
    "",
    'variable "hetzner_network_zone" {',
    '  description = "Network zone containing the location (eu-central, us-east, us-west, ap-southeast)"',
    "  type        = string",
    '  default     = "eu-central"',
    "}",
    "",
    'variable "hetzner_image" {',
    '  description = "Base image for application instances"',
    "  type        = string",
    '  default     = "ubuntu-24.04"',
    "}",
    ""
  );

  lines.push(...sharedDataVariables(plan));

  // Outputs
  const ipRefs = hetzner.instances.map(
    (g) => "hcloud_server.app_" + tfName(g.serverType) + "[*].ipv4_address"
  );
  lines.push(
    'output "app_server_ipv4" {',
    '  description = "Public IPv4 of each application instance"',
    "  value       = concat(" + ipRefs.join(", ") + ")",
    "}",
    ""
  );

  if (hetzner.loadBalancer) {
    lines.push(
      'output "load_balancer_ipv4" {',
      '  description = "Point your DNS A record here"',
      "  value       = hcloud_load_balancer.web.ipv4",
      "}",
      ""
    );
  }

  lines.push(...sharedDataOutputs(plan), ...renderCoverage(plan, inventory));

  return lines;
}

// ---------------------------------------------------------------------------
// Cloudflare
// ---------------------------------------------------------------------------

type WorkerRole = "web" | "cron" | "queue";

/** What a discovered entrypoint becomes on Workers. The assessment can see a
 * process exists and what it is called; it cannot see the code. Names are the
 * signal available, and the same one inferProfile uses to derive the cron and
 * background_workers needs. */
function workerRole(item: ResourceInventoryItem): WorkerRole {
  const meta = (item.metadata ?? {}) as Record<string, unknown>;
  const haystack = (
    item.name + " " + String(meta.type ?? "") + " " + String(meta.processType ?? "")
  ).toLowerCase();

  if (haystack.includes("cron") || haystack.includes("schedule")) return "cron";
  if (
    haystack.includes("queue") ||
    haystack.includes("consumer") ||
    haystack.includes("worker")
  ) {
    return "queue";
  }
  return "web";
}

function roleLabel(role: WorkerRole): string {
  if (role === "cron") return "scheduled";
  if (role === "queue") return "queue consumer";
  return "request handler";
}

function renderCloudflare(
  plan: TargetPlan,
  projectName: string,
  inventory: ResourceInventoryItem[]
): string[] {
  const cf = plan.cloudflare!;
  const lines: string[] = [];

  if (cf.r2Gb > 0) {
    lines.push(
      "# ~" + Math.round(cf.r2Gb) +
        "GB of object storage was in the assessment. Reads out of R2 are free,",
      "# which is where most of the egress saving on this migration comes from.",
      'resource "cloudflare_r2_bucket" "assets" {',
      "  account_id = var.cloudflare_account_id",
      '  name       = "' + projectName + '-assets"',
      "  location   = var.r2_location",
      "}",
      ""
    );
  }

  // One Worker per discovered front door. A queue consumer and a cron job are
  // not fetch handlers, though: emitting all three as identical request-serving
  // Workers would be the same source-type-driven guess this module exists to
  // replace, so each gets the trigger its role actually needs.
  const entrypoints = inventory.filter((i) =>
    [
      "vercel:project",
      "heroku:app",
      "render:web_service",
      "digitalocean:app",
      "railway:service",
      "firebase:hosting_site",
    ].includes(i.type)
  );

  const workers =
    entrypoints.length > 0
      ? entrypoints.map((i) => ({
          resName: tfName(i.name),
          scriptName: i.name,
          from: i.type,
          role: workerRole(i),
        }))
      : [
          {
            resName: "app",
            scriptName: projectName,
            from: "inferred workload",
            role: "web" as WorkerRole,
          },
        ];

  const consumers = workers.filter((w) => w.role === "queue");
  const needsQueue = consumers.length > 0 || plan.workerInstances > 0;

  if (needsQueue) {
    lines.push(
      "# Background work has no always-on process to live in on Workers; it",
      "# becomes a queue plus a consumer Worker.",
      'resource "cloudflare_queue" "jobs" {',
      "  account_id = var.cloudflare_account_id",
      '  queue_name = "' + projectName + '-jobs"',
      "}",
      ""
    );
  }

  // Worker bodies come from var.worker_bundles rather than from a file path.
  // Pointing content_file at a build artifact reads better but calls
  // filesha256() on a path that does not exist until CI has run, and that
  // fails `validate` — infrastructure you cannot check before building the
  // app is not much use as a review artifact.
  lines.push(
    "locals {",
    "  # Stands in until the real bundle is supplied. Deploying it creates the",
    "  # Worker and its bindings without serving traffic from them.",
    "  placeholder_worker = <<-EOT",
    "    export default {",
    "      async fetch() {",
    '        return new Response("Not deployed yet", { status: 503 });',
    "      },",
    "    };",
    "  EOT",
    "}",
    ""
  );

  for (const worker of workers) {
    lines.push(
      "# Replaces " + worker.from + ": " + worker.scriptName +
        " (" + roleLabel(worker.role) + ")",
      'resource "cloudflare_workers_script" "' + worker.resName + '" {',
      "  account_id  = var.cloudflare_account_id",
      '  script_name = "' + worker.scriptName + '"',
      "",
      "  content     = lookup(var.worker_bundles, \"" + worker.scriptName +
        '", local.placeholder_worker)',
      '  main_module = "index.js"',
      "",
      "  compatibility_date  = var.workers_compatibility_date",
      '  compatibility_flags = ["nodejs_compat"]',
      "",
      "  observability = {",
      "    enabled = true",
      "  }"
    );

    const bindings: string[] = [];
    if (cf.r2Gb > 0) {
      bindings.push(
        "    {",
        '      name        = "ASSETS"',
        '      type        = "r2_bucket"',
        "      bucket_name = cloudflare_r2_bucket.assets.name",
        "    },"
      );
    }
    if (plan.postgres) {
      bindings.push(
        "    {",
        '      name = "DATABASE_URL"',
        '      type = "secret_text"',
        "      text = neon_project.main.connection_uri_pooler",
        "    },"
      );
    }
    if (plan.redis) {
      bindings.push(
        "    {",
        '      name = "REDIS_URL"',
        '      type = "secret_text"',
        "      text = upstash_redis_database.cache.endpoint",
        "    },",
        "    {",
        '      name = "REDIS_TOKEN"',
        '      type = "secret_text"',
        "      text = upstash_redis_database.cache.rest_token",
        "    },"
      );
    }
    // Producers need the queue binding; the consumer is attached separately.
    if (needsQueue && worker.role !== "queue") {
      bindings.push(
        "    {",
        '      name       = "JOBS"',
        '      type       = "queue"',
        "      queue_name = cloudflare_queue.jobs.queue_name",
        "    },"
      );
    }

    if (bindings.length > 0) {
      lines.push("", "  bindings = [", ...bindings, "  ]");
    }

    lines.push("}", "");

    if (worker.role === "cron") {
      lines.push(
        "# Scheduled work. Confirm the expression matches the job it replaces —",
        "# the assessment can see that a schedule exists, not what it was set to.",
        'resource "cloudflare_workers_cron_trigger" "' + worker.resName + '" {',
        "  account_id  = var.cloudflare_account_id",
        "  script_name = cloudflare_workers_script." + worker.resName + ".script_name",
        "",
        "  schedules = [{",
        '    cron = var.cron_schedule',
        "  }]",
        "}",
        ""
      );
    }

    if (worker.role === "queue") {
      lines.push(
        'resource "cloudflare_queue_consumer" "' + worker.resName + '" {',
        "  account_id  = var.cloudflare_account_id",
        "  queue_id    = cloudflare_queue.jobs.queue_id",
        "  script_name = cloudflare_workers_script." + worker.resName + ".script_name",
        "  type        = " + '"worker"',
        "}",
        ""
      );
    }
  }

  lines.push(...renderNeon(plan, projectName), ...renderUpstash(plan, projectName));

  // Variables
  lines.push(
    'variable "cloudflare_account_id" {',
    '  description = "Cloudflare account ID"',
    "  type        = string",
    "  sensitive   = true",
    "}",
    "",
    'variable "workers_compatibility_date" {',
    '  description = "Workers runtime compatibility date"',
    "  type        = string",
    '  default     = "2026-08-01"',
    "}",
    "",
    'variable "worker_bundles" {',
    '  description = "Built Worker source keyed by script name. CI populates this; any script left out deploys the placeholder."',
    "  type        = map(string)",
    "  default     = {}",
    "}",
    ""
  );

  if (cf.r2Gb > 0) {
    lines.push(
      'variable "r2_location" {',
      '  description = "R2 location hint (wnam, enam, weur, eeur, apac, oc)"',
      "  type        = string",
      '  default     = "enam"',
      "}",
      ""
    );
  }

  if (workers.some((w) => w.role === "cron")) {
    lines.push(
      'variable "cron_schedule" {',
      '  description = "Cron expression for scheduled Workers. Set this to match the job being replaced."',
      "  type        = string",
      '  default     = "0 * * * *"',
      "}",
      ""
    );
  }

  lines.push(...sharedDataVariables(plan));

  // Outputs
  lines.push(
    'output "worker_names" {',
    '  description = "Workers created by this migration"',
    "  value = [",
    ...workers.map(
      (w) => "    cloudflare_workers_script." + w.resName + ".script_name,"
    ),
    "  ]",
    "}",
    ""
  );

  if (cf.r2Gb > 0) {
    lines.push(
      'output "r2_bucket_name" {',
      "  value = cloudflare_r2_bucket.assets.name",
      "}",
      ""
    );
  }

  lines.push(...sharedDataOutputs(plan), ...renderCoverage(plan, inventory));

  return lines;
}

// ---------------------------------------------------------------------------
// Shared variable/output blocks for the data services
// ---------------------------------------------------------------------------

function sharedDataVariables(plan: TargetPlan): string[] {
  const lines: string[] = [];

  if (plan.postgres) {
    lines.push(
      'variable "neon_region_id" {',
      '  description = "Neon deployment region. Keep it close to the compute."',
      "  type        = string",
      '  default     = "aws-us-east-1"',
      "}",
      "",
      'variable "postgres_version" {',
      '  description = "Postgres major version. Match the source to keep the dump/restore clean."',
      "  type        = number",
      "  default     = 16",
      "}",
      ""
    );
  }

  if (plan.redis) {
    lines.push(
      'variable "upstash_primary_region" {',
      '  description = "Primary region for the Redis database"',
      "  type        = string",
      '  default     = "us-east-1"',
      "}",
      ""
    );
  }

  return lines;
}

function sharedDataOutputs(plan: TargetPlan): string[] {
  const lines: string[] = [];

  if (plan.postgres) {
    lines.push(
      'output "database_url" {',
      '  description = "Pooled connection string for the migrated database"',
      "  value       = neon_project.main.connection_uri_pooler",
      "  sensitive   = true",
      "}",
      ""
    );
  }

  if (plan.redis) {
    lines.push(
      'output "redis_endpoint" {',
      "  value = upstash_redis_database.cache.endpoint",
      "}",
      ""
    );
  }

  return lines;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function renderMigrationTarget(
  target: MigrationTarget,
  plan: TargetPlan,
  inventory: ResourceInventoryItem[],
  projectName: string
): string {
  const header = [
    "# Migration target: " + (target === "hetzner" ? "Hetzner Cloud" : "Cloudflare"),
    "#",
    "# Generated by infralift from the assessed workload rather than from the",
    "# source provider's resource types. These are the resources the migration",
    "# estimate was priced against, so the number on the options page and the",
    "# infrastructure below describe the same thing.",
    "#",
    "# Workload: " + plan.webInstances + " web process(es), " +
      plan.workerInstances + " worker process(es), ~" +
      Math.round(plan.bandwidthGbMonth) + "GB/mo egress" +
      (plan.postgres ? ", Postgres (" + plan.postgres.tier + ")" : "") +
      (plan.redis ? ", Redis (" + plan.redis.tier + ")" : "") +
      ".",
    "#",
    "# Review before applying. Cutover sequencing is in docs/migration-process.md.",
    "",
  ];

  const body =
    target === "hetzner"
      ? renderHetzner(plan, projectName, inventory)
      : renderCloudflare(plan, projectName, inventory);

  return [...header, ...body].join("\n");
}
