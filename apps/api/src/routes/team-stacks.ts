import { Router } from "express";
import { z } from "zod";
import { handle, parseBody } from "../lib/errors.js";
import {
  addStackVersion,
  approveStack,
  getTeamStack,
  listPendingStacks,
  listVisibleStacks,
  registerStack,
  requestPublish,
  revokeStack,
  withdrawStack,
} from "../services/team-stacks.js";

// HTTP for team stacks (services/team-stacks.ts, ADR 0009). Every customer
// route is scoped to req.user.orgId by the service; the admin routes are
// mounted behind requireAdmin in app.ts.

export const teamStacksRouter = Router();
export const adminStacksRouter = Router();

const ref = z.string().min(1).max(255);
const registerSchema = z.object({
  connectionId: z.string().min(1),
  repo: z.string().min(3).max(255),
  ref,
  path: z.string().max(512).default(""),
});

teamStacksRouter.get(
  "/",
  handle(async (req, res) => {
    res.json(await listVisibleStacks(req.user!.orgId));
  })
);

teamStacksRouter.post(
  "/",
  handle(async (req, res) => {
    res.status(201).json(await registerStack(req.user!.orgId, parseBody(registerSchema, req.body)));
  })
);

teamStacksRouter.get(
  "/:id",
  handle(async (req, res) => {
    res.json(await getTeamStack(req.user!.orgId, req.params.id));
  })
);

teamStacksRouter.post(
  "/:id/versions",
  handle(async (req, res) => {
    res.status(201).json(await addStackVersion(req.user!.orgId, req.params.id, parseBody(z.object({ ref }), req.body)));
  })
);

teamStacksRouter.post(
  "/:id/publish",
  handle(async (req, res) => {
    const body = parseBody(z.object({ versionId: z.string().min(1).optional() }), req.body ?? {});
    res.json(await requestPublish(req.user!.orgId, req.params.id, body));
  })
);

teamStacksRouter.post(
  "/:id/withdraw",
  handle(async (req, res) => {
    res.json(await withdrawStack(req.user!.orgId, req.params.id));
  })
);

adminStacksRouter.get(
  "/pending",
  handle(async (_req, res) => {
    res.json(await listPendingStacks());
  })
);

// The admin names the version they reviewed; a different one under review
// answers 409.
const reviewSchema = z.object({ versionId: z.string().min(1) });

adminStacksRouter.post(
  "/:id/approve",
  handle(async (req, res) => {
    const { versionId } = parseBody(reviewSchema, req.body);
    res.json(await approveStack(req.params.id, versionId, req.user!.email));
  })
);

adminStacksRouter.post(
  "/:id/revoke",
  handle(async (req, res) => {
    const { versionId } = parseBody(reviewSchema, req.body);
    res.json(await revokeStack(req.params.id, versionId, req.user!.email));
  })
);
