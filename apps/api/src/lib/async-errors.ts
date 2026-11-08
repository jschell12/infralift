import { STATUS_CODES } from "node:http";
import type { ErrorRequestHandler, NextFunction, Request, Response } from "express";
import { AppError } from "./errors.js";

// ---------------------------------------------------------------------------
// Express 4 does not catch a rejected async handler. The rejection becomes an
// unhandledRejection, which Node turns into a process exit: one request with a
// bad id, a database blip inside cfAuth, or an unexpected upstream response
// takes the API down for every tenant. Measured 2026-10-08, when a `null`
// body from HCP Terraform did exactly that (PR #91 fixed that one route).
//
// Rather than wrap ~45 handlers by hand, and miss the next one written,
// catchAsyncErrors walks the mounted router tree once, after every route is
// registered, and wraps each handler so a rejection is passed to next(err).
// Express 5 does this natively; this is the Express 4 equivalent.
// ---------------------------------------------------------------------------

type Handle = (req: Request, res: Response, next: NextFunction) => unknown;

interface Layer {
  handle: Handle & { stack?: Layer[]; _router?: { stack: Layer[] } };
  route?: { stack: Layer[] };
}

const WRAPPED = Symbol("infralift.asyncWrapped");

function wrap(fn: Handle): Handle {
  if ((fn as unknown as Record<symbol, boolean>)[WRAPPED]) return fn;
  const wrapped: Handle = function (this: unknown, req, res, next) {
    let result: unknown;
    try {
      result = fn.call(this, req, res, next);
    } catch (err) {
      return next(err);
    }
    if (result && typeof (result as Promise<unknown>).then === "function") {
      // next(undefined) means "carry on", so an empty rejection would run the
      // next handler as if nothing failed. Same rule as Express 5. A handler
      // that calls next() and then rejects reaches next twice; once headers
      // are sent, errorHandler defers to Express, which closes the socket.
      (result as Promise<unknown>).then(undefined, (err: unknown) =>
        next(err ?? new Error("Rejected promise"))
      );
    }
    return result;
  };
  (wrapped as unknown as Record<symbol, boolean>)[WRAPPED] = true;
  return wrapped;
}

function walk(stack: Layer[]): number {
  let count = 0;
  for (const layer of stack) {
    if (layer.route) {
      count += walk(layer.route.stack);
      continue;
    }
    // A mounted Router: recurse into it rather than wrapping the router fn.
    if (Array.isArray(layer.handle.stack)) {
      count += walk(layer.handle.stack);
      continue;
    }
    // A mounted express() sub-app keeps its stack on _router.
    if (layer.handle._router && Array.isArray(layer.handle._router.stack)) {
      count += walk(layer.handle._router.stack);
      continue;
    }
    // Four-argument functions are error handlers; Express tells them apart by
    // arity, and the wrapper has three.
    if (layer.handle.length >= 4) continue;
    layer.handle = wrap(layer.handle) as Layer["handle"];
    count++;
  }
  return count;
}

/**
 * Wrap every handler and middleware already registered on `app` (and on
 * every router mounted under it). Call after all routes are registered and
 * before the error handler. Returns how many handlers were wrapped.
 */
export function catchAsyncErrors(app: { _router?: { stack: Layer[] } }): number {
  if (!app._router) return 0;
  return walk(app._router.stack);
}

/** The 4xx status an error carries, as Express's own parsers set it, or null. */
function clientStatus(err: unknown): number | null {
  const e = err as { status?: unknown; statusCode?: unknown } | null;
  const status = Number(e?.status ?? e?.statusCode);
  return Number.isInteger(status) && status >= 400 && status < 500 ? status : null;
}

/**
 * Last error handler.
 *
 * A 4xx error (malformed JSON, a body over the limit) keeps its status, as it
 * did under Express's default handler, and is not logged: it is the caller's
 * mistake, and the public /intake routes would otherwise fill the log with it.
 *
 * Anything else answers a bare 500 and logs the stack only. Not the error
 * object: body-parser attaches the raw request text to its errors as
 * `err.body`, and request bodies here carry provider tokens.
 */
export const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  if (res.headersSent) return next(err);
  // A typed request error (lib/errors.ts) answers with its own status and
  // body wherever it was thrown, wrapped in handle() or not.
  if (err instanceof AppError) return res.status(err.status).json(err.body());
  const status = clientStatus(err);
  if (status) {
    return res.status(status).json({ error: STATUS_CODES[status] ?? "bad request" });
  }
  const detail = err instanceof Error ? (err.stack ?? `${err.name}: ${err.message}`) : typeof err;
  console.error(`unhandled error on ${req.method} ${req.path}: ${detail}`);
  res.status(500).json({ error: "internal error" });
};
