import { Router } from "express";
import { prisma } from "../lib/db.js";

export const communitiesRouter = Router();

// List all community sources, optionally filtered by platform and/or category.
communitiesRouter.get("/", async (req, res) => {
  const platform = req.query.platform ? String(req.query.platform) : undefined;
  const category = req.query.category ? String(req.query.category) : undefined;

  const communities = await prisma.communitySource.findMany({
    where: {
      ...(platform && { platform }),
      ...(category && { category }),
      isActive: true,
    },
    orderBy: [{ platform: "asc" }, { name: "asc" }],
  });
  res.json(communities);
});

// Get a single community source by slug.
communitiesRouter.get("/:slug", async (req, res) => {
  const community = await prisma.communitySource.findUnique({
    where: { slug: req.params.slug },
  });
  if (!community) return res.status(404).json({ error: "Not found" });
  res.json(community);
});
