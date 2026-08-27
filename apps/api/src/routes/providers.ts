import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/db.js";
import { recommend, type RecommendInput } from "../lib/recommend.js";

export const providersRouter = Router();

// Full hosting catalog: providers + capabilities + plans.
providersRouter.get("/", async (_req, res) => {
  const providers = await prisma.hostingProvider.findMany({
    include: {
      capabilities: { select: { key: true, score: true } },
      plans: { select: { name: true, monthlyCents: true, unit: true, includedNotes: true } },
      discountPrograms: {
        include: {
          tiers: {
            select: { minAnnualCommitUsd: true, discountBps: true },
            orderBy: { minAnnualCommitUsd: "asc" },
          },
        },
      },
    },
    orderBy: { name: "asc" },
  });
  res.json(providers);
});

const profileSchema = z.object({
  runtime: z.enum(["static", "ssr", "node_server", "container", "serverless_fn"]),
  requiredCapabilities: z.array(z.string()).default([]),
  preferredCapabilities: z.array(z.string()).default([]),
  budgetMonthlyCents: z.number().int().nonnegative().default(5000),
  opsTolerance: z.number().int().min(0).max(3).default(1),
  trafficGbMonth: z.number().int().nonnegative().default(10),
  annualSpendCents: z.number().int().positive().optional(),
  startupCreditsEligible: z.boolean().default(false),
});

// Ad-hoc recommendation: describe the app, get ranked providers.
providersRouter.post("/recommendations", async (req, res) => {
  const parsed = profileSchema.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: "Invalid request", detail: parsed.error.message });
  }
  res.json(await recommend(parsed.data as RecommendInput));
});

const saveProfileSchema = profileSchema.extend({
  name: z.string().min(1).max(120),
});

// Save an app profile for an org.
providersRouter.post("/app-profiles", async (req, res) => {
  const parsed = saveProfileSchema.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: "Invalid request", detail: parsed.error.message });
  }
  const { orgId } = req.user!;
  const profile = await prisma.appProfile.create({ data: { ...parsed.data, orgId } });
  res.status(201).json(profile);
});

providersRouter.get("/app-profiles", async (req, res) => {
  const { orgId } = req.user!;
  res.json(
    await prisma.appProfile.findMany({
      where: { orgId },
      orderBy: { createdAt: "desc" },
    })
  );
});

// Recommendations for a saved profile.
providersRouter.get("/app-profiles/:id/recommendations", async (req, res) => {
  const profile = await prisma.appProfile.findUnique({
    where: { id: req.params.id },
  });
  if (!profile) return res.status(404).json({ error: "Not found" });
  res.json(
    await recommend({
      runtime: profile.runtime as RecommendInput["runtime"],
      requiredCapabilities: profile.requiredCapabilities,
      preferredCapabilities: profile.preferredCapabilities,
      budgetMonthlyCents: profile.budgetMonthlyCents,
      opsTolerance: profile.opsTolerance,
      trafficGbMonth: profile.trafficGbMonth,
      annualSpendCents: profile.annualSpendCents ?? undefined,
      startupCreditsEligible: profile.startupCreditsEligible,
    })
  );
});
