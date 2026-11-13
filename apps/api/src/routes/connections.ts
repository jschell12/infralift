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
import { checkStaleForOrg } from "../services/connection-checks.js";
import { isSafePath } from "../lib/import/check.js";
import { intQuery } from "../lib/query.js";
import {
  ADOPT_MAX_RESOURCES,
  UNMANAGED_PAGE_MAX,
  UNMANAGED_PAGE_SIZE,
  adoptSelected,
  listUnmanaged,
} from "../services/unmanaged.js";

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

// Adopting from an account (services/unmanaged.ts). Field rules match
// POST /tf/imports/from-assessment, the other way into the same pipeline.
const adoptSchema = z.object({
  resources: z
    .array(z.object({ type: z.string().min(1).max(200), providerId: z.string().min(1).max(2048) }))
    .min(1)
    .max(ADOPT_MAX_RESOURCES),
  target: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("new"),
      name: z
        .string()
        .regex(/^[a-z][a-z0-9-]{2,31}$/, "3-32 characters: lowercase letters, digits and dashes, starting with a letter"),
      repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, "a GitHub repository is owner/name"),
      ref: z.string().min(1).optional(),
      gitConnectionId: z.string().min(1).optional(),
      path: z.string().max(200).refine(isSafePath, "letters, digits, dot, dash, underscore and slash"),
      backend: z.object({
        kind: z.enum(["s3", "r2"]),
        bucket: z.string(),
        key: z.string(),
        region: z.string().optional(),
        accountId: z.string().optional(),
      }),
    }),
    z.object({ kind: z.literal("existing"), projectId: z.string().min(1) }),
  ]),
  refresh: z.boolean().optional(),
});

// List connections for the authenticated user's org.
connectionsRouter.get("/", handle(async (req, res) => {
  const { orgId } = req.user!;
  // Only the columns the summary shows, so the encrypted token is never read
  // for a list. Newest 200: a ceiling, not a page size.
  const connections = await prisma.providerConnection.findMany({
    where: { orgId },
    orderBy: { createdAt: "desc" },
    take: 200,
    select: {
      id: true,
      provider: true,
      label: true,
      status: true,
      createdAt: true,
      lastVerifiedAt: true,
      lastCheckedAt: true,
      verifyingSince: true,
      lastError: true,
      expiresAt: true,
    },
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

// Check again, in the background, every connection of the caller's org not
// checked in the last day (services/connection-checks.ts). The dashboard calls
// it when a page shows a stale connection. 202 with the ids it claimed; their
// rows say checking: true until the check is recorded. 429 past the org's
// limit, which the dashboard ignores: the daily sweep still runs.
connectionsRouter.post("/check-stale", handle(async (req, res) => {
  res.status(202).json({ checking: await checkStaleForOrg(req.user!.orgId) });
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

// What is in this connection's account that no project manages, one page at a
// time, newest inventory read at most INVENTORY_TTL_MS ago unless ?refresh=1.
// The next page's cursor is in X-Next-Cursor, absent on the last page.
connectionsRouter.get("/:id/unmanaged", handle(async (req, res) => {
  const limit = intQuery(req.query.limit, { name: "limit", fallback: UNMANAGED_PAGE_SIZE, min: 1, max: UNMANAGED_PAGE_MAX });
  const cursor = typeof req.query.cursor === "string" && req.query.cursor ? req.query.cursor : undefined;
  const refresh = req.query.refresh === "1" || req.query.refresh === "true";
  const { nextCursor, ...page } = await listUnmanaged(req.user!.orgId, String(req.params.id), { limit, cursor, refresh });
  if (nextCursor) res.setHeader("X-Next-Cursor", nextCursor);
  res.json(page);
}));

// Adopt the picked resources into a new project: an import-block pull request
// that applies by saved plan on merge (ADR 0008). 202 when accepted; 200 with
// replayed: true when this exact request was already accepted.
connectionsRouter.post("/:id/adopt", handle(async (req, res) => {
  const input = parseBody(adoptSchema, req.body);
  const result = await adoptSelected(req.user!.orgId, String(req.params.id), input);
  res.status(result.replayed ? 200 : 202).json(result);
}));
