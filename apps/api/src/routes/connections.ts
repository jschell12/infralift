import { Router } from "express";
import { z } from "zod";
import { PROVIDERS } from "@infralift/shared";
import { prisma } from "../lib/db.js";
import { InvalidInput, handle, parseBody } from "../lib/errors.js";
import {
  createConnection,
  deleteConnection,
  rotateConnection,
  toSummary,
  verifyConnection,
} from "../services/connections.js";
import { awsSetup } from "../services/aws-access.js";

export const connectionsRouter = Router();

const createSchema = z.object({
  provider: z.enum(PROVIDERS),
  label: z.string().min(1).max(120),
  token: z.string().min(1),
});

// Replacing a credential: the same field(s) as adding one. organization and
// hostname apply to Terraform Cloud connections only.
const rotateSchema = z.object({
  token: z.string().min(1),
  organization: z.string().optional(),
  hostname: z.string().optional(),
});

// List connections for the authenticated user's org.
connectionsRouter.get("/", handle(async (req, res) => {
  const { orgId } = req.user!;
  const connections = await prisma.providerConnection.findMany({
    where: { orgId },
    orderBy: { createdAt: "desc" },
  });
  res.json(connections.map(toSummary));
}));

// The caller's org's AWS external ID and the IAM policies to paste, or
// {enabled: false} when this server has no AWS principal configured.
connectionsRouter.get("/aws-setup", handle(async (req, res) => {
  res.json(await awsSetup(req.user!.orgId));
}));

// Register a read-only token. Verified immediately against the provider.
connectionsRouter.post("/", handle(async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new InvalidInput("Invalid request", { detail: parsed.error.message });
  }
  res.status(201).json(await createConnection(req.user!.orgId, parsed.data));
}));

// Re-verify an existing connection, Terraform Cloud included.
connectionsRouter.post("/:id/verify", handle(async (req, res) => {
  res.json(await verifyConnection(req.user!.orgId, String(req.params.id)));
}));

// Replace the credential. Verified first; a failure keeps the old one (400
// with the provider's reason). The credential is never sent back.
connectionsRouter.patch("/:id", handle(async (req, res) => {
  const input = parseBody(rotateSchema, req.body);
  res.json(await rotateConnection(req.user!.orgId, String(req.params.id), input));
}));

// Delete a connection (and its stored token). 409 while something uses it.
connectionsRouter.delete("/:id", handle(async (req, res) => {
  await deleteConnection(req.user!.orgId, String(req.params.id));
  res.status(204).end();
}));
