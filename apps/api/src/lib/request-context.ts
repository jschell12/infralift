import { randomUUID } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { log, runWithRequestContext, type RequestContext as RequestContextFields } from "./log.js";

// ---------------------------------------------------------------------------
// Request id and the access log.
//
// Every request gets an id, sent back as X-Request-Id and stamped on every log
// line written while serving it (lib/log.ts). A customer who quotes the id
// from an error lets us find the matching log lines; a 5xx body carries it as
// `requestId` (lib/async-errors.ts).
//
// An incoming X-Request-Id is used only when TRUST_PROXY_REQUEST_ID=1 says the
// API is reached solely through a proxy that sets or overwrites that header,
// and only when it looks like an id (REQUEST_ID_SHAPE). Otherwise any client
// could choose the id its lines are filed under, or put text of its choosing
// into the log. Today nothing in front of the API sets it (Cloudflare's tunnel
// passes a client's header through unchanged), so the default is off and the
// API generates every id.
//
// When the response finishes, one access line records method, route (the
// pattern, such as /connections/:id/verify, not the ids), status and latency.
// Health and readiness probes log at debug, since the orchestrator calls them
// every few seconds.
// ---------------------------------------------------------------------------

export const REQUEST_ID_HEADER = "X-Request-Id";

/** Letters, digits, and . _ : - ; 8 to 128 characters. Covers UUIDs and the
 *  ids common proxies generate, and nothing that could carry a log injection. */
export const REQUEST_ID_SHAPE = /^[A-Za-z0-9._:-]{8,128}$/;

declare global {
  namespace Express {
    interface Request {
      /** This request's id, also in the X-Request-Id response header. */
      id?: string;
      /** The log context opened for this request (lib/log.ts). */
      logContext?: RequestContextFields;
    }
  }
}

const PROBE_PATHS = new Set(["/health", "/ready"]);

/** The id to use for this request: the proxy's when trusted and well-formed,
 *  otherwise a new UUID. */
export function chooseRequestId(incoming: unknown, trustProxy: boolean): string {
  if (trustProxy && typeof incoming === "string" && REQUEST_ID_SHAPE.test(incoming)) return incoming;
  return randomUUID();
}

/** The route pattern that served the request, or "(unmatched)" for a 404
 *  nothing handled. Never the raw URL: its query can carry cursors and its
 *  path the ids we would rather search by field. */
function routePattern(req: Request): string {
  const pattern = req.route?.path;
  if (typeof pattern === "string") return `${req.baseUrl}${pattern}`;
  return "(unmatched)";
}

/** First middleware on the app: assigns the id, opens the request context,
 *  and writes the access line when the response finishes. */
export function requestContext(opts: { trustProxyRequestId?: boolean } = {}): RequestHandler {
  const trustProxy = opts.trustProxyRequestId ?? process.env.TRUST_PROXY_REQUEST_ID === "1";
  return (req: Request, res: Response, next: NextFunction) => {
    const requestId = chooseRequestId(req.get(REQUEST_ID_HEADER), trustProxy);
    req.id = requestId;
    res.setHeader(REQUEST_ID_HEADER, requestId);
    const started = process.hrtime.bigint();
    const ctx: RequestContextFields = { requestId };
    req.logContext = ctx;

    res.on("finish", () => {
      const latencyMs = Number(process.hrtime.bigint() - started) / 1e6;
      const fields = {
        requestId,
        ...(ctx.orgId ? { orgId: ctx.orgId } : {}),
        ...(ctx.userId ? { userId: ctx.userId } : {}),
        method: req.method,
        route: routePattern(req),
        status: res.statusCode,
        latencyMs: Math.round(latencyMs * 10) / 10,
      };
      if (PROBE_PATHS.has(req.path)) log.debug(fields, "request");
      else if (res.statusCode >= 500) log.error(fields, "request");
      else log.info(fields, "request");
    });

    runWithRequestContext(ctx, () => next());
  };
}

/** Right after the body parser: enters the request's context again. The body
 *  parser's callbacks run from the socket's stream events, which do not carry
 *  the context opened above, so without this every line written after parsing
 *  would lose its request id. */
export const restoreRequestContext: RequestHandler = (req, _res, next) => {
  if (!req.logContext) return next();
  runWithRequestContext(req.logContext, () => next());
};

/** After cfAuth: adds the caller's org and user to the request context, so
 *  every later log line, and the access line, carries them. */
export const bindUserToRequestContext: RequestHandler = (req, _res, next) => {
  if (req.logContext && req.user) {
    req.logContext.orgId = req.user.orgId;
    req.logContext.userId = req.user.userId;
  }
  next();
};
