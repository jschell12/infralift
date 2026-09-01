import type {
  MigrationPlanPhase,
  MigrationPlan,
  MigrationPlanArea,
  MigrationPlanSection,
  MigrationPlanStep,
  ResourceInventoryItem,
} from "@infralift/shared";

// Builders emit steps without ids; finalise() assigns them, so a step cannot
// be given a duplicate id by hand and ids stay stable as long as the order
// within a section does.
type DraftStep = Omit<MigrationPlanStep, "id" | "phase" | "automatable"> & {
  phase?: MigrationPlanPhase;
  automatable?: boolean;
};
type DraftSection = Omit<MigrationPlanSection, "steps"> & { steps: DraftStep[] };

/** Where a section's steps sit unless a step says otherwise. */
const DEFAULT_PHASE: Record<MigrationPlanArea, MigrationPlanPhase> = {
  data: "prepare",
  dns: "prepare",
  secrets: "prepare",
  cicd: "prepare",
  rollback: "cutover",
  verification: "verify",
};

function finalise(section: DraftSection): MigrationPlanSection {
  return {
    ...section,
    steps: section.steps.map((step, i) => ({
      ...step,
      id: `${section.area}.${i + 1}`,
      phase: step.phase ?? DEFAULT_PHASE[section.area],
      automatable: step.automatable ?? false,
    })),
  };
}

// The migration plan: data sync, DNS cutover, secrets, CI/CD, rollback and
// verification.
//
// These are the parts of a migration that this product does not perform. The
// codegen builds the target; a human still has to move the data and flip the
// traffic. Leaving them undescribed was the real problem — the site promised
// "parallel build, zero downtime, instant rollback" while nothing in the
// assessment said what any of that would involve for the account in front of
// it. Scoping the work is not the same as doing it, but it is what makes a
// fixed fee something a buyer can evaluate rather than take on faith.
//
// Two rules this file follows:
//
//   1. Every step is derived from an inventory item and carries the evidence.
//      A plan that would read identically for any account is a template, and a
//      buyer can tell the difference immediately.
//   2. No effort or duration estimates for the engagement. Downtime windows
//      are here because they follow from database size and cutover method and
//      can be checked. "This takes 20 hours" cannot be derived from an
//      inventory, and the areas most likely to overrun — app compatibility,
//      framework behaviour — are exactly the ones an inventory cannot see.
//      That is what `notCovered` is for.

interface PlanInput {
  provider: string;
  target: string;
  inventory: ResourceInventoryItem[];
}

const meta = (item: ResourceInventoryItem): Record<string, unknown> =>
  (item.metadata as Record<string, unknown> | undefined) ?? {};

const str = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : null;

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

// --- database sizing -------------------------------------------------------

/** Postgres plans, coarsely. The cutover method follows from size: a dump and
 * restore is simple and needs a write freeze proportional to the data; logical
 * replication is more setup but cuts the freeze to the time it takes to
 * promote. The boundary is fuzzy and deliberately conservative. */
interface DbClass {
  label: string;
  method: string;
  downtime: string;
}

function classifyPostgres(planName: string | null): DbClass {
  const plan = (planName ?? "").toLowerCase();

  // Heroku essential/mini/basic and Render starter tiers are single-digit GB.
  if (/essential|mini|basic|starter|hobby|free/.test(plan)) {
    return {
      label: "small (single-digit GB)",
      method: "pg_dump and pg_restore during a short write freeze",
      downtime: "10-20 minutes of writes paused",
    };
  }
  // Standard/Pro tiers run to a few hundred GB; a dump is still possible but
  // the freeze starts to be felt by users.
  if (/standard|pro|premium-[0-3]|small|medium/.test(plan)) {
    return {
      label: "medium (tens to low hundreds of GB)",
      method:
        "logical replication into the new database, then promote, with pg_dump as the fallback",
      downtime: "under 5 minutes if replication is used, 1-3 hours if dumped",
    };
  }
  if (plan) {
    return {
      label: "large",
      method: "logical replication and promote — a dump is not practical",
      downtime: "under 5 minutes at promotion",
    };
  }
  return {
    label: "unknown size",
    method: "to be decided once the database size is confirmed",
    downtime: "not yet derivable — depends on size",
  };
}

// --- sections --------------------------------------------------------------

function dataSection(inv: ResourceInventoryItem[]): DraftSection {
  const postgres = inv.filter((i) =>
    /postgres/i.test(`${i.type} ${str(meta(i).plan) ?? ""} ${i.name}`)
  );
  const redis = inv.filter((i) =>
    /redis|valkey|memcach/i.test(`${i.type} ${str(meta(i).plan) ?? ""} ${i.name}`)
  );
  const buckets = inv.filter((i) => /bucket|spaces|blob|storage/i.test(i.type));

  const steps: DraftStep[] = [];
  const risks: string[] = [];
  let downtime: string | null = null;

  for (const db of postgres) {
    const plan = str(meta(db).plan);
    const c = classifyPostgres(plan);
    downtime = downtime ?? c.downtime;
    steps.push({
      title: `Move ${db.name}`,
      detail: `${plan ?? "Managed Postgres"} — ${c.label}. ${c.method}. Schema and extensions are copied first and verified against the source before any data moves.`,
      owner: "infralift",
      evidence: `${db.type} ${db.externalId}`,
    });
    steps.push({
      title: `Agree the write freeze window for ${db.name}`,
      detail: `Expected ${c.downtime}. We need a window you are willing to take writes offline for, and someone reachable during it.`,
      owner: "customer",
      phase: "cutover",
      evidence: `${db.type} ${db.externalId}`,
    });
  }

  if (postgres.length === 0) {
    steps.push({
      title: "No managed database found in the inventory",
      detail:
        "Nothing in the assessed account looks like a managed Postgres. If your data lives somewhere the assessment could not see — a database on another account, a third-party service — tell us, because it changes the cutover shape entirely.",
      owner: "customer",
    });
    risks.push(
      "A database the assessment cannot see is the most common reason a migration plan turns out to be wrong."
    );
  }

  for (const r of redis) {
    steps.push({
      title: `Re-create ${r.name} empty`,
      detail:
        "Caches are not migrated; the new instance starts cold and repopulates. This is only safe if nothing durable lives there.",
      owner: "infralift",
      evidence: `${r.type} ${r.externalId}`,
    });
    risks.push(
      `${r.name} is treated as a cache. If it is also holding queue state, sessions or rate-limit counters, say so — that data does need moving and it changes the cutover.`
    );
  }

  for (const b of buckets) {
    steps.push({
      title: `Copy objects from ${b.name}`,
      detail:
        "Bulk copy ahead of cutover, then a second incremental pass immediately before the flip to catch anything written in between.",
      owner: "infralift",
      evidence: `${b.type} ${b.externalId}`,
    });
  }

  return {
    area: "data",
    title: "Data sync",
    summary:
      postgres.length > 0
        ? `${postgres.length} database(s), ${redis.length} cache(s), ${buckets.length} object store(s) to move.`
        : "No managed database was found in the assessed account.",
    steps,
    downtime,
    risks,
  };
}

function dnsSection(inv: ResourceInventoryItem[]): DraftSection {
  const domains = inv.filter((i) => /domain/i.test(i.type));
  const steps: DraftStep[] = [];
  const risks: string[] = [];

  steps.push({
    title: "Lower TTL on the records that will move",
    detail:
      "At least 24 hours before cutover, drop TTL to 60 seconds. This is what makes the rollback fast; at a 3600s TTL a bad flip is stuck for an hour.",
    owner: "customer",
    // Queryable: we can read the record's TTL rather than ask whether it was done.
    automatable: true,
  });

  for (const d of domains) {
    const apex = d.name.split(".").filter(Boolean).length <= 2;
    steps.push({
      title: `Cut over ${d.name}`,
      detail: apex
        ? "Apex domain: it cannot take a CNAME, so this needs an ALIAS/ANAME record or an A record to a fixed address. Check your registrar supports the one we choose before the day."
        : "Subdomain: a CNAME to the new target, flipped after the target is verified serving the same content.",
      owner: "shared",
      phase: "cutover",
      // Propagation is observable from public resolvers.
      automatable: true,
      evidence: `${d.type} ${d.externalId}`,
    });
  }

  if (domains.length === 0) {
    steps.push({
      title: "No custom domains found",
      detail:
        "The assessment saw no custom domains. If you serve on one we could not see, it needs to be in the plan — a missed hostname is a partial outage that looks like a working cutover.",
      owner: "customer",
    });
  }

  steps.push({
    title: "Verify the target serves correctly before any DNS changes",
    detail:
      "The new stack is exercised on a temporary hostname and compared against production. Nothing points at it until that passes.",
    owner: "infralift",
    // A response diff against production is a probe, not a judgement call.
    automatable: true,
  });

  risks.push(
    "Resolvers that ignore TTL, and clients holding connections, mean a flip is never instantaneous. Both stacks stay up during the overlap."
  );
  if (domains.some((d) => d.name.split(".").filter(Boolean).length <= 2)) {
    risks.push(
      "Apex domains are the usual source of cutover surprises: registrar support for ALIAS/ANAME varies, and some only offer it on their own nameservers."
    );
  }

  return {
    area: "dns",
    title: "DNS cutover",
    summary:
      domains.length > 0
        ? `${domains.length} hostname(s) to move.`
        : "No custom domains in the assessed account.",
    steps,
    downtime: "None if the overlap is respected: both stacks serve during it.",
    risks,
  };
}

function secretsSection(inv: ResourceInventoryItem[]): DraftSection {
  const withEnv = inv
    .map((i) => ({ item: i, count: num(meta(i).envVarCount) ?? 0 }))
    .filter((x) => x.count > 0);
  const total = withEnv.reduce((n, x) => n + x.count, 0);

  const steps: DraftStep[] = [
    {
      title: "Export the variable names and values from the source",
      detail:
        "This has to be you. The assessment records how many environment variables each project has and never reads their names or values, so we do not have them and cannot get them.",
      owner: "customer",
    },
    {
      title: "Load them into the target",
      detail:
        "Set on the target as secrets rather than committed to the repository. The generated Terraform declares variables for them; the values are supplied out of band.",
      owner: "shared",
    },
    {
      title: "Rotate anything that was shared with the old platform",
      detail:
        "A migration is the cheapest opportunity you will get to rotate credentials that a departed platform once held.",
      owner: "customer",
    },
  ];

  return {
    area: "secrets",
    title: "Secrets and configuration",
    summary:
      total > 0
        ? `${total} environment variable(s) across ${withEnv.length} project(s). Counts only — we have never seen the names or the values.`
        : "No environment variables were counted in the assessed account.",
    steps,
    downtime: null,
    risks: [
      "Values that differ between preview and production are a common cause of a target that boots but behaves differently.",
      "Anything referencing the old platform's own URLs or internal hostnames has to be found and changed by hand.",
    ],
  };
}

function cicdSection(inv: ResourceInventoryItem[]): DraftSection {
  const repos = new Map<string, ResourceInventoryItem>();
  for (const i of inv) {
    const repo = str(meta(i).gitRepo);
    if (repo && !repos.has(repo)) repos.set(repo, i);
  }

  const steps: DraftStep[] = [];
  const risks: string[] = [];

  for (const [repo, item] of repos) {
    const branch = str(meta(item).productionBranch) ?? "the production branch";
    const build = str(meta(item).buildCommand);
    const install = str(meta(item).installCommand);
    steps.push({
      title: `Replace the deploy pipeline for ${repo}`,
      detail:
        `Pushes to ${branch} currently deploy through the source platform's git integration. That is replaced with a workflow that builds and deploys to the target.` +
        (build ? ` Your build command is \`${build}\`` : "") +
        (install ? ` and install is \`${install}\`` : "") +
        (build || install ? ", and both are reproduced as-is." : ""),
      owner: "infralift",
      evidence: `${item.type} ${item.externalId}`,
    });
    steps.push({
      title: `Disconnect the old git integration for ${repo}`,
      detail:
        "Done last, after the new pipeline has deployed successfully at least once. Doing it early removes the rollback path.",
      owner: "customer",
      phase: "decommission",
      evidence: `${item.type} ${item.externalId}`,
    });
  }

  if (repos.size === 0) {
    steps.push({
      title: "No git integration found in the inventory",
      detail:
        "The assessment saw no linked repository. How you deploy today needs to be established before the pipeline can be replaced.",
      owner: "customer",
    });
  }

  risks.push(
    "Preview and per-branch deployments are a platform feature, not a repository one. If your team relies on them, replacing them is its own piece of work and is not covered by the configuration this assessment generates."
  );

  return {
    area: "cicd",
    title: "Build and deploy pipeline",
    summary:
      repos.size > 0
        ? `${repos.size} repository/repositories to re-point.`
        : "No linked repository found in the assessed account.",
    steps,
    downtime: null,
    risks,
  };
}

function rollbackSection(inv: ResourceInventoryItem[]): DraftSection {
  const hasDb = inv.some((i) =>
    /postgres/i.test(`${i.type} ${str(meta(i).plan) ?? ""} ${i.name}`)
  );

  const steps: DraftStep[] = [
    {
      title: "Keep the old stack running through the overlap",
      detail:
        "It is not torn down at cutover. You pay both bills for the overlap, and that cost is the price of a rollback that works.",
      owner: "shared",
    },
    {
      title: "Roll back by reverting DNS",
      detail:
        "While traffic is the only thing that moved, rollback is putting the records back. This is why the TTL is lowered first.",
      owner: "infralift",
    },
  ];

  if (hasDb) {
    steps.push({
      title: "Decide the cutoff for a free rollback",
      detail:
        "Once the new database has taken writes, reverting DNS alone loses them. Past that point a rollback means reconciling writes, which is a different and much longer operation. Agree in advance how long the window is and who calls it.",
      owner: "shared",
    });
  }

  steps.push({
    title: "Decommission the old stack only on your say-so",
    detail:
      "After an agreed period of the new stack serving normally. Never automatically.",
    owner: "customer",
    phase: "decommission",
  });

  return {
    area: "rollback",
    title: "Rollback",
    summary: hasDb
      ? "Free while traffic is the only thing that has moved. It stops being free at the first write to the new database."
      : "Free for the whole overlap: with no database to move, rollback is a DNS revert.",
    steps,
    downtime: null,
    risks: [
      "Running both stacks during the overlap means paying for both.",
      ...(hasDb
        ? [
            "Writes taken by the new database after cutover cannot be un-taken by a DNS revert. This is the single most important date in the plan.",
          ]
        : []),
    ],
  };
}

function verificationSection(inv: ResourceInventoryItem[]): DraftSection {
  const steps: DraftStep[] = [];

  const web = inv.filter(
    (i) => /dyno|service|project|app/i.test(i.type) && !/addon|domain/i.test(i.type)
  );
  const workers = inv.filter((i) =>
    /worker|queue|consumer/i.test(`${i.name} ${i.externalId}`)
  );
  const crons = inv.filter((i) =>
    /cron|clock|schedul/i.test(`${i.name} ${i.externalId} ${i.type}`)
  );

  if (web.length > 0) {
    steps.push({
      title: `Health and smoke checks on ${web.length} web process(es)`,
      detail:
        "Each responds on a health endpoint, and a scripted pass over the routes that matter is compared against the old stack before the flip.",
      owner: "infralift",
      automatable: true,
      evidence: web
        .slice(0, 3)
        .map((i) => i.name)
        .join(", "),
    });
  }
  if (workers.length > 0) {
    steps.push({
      title: `Confirm ${workers.length} background worker(s) are consuming`,
      detail:
        "A worker that starts cleanly and consumes nothing looks healthy. The check is that the queue depth moves, not that the process is up.",
      owner: "infralift",
      evidence: workers.map((i) => i.name).join(", "),
    });
  }
  if (crons.length > 0) {
    steps.push({
      title: `Observe ${crons.length} scheduled job(s) actually firing`,
      detail:
        "Scheduled work is the most common thing to silently not survive a migration, because nothing fails — it just never runs. Each one is watched through at least one real firing.",
      owner: "infralift",
      evidence: crons.map((i) => i.name).join(", "),
    });
  }

  steps.push({
    title: "You confirm the application behaves correctly",
    detail:
      "We can prove the infrastructure serves and the processes run. Whether your application is correct is something only you can judge, and sign-off is yours.",
    owner: "customer",
  });

  return {
    area: "verification",
    title: "Verification",
    summary: `${web.length} web process(es), ${workers.length} worker(s), ${crons.length} scheduled job(s) to verify.`,
    steps,
    downtime: null,
    risks: [
      "Third-party services that call you by URL — webhooks, callbacks, allowlisted addresses — will still be pointing at the old platform. They are outside the inventory and have to be enumerated by you.",
    ],
  };
}

// --- entry point -----------------------------------------------------------

export function buildMigrationPlan(input: PlanInput): MigrationPlan {
  const { inventory, target } = input;
  const hasDb = inventory.some((i) =>
    /postgres/i.test(`${i.type} ${str(meta(i).plan) ?? ""} ${i.name}`)
  );

  return {
    target,
    pointOfNoReturn: hasDb
      ? "The first write accepted by the new database. Before that, rollback is a DNS revert; after it, rollback means reconciling writes across two databases."
      : "The old stack being decommissioned. Until then rollback is a DNS revert.",
    sections: [
      dataSection(inventory),
      dnsSection(inventory),
      secretsSection(inventory),
      cicdSection(inventory),
      rollbackSection(inventory),
      verificationSection(inventory),
    ].map(finalise),
    notCovered: [
      "Application code changes. Framework behaviour that depended on the old platform — incremental static regeneration, edge middleware, image optimisation, platform-specific request headers — may need rewriting, and an inventory cannot tell which.",
      "Preview and per-branch environments, if your team depends on them.",
      "Third-party integrations that address you by URL or IP.",
      "Anything running outside the assessed account.",
      "How long the engagement takes. This plan scopes the work; it does not estimate the labour, and any number in it is a downtime window rather than an effort figure.",
    ],
  };
}
