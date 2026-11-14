import type { RequestHandler } from "express";

// ---------------------------------------------------------------------------
// Request bodies are JSON, and at most JSON_BODY_LIMIT.
//
// Every route that takes a body reads JSON (express.json in app.ts). A body
// sent as anything else used to be skipped by the parser and reach the route
// as {}, which then failed validation with a list of missing fields that said
// nothing about the real mistake. requireJsonBody answers 415 instead, before
// any parsing, for any POST, PUT, PATCH or DELETE that carries a body.
// A request with no body (POST /connections/:id/verify, check-stale) passes
// whatever its Content-Type.
//
// The size limit is the parser's: a larger body is a 413 (lib/async-errors.ts
// keeps the parser's status). 1 MB holds the largest body any route takes, a
// snapshot bundle from packages/collectors, with room to spare.
// ---------------------------------------------------------------------------

export const JSON_BODY_LIMIT = "1mb";

const METHODS_WITH_BODIES = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** True when the request says it carries a body. */
function hasBody(headers: Record<string, string | string[] | undefined>): boolean {
  if (headers["transfer-encoding"] !== undefined) return true;
  const length = Number(headers["content-length"] ?? 0);
  return Number.isFinite(length) && length > 0;
}

export const requireJsonBody: RequestHandler = (req, res, next) => {
  if (!METHODS_WITH_BODIES.has(req.method) || !hasBody(req.headers)) return next();
  if (req.is("application/json")) return next();
  res.status(415).json({ error: "Send the request body as JSON, with Content-Type: application/json." });
};
