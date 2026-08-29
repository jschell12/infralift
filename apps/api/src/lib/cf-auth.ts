// Cloudflare Access JWT verification and user provisioning.
//
// When a request passes through Cloudflare Access, the gateway adds:
//   Cf-Access-Jwt-Assertion: <signed JWT>
//
// The JWT contains: email, sub (unique user ID), iss (team domain),
// iat, exp, and identity provider details.
//
// In development (no CF Access), the middleware falls through if
// CF_ACCESS_TEAM_DOMAIN is not set, using a dev-mode fallback.

import type { Request, Response, NextFunction } from "express";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { prisma } from "./db.js";

const CF_TEAM_DOMAIN = process.env.CF_ACCESS_TEAM_DOMAIN; // e.g. "jschell12.cloudflareaccess.com"
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

// Admin emails that can access the admin app and internal routes.
const ADMIN_EMAILS = new Set(
  (process.env.ADMIN_EMAILS ?? "jschell12@gmail.com")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
);

/**
 * Middleware: verify CF Access JWT and provision user/org if needed.
 * In dev mode (no CF_ACCESS_TEAM_DOMAIN), creates/uses a dev user.
 */
export async function cfAuth(req: Request, res: Response, next: NextFunction) {
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

/**
 * Middleware: require the authenticated user to be an admin.
 * Must be used after cfAuth.
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.user || !ADMIN_EMAILS.has(req.user.email.toLowerCase())) {
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

/**
 * Find or create a user (and their org) by email.
 * Called on every authenticated request; uses Prisma's upsert for atomicity.
 */
async function getOrCreateUser(
  email: string,
  name: string | null
): Promise<AuthUser> {
  let user = await prisma.user.findUnique({
    where: { email },
  });

  if (!user) {
    const orgName = email.split("@")[0] ?? "My org";
    const org = await prisma.org.create({
      data: { name: `${orgName}'s workspace` },
    });
    user = await prisma.user.create({
      data: { email, name, orgId: org.id },
    });
    console.log(`Provisioned new user: ${email} (org: ${org.id})`);
  } else if (name && !user.name) {
    user = await prisma.user.update({
      where: { id: user.id },
      data: { name },
    });
  }

  return {
    userId: user.id,
    orgId: user.orgId,
    email: user.email,
    name: user.name,
  };
}
