// Seed (or remove) the Northwind demo assessments for an org.
//
//   node dist/scripts/seed-demo.js --email jschell12@gmail.com
//   node dist/scripts/seed-demo.js --org <orgId> --provider heroku
//   node dist/scripts/seed-demo.js --email jschell12@gmail.com --remove
//
// Re-runnable: each run replaces the previous demo assessment for the org.
// Demo data is identified by the connection label below — nothing else in the
// schema is touched, and --remove deletes exactly what this script created.

import { prisma } from "../lib/db.js";
import { encryptToken } from "../lib/crypto.js";
import {
  buildDemoDigitaloceanAssessment,
  buildDemoFirebaseAssessment,
  buildDemoHerokuAssessment,
  buildDemoRailwayAssessment,
  buildDemoRenderAssessment,
  buildDemoVercelAssessment,
  type DemoAssessment,
} from "../lib/demo-fixture.js";

export const DEMO_LABEL = "demo large-tier";

const BUILDERS: Record<string, () => DemoAssessment> = {
  heroku: buildDemoHerokuAssessment,
  vercel: buildDemoVercelAssessment,
  render: buildDemoRenderAssessment,
  railway: buildDemoRailwayAssessment,
  digitalocean: buildDemoDigitaloceanAssessment,
  firebase: buildDemoFirebaseAssessment,
};

function parseArgs(argv: string[]) {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      args[key] = next;
      i++;
    } else {
      args[key] = true;
    }
  }
  return args;
}

async function resolveOrgId(args: Record<string, string | boolean>) {
  if (typeof args.org === "string") return args.org;
  if (typeof args.email === "string") {
    const user = await prisma.user.findFirst({
      where: { email: args.email },
      select: { orgId: true },
    });
    if (!user) throw new Error(`no user with email ${args.email}`);
    return user.orgId;
  }
  throw new Error("pass --org <orgId> or --email <userEmail>");
}

async function seedProvider(orgId: string, provider: string) {
  const fixture = BUILDERS[provider]();

  const connection = await prisma.providerConnection.upsert({
    where: {
      orgId_provider_label: { orgId, provider, label: DEMO_LABEL },
    },
    create: {
      orgId,
      provider,
      label: DEMO_LABEL,
      encryptedToken: encryptToken("demo"),
      status: "valid",
      lastVerifiedAt: new Date(),
    },
    update: { status: "valid", lastVerifiedAt: new Date() },
  });

  // Replace, don't accumulate.
  await prisma.assessment.deleteMany({
    where: { connectionId: connection.id },
  });

  const assessment = await prisma.assessment.create({
    data: {
      orgId,
      connectionId: connection.id,
      provider,
      status: "completed",
      startedAt: new Date(),
      completedAt: new Date(),
      resourceCount: fixture.inventory.length,
      estimatedMonthlyCostCents: fixture.estimatedMonthlyCostCents,
      estimatedMonthlySavingsCents: fixture.estimatedMonthlySavingsCents,
    },
  });

  await prisma.$transaction([
    prisma.inventoryItem.createMany({
      data: fixture.inventory.map((item) => ({
        assessmentId: assessment.id,
        provider: item.provider,
        type: item.type,
        externalId: item.externalId,
        name: item.name,
        region: item.region ?? null,
        monthlyCostCents: item.monthlyCostCents ?? null,
        metadata: item.metadata as object | undefined,
      })),
    }),
    prisma.finding.createMany({
      data: fixture.findings.map((f) => ({
        assessmentId: assessment.id,
        category: f.category,
        severity: f.severity,
        title: f.title,
        detail: f.detail,
        monthlySavingsCents: f.monthlySavingsCents ?? null,
        resourceRef: f.resourceRef ?? null,
      })),
    }),
  ]);

  const cost = fixture.estimatedMonthlyCostCents ?? 0;
  console.log(
    `${provider}: assessment ${assessment.id} — ${fixture.inventory.length} resources, $${(cost / 100).toFixed(0)}/mo`
  );
}

async function removeDemo(orgId: string) {
  const connections = await prisma.providerConnection.findMany({
    where: { orgId, label: DEMO_LABEL },
    select: { id: true, provider: true },
  });
  for (const c of connections) {
    await prisma.assessment.deleteMany({ where: { connectionId: c.id } });
    await prisma.providerConnection.delete({ where: { id: c.id } });
    console.log(`removed demo ${c.provider} connection + assessments`);
  }
  if (connections.length === 0) console.log("no demo data found");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const orgId = await resolveOrgId(args);
  console.log(`org: ${orgId}`);

  if (args.remove === true) {
    await removeDemo(orgId);
    return;
  }

  const which =
    typeof args.provider === "string" ? [args.provider] : Object.keys(BUILDERS);
  for (const provider of which) {
    if (!BUILDERS[provider]) {
      throw new Error(
        `no demo fixture for "${provider}" (have: ${Object.keys(BUILDERS).join(", ")})`
      );
    }
    await seedProvider(orgId, provider);
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
