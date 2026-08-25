import { Router } from "express";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { prisma } from "../lib/db.js";

// Magic-link auth stub: issues a login token and (for now) returns the link
// in the response instead of emailing it. Email delivery is a follow-up.

export const authRouter = Router();

const requestSchema = z.object({
  email: z.string().email(),
  orgName: z.string().min(1).max(120).optional(),
});

authRouter.post("/request-link", async (req, res) => {
  const parsed = requestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request", detail: parsed.error.message });
  }
  const { email, orgName } = parsed.data;

  let user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    const org = await prisma.org.create({
      data: { name: orgName ?? email.split("@")[1] ?? "New org" },
    });
    user = await prisma.user.create({ data: { email, orgId: org.id } });
  }

  const token = randomBytes(32).toString("hex");
  await prisma.loginToken.create({
    data: {
      userId: user.id,
      token,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    },
  });

  // TODO: send via email. Returned directly while in development.
  res.json({ ok: true, loginUrl: `/auth/verify?token=${token}` });
});

authRouter.get("/verify", async (req, res) => {
  const token = String(req.query.token ?? "");
  if (!token) return res.status(400).json({ error: "Missing token" });

  const login = await prisma.loginToken.findUnique({
    where: { token },
    include: { user: true },
  });
  if (!login || login.usedAt || login.expiresAt < new Date()) {
    return res.status(401).json({ error: "Invalid or expired link" });
  }

  await prisma.loginToken.update({
    where: { id: login.id },
    data: { usedAt: new Date() },
  });

  // Session stub: return an opaque session payload the dashboard stores.
  // Replace with signed cookies/JWT before production.
  res.json({
    ok: true,
    session: {
      userId: login.user.id,
      orgId: login.user.orgId,
      email: login.user.email,
    },
  });
});
