// Cloudflare Access JWT verification and user provisioning.
//
// When a request passes through Cloudflare Access, the gateway adds:
//   Cf-Access-Jwt-Assertion: <signed JWT>
//
// The JWT contains: email, sub (unique user ID), iss (team domain),
// iat, exp, and identity provider details.
//
// In development (no CF Access), the middleware falls through if
// CF_ACCESS_TEAM_DOMAIN is not set, using a dev-mode fallback. In production
// (NODE_ENV=production) a missing team domain or audience refuses every
// request instead: the fallback signs everyone in, and an unchecked audience
// accepts a token issued for any Access application on the team.

import type { Request, Response, NextFunction } from "express";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { prisma } from "./db.js";
import { isUniqueViolation } from "./prisma-errors.js";

const CF_TEAM_DOMAIN = process.env.CF_ACCESS_TEAM_DOMAIN; // e.g. "<team>.cloudflareaccess.com"
const CF_AUD = process.env.CF_ACCESS_AUD; // Application Audience (AUD) tag from Access app

// Cache the JWKS fetcher so we don't create a new one per request.
let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function getJwks() {
  if (!jwks && CF_TEAM_DOMAIN) {
    jwks = createRemoteJWKSet(
      new URL(`https://${CF_TEAM_DOMAIN}/cdn-cgi/access/certs`)
    );
  }
  return jwks;
}

export interface AuthUser {
  userId: string;
  orgId: string;
  email: string;
  name: string | null;
}

// Extend Express Request to carry the authenticated user.
declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

// Admin emails that can access the admin app and internal routes, from the
// ADMIN_EMAILS environment variable (comma-separated). Unset means no admins.
const ADMIN_EMAILS = new Set(
  (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
);

/**
 * Middleware: verify CF Access JWT and provision user/org if needed.
 * In dev mode (no CF_ACCESS_TEAM_DOMAIN), creates/uses a dev user.
 */
export async function cfAuth(req: Request, res: Response, next: NextFunction) {
  // Production never falls back: fail closed if Access is not configured.
  if (process.env.NODE_ENV === "production" && (!CF_TEAM_DOMAIN || !CF_AUD)) {
    console.error("cfAuth: CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD must be set in production; refusing requests");
    return res.status(503).json({ error: "authentication is not configured" });
  }
  // Dev mode: no Cloudflare Access configured
  if (!CF_TEAM_DOMAIN) {
    req.user = await getOrCreateUser("dev@infralift.dev", "Dev User");
    return next();
  }

  // JWT can come from the header (direct Cloudflare proxy) or a
  // CF_Authorization cookie (forwarded through a Next.js rewrite proxy).
  // A browser can hold more than one CF_Authorization cookie at once — a
  // host-scoped one from the app covering this subdomain, plus a
  // domain-scoped one from a wildcard app — and only the token issued by
  // the app whose AUD matches CF_ACCESS_AUD will verify. Try them all
  // rather than betting on cookie order.
  const candidates = collectTokens(req);
  if (candidates.length === 0) {
    return res.status(401).json({ error: "Missing Cloudflare Access token" });
  }

  const ks = getJwks();
  if (!ks) {
    return res.status(500).json({ error: "JWKS not configured" });
  }

  let lastError: unknown;
  for (const token of candidates) {
    let payload;
    try {
      ({ payload } = await jwtVerify(token, ks, {
        issuer: `https://${CF_TEAM_DOMAIN}`,
        audience: CF_AUD,
      }));
    } catch (err) {
      lastError = err;
      continue;
    }

    const email = payload.email as string | undefined;
    if (!email) {
      return res.status(401).json({ error: "JWT missing email claim" });
    }

    const name =
      (payload as Record<string, unknown>).name as string | undefined;

    req.user = await getOrCreateUser(email, name ?? null);
    return next();
  }

  // Every candidate failed. The jose error code names the actual cause
  // (ERR_JWT_EXPIRED, ERR_JWT_CLAIM_VALIDATION_FAILED for an issuer/audience
  // mismatch, ERR_JWKS_NO_MATCHING_KEY, ...) — return it so the browser shows
  // something more actionable than a bare "Invalid access token".
  const code = errorCode(lastError);
  console.error(
    `CF Access JWT verification failed (${candidates.length} candidate token(s), aud=${CF_AUD ?? "unset"}):`,
    lastError
  );
  return res
    .status(401)
    .json({ error: "Invalid access token", code, detail: `Invalid access token (${code})` });
}

/** Every token the request carries, header first, then each cookie value. */
function collectTokens(req: Request): string[] {
  const header = req.headers["cf-access-jwt-assertion"];
  const fromHeader = Array.isArray(header) ? header : header ? [header] : [];
  const all = [
    ...fromHeader,
    ...parseCookies(req.headers.cookie, "CF_Authorization"),
  ];
  return [...new Set(all.filter(Boolean))];
}

function errorCode(err: unknown): string {
  if (err && typeof err === "object" && "code" in err) {
    return String((err as { code: unknown }).code);
  }
  return "unknown";
}

/** Whether an email is an admin. Exported as a predicate as well as the
 * middleware below, because some routes vary their response for admins rather
 * than refusing them outright. */
export function isAdmin(email: string | undefined | null): boolean {
  return !!email && ADMIN_EMAILS.has(email.toLowerCase());
}

/**
 * Middleware: require the authenticated user to be an admin.
 * Must be used after cfAuth.
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!isAdmin(req.user?.email)) {
    return res.status(403).json({ error: "Admin access required" });
  }
  next();
}

/** All values for `name` in a Cookie header — there can be more than one. */
export function parseCookies(header: string | undefined, name: string): string[] {
  if (!header) return [];
  const re = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`, "g");
  const values: string[] = [];
  for (const match of header.matchAll(re)) {
    if (match[1]) values.push(match[1]);
  }
  return values;
}

/** How an email is stored and looked up: trimmed and lowercased. Identity
 *  providers do not agree on case, and "Ann@x.com" and "ann@x.com" are one
 *  person who must land in one org. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Find or create a user (and their org) by email. Called on every
 * authenticated request.
 *
 * A first sign-in usually arrives as several requests at once (the dashboard
 * loads its panels in parallel), and each one finds no user. The org and the
 * user are created in one transaction, so a request that loses the race on
 * User.email rolls back its org too, then reads the winner's row. Without
 * that, each racing request left an empty org behind.
 */
export async function getOrCreateUser(rawEmail: string, name: string | null): Promise<AuthUser> {
  const email = normalizeEmail(rawEmail);
  let user = await findUserByEmail(email);
  if (!user) {
    try {
      user = await prisma.$transaction(async (tx) => {
        const org = await tx.org.create({ data: { name: `${email.split("@")[0] || "My org"}'s workspace` } });
        return tx.user.create({ data: { email, name, orgId: org.id } });
      });
      console.log(`Provisioned new user: ${email} (org: ${user.orgId})`);
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      user = await prisma.user.findUniqueOrThrow({ where: { email } });
    }
  } else if (name && !user.name) {
    user = await prisma.user.update({ where: { id: user.id }, data: { name } });
  }
  return { userId: user.id, orgId: user.orgId, email: user.email, name: user.name };
}

/** The user for a normalized email. Users provisioned before emails were
 *  normalized may be stored in mixed case; the case-insensitive fallback finds
 *  them, so their next sign-in does not provision a second org. */
async function findUserByEmail(email: string) {
  const exact = await prisma.user.findUnique({ where: { email } });
  if (exact) return exact;
  return prisma.user.findFirst({
    where: { email: { equals: email, mode: "insensitive" } },
    orderBy: { createdAt: "asc" },
  });
}
