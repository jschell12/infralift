import { Router } from "express";
import { z } from "zod";
import { PROVIDERS } from "@infralift/shared";
import { prisma } from "../lib/db.js";

export const migrationsRouter = Router();

const DEFAULT_PHASES = [
  { key: "assessment", title: "Assessment & migration report" },
  { key: "repo_setup", title: "Terraform repo + TF Cloud workspaces" },
  { key: "parallel_build", title: "Build target environment in parallel" },
  { key: "data_migration", title: "Data & DNS migration" },
  { key: "cutover", title: "Cutover & verification" },
  { key: "handoff", title: "Handoff — repo ownership + platform onboarding" },
];

const createSchema = z.object({
  sourceProvider: z.enum(PROVIDERS),
  targetPlatform: z.enum(["cloudflare", "vps"]),
  fixedFeeCents: z.number().int().positive().optional(),
});

function toSummary(m: {
  id: string;
  status: string;
  sourceProvider: string;
  targetPlatform: string;
  fixedFeeCents: number | null;
  repoUrl: string | null;
  tfcOrg: string | null;
  createdAt: Date;
  updatedAt: Date;
  phases: {
    key: string;
    title: string;
    status: string;
    completedAt: Date | null;
    notes: string | null;
    order: number;
  }[];
}) {
  return {
    id: m.id,
    status: m.status,
    sourceProvider: m.sourceProvider,
    targetPlatform: m.targetPlatform,
    fixedFeeCents: m.fixedFeeCents,
    repoUrl: m.repoUrl,
    tfcOrg: m.tfcOrg,
    createdAt: m.createdAt.toISOString(),
    updatedAt: m.updatedAt.toISOString(),
    phases: m.phases
      .sort((a, b) => a.order - b.order)
      .map((p) => ({
        key: p.key,
        title: p.title,
        status: p.status,
        completedAt: p.completedAt?.toISOString() ?? null,
        notes: p.notes ?? undefined,
      })),
  };
}

migrationsRouter.get("/", async (req, res) => {
  const { orgId } = req.user!;
  const migrations = await prisma.migration.findMany({
    where: { orgId },
    include: { phases: true },
    orderBy: { createdAt: "desc" },
  });
  res.json(migrations.map(toSummary));
});

migrationsRouter.post("/", async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request", detail: parsed.error.message });
  }
  const { orgId } = req.user!;
  const migration = await prisma.migration.create({
    data: {
      ...parsed.data,
      orgId,
      phases: {
        create: DEFAULT_PHASES.map((p, i) => ({ ...p, order: i })),
      },
    },
    include: { phases: true },
  });
  res.status(201).json(toSummary(migration));
});

migrationsRouter.get("/:id", async (req, res) => {
  const migration = await prisma.migration.findUnique({
    where: { id: req.params.id },
    include: { phases: true },
  });
  if (!migration) return res.status(404).json({ error: "Not found" });
  res.json(toSummary(migration));
});
