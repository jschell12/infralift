import { Router } from "express";
import { z } from "zod";
import { PROVIDERS, type Provider } from "@infralift/shared";
import { prisma } from "../lib/db.js";
import { encryptToken, decryptToken } from "../lib/crypto.js";
import { getConnector } from "../connectors/index.js";

export const connectionsRouter = Router();

const createSchema = z.object({
  orgId: z.string().min(1),
  provider: z.enum(PROVIDERS),
  label: z.string().min(1).max(120),
  token: z.string().min(1),
});

function toSummary(c: {
  id: string;
  provider: string;
  label: string;
  createdAt: Date;
  lastVerifiedAt: Date | null;
  status: string;
}) {
  return {
    id: c.id,
    provider: c.provider as Provider,
    label: c.label,
    createdAt: c.createdAt.toISOString(),
    lastVerifiedAt: c.lastVerifiedAt?.toISOString() ?? null,
    status: c.status,
  };
}

// List connections for an org — tokens are never returned.
connectionsRouter.get("/", async (req, res) => {
  const orgId = String(req.query.orgId ?? "");
  if (!orgId) return res.status(400).json({ error: "orgId required" });
  const connections = await prisma.providerConnection.findMany({
    where: { orgId },
    orderBy: { createdAt: "desc" },
  });
  res.json(connections.map(toSummary));
});

// Register a read-only token. Verified immediately against the provider.
connectionsRouter.post("/", async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request", detail: parsed.error.message });
  }
  const { orgId, provider, label, token } = parsed.data;

  const connector = getConnector(provider);
  let valid = false;
  try {
    valid = await connector.verify(token);
  } catch {
    valid = false;
  }

  const connection = await prisma.providerConnection.create({
    data: {
      orgId,
      provider,
      label,
      encryptedToken: encryptToken(token),
      status: valid ? "valid" : "invalid",
      lastVerifiedAt: valid ? new Date() : null,
    },
  });

  res.status(201).json(toSummary(connection));
});

// Re-verify an existing connection.
connectionsRouter.post("/:id/verify", async (req, res) => {
  const connection = await prisma.providerConnection.findUnique({
    where: { id: req.params.id },
  });
  if (!connection) return res.status(404).json({ error: "Not found" });

  const connector = getConnector(connection.provider as Provider);
  let valid = false;
  try {
    valid = await connector.verify(decryptToken(connection.encryptedToken));
  } catch {
    valid = false;
  }

  const updated = await prisma.providerConnection.update({
    where: { id: connection.id },
    data: {
      status: valid ? "valid" : "invalid",
      lastVerifiedAt: valid ? new Date() : connection.lastVerifiedAt,
    },
  });
  res.json(toSummary(updated));
});

// Delete a connection (and its stored token).
connectionsRouter.delete("/:id", async (req, res) => {
  await prisma.providerConnection.delete({ where: { id: req.params.id } });
  res.status(204).end();
});
