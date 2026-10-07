import { Router } from "express";
import { z } from "zod";
import { PROVIDERS, type Provider } from "@infralift/shared";
import { prisma } from "../lib/db.js";
import { encryptToken, decryptToken } from "../lib/crypto.js";
import { getConnector } from "../connectors/index.js";

export const connectionsRouter = Router();

const createSchema = z.object({
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

// List connections for the authenticated user's org.
connectionsRouter.get("/", async (req, res) => {
  const { orgId } = req.user!;
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
  const { provider, label, token } = parsed.data;
  const { orgId } = req.user!;

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
  if (!connection || connection.orgId !== req.user!.orgId) {
    return res.status(404).json({ error: "Not found" });
  }
  // A Terraform Cloud connection ("tfc") stores JSON credentials and has no
  // connector; without this it would be marked invalid by a TypeError.
  if (!(PROVIDERS as readonly string[]).includes(connection.provider)) {
    return res.status(400).json({ error: `${connection.provider} connections are verified where they were created` });
  }

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
  const connection = await prisma.providerConnection.findUnique({
    where: { id: req.params.id },
  });
  if (!connection || connection.orgId !== req.user!.orgId) {
    return res.status(404).json({ error: "Not found" });
  }
  await prisma.providerConnection.delete({ where: { id: connection.id } });
  res.status(204).end();
});
