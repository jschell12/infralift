import { Router } from "express";
import { prisma } from "../lib/db.js";

export const workspacesRouter = Router();

workspacesRouter.get("/", async (req, res) => {
  const orgId = String(req.query.orgId ?? "");
  if (!orgId) return res.status(400).json({ error: "orgId required" });
  const workspaces = await prisma.workspace.findMany({
    where: { orgId },
    orderBy: { name: "asc" },
  });
  res.json(
    workspaces.map((w) => ({
      id: w.id,
      name: w.name,
      tfcWorkspaceUrl: w.tfcWorkspaceUrl,
      driftDetected: w.driftDetected,
      lastRunStatus: w.lastRunStatus,
      lastRunAt: w.lastRunAt?.toISOString() ?? null,
    }))
  );
});
