import type { ErrorRequestHandler, NextFunction, Request, Response } from "express";

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
  handle: Handle & { stack?: Layer[] };
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
      (result as Promise<unknown>).then(undefined, next);
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

/**
 * Last error handler: log, and answer 500 without the error's detail, which
 * can carry upstream bodies or query text. Never logs the request body.
 */
export const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  console.error(`unhandled error on ${req.method} ${req.path}:`, err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: "internal error" });
};
