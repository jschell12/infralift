import type { Request, Response } from "express";

// ---------------------------------------------------------------------------
// Errors a request can end in, and how they become responses.
//
// Services throw these; routes do not build error responses themselves.
// `handle()` wraps a route so a thrown AppError becomes its status and body,
// and anything else is left to the app's errorHandler (a 500, logged).
//
//   InvalidInput  400  the request asks for something that cannot be done
//   Unauthorized  401  the credentials presented are not valid
//   NotFound      404  no such thing in the caller's org
//   Conflict      409  it exists already, or its state forbids this
//   Unprocessable 422  values fail a template's schema
//   TooManyRequests 429 a metered action is over its limit
//   Upstream      502  a provider or git host refused or failed
//   InvalidBody   400  the body failed its schema (zod's errors as `error`)
//
// `details` are extra fields for the response body, for a client that acts
// on them (configFiles to choose from, the last known result).
// ---------------------------------------------------------------------------

export class AppError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details: Record<string, unknown> = {}
  ) {
    super(message);
  }

  body(): Record<string, unknown> {
    return { error: this.message, ...this.details };
  }
}

export class InvalidInput extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(400, message, details);
  }
}

export class Unauthorized extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(401, message, details);
  }
}

export class NotFound extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(404, message, details);
  }
}

export class Conflict extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(409, message, details);
  }
}

/** 422: the request is well-formed but its values fail a template's schema.
 *  The body's `error` is the validation details, as the dashboard reads it. */
export class Unprocessable extends AppError {
  constructor(readonly validation: unknown) {
    super(422, "arguments do not match the template");
  }

  override body(): Record<string, unknown> {
    return { error: this.validation };
  }
}

export class TooManyRequests extends AppError {
  constructor(message: string) {
    super(429, message);
  }
}

export class Upstream extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(502, message, details);
  }
}

/** A route body that may throw AppError. */
export function handle(fn: (req: Request, res: Response) => Promise<unknown>) {
  return async (req: Request, res: Response) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
      res.status(err.status).json(err.body());
    }
  };
}

/** A request body that failed its schema: 400 with zod's flattened errors as
 *  `error`, the shape the dashboard already reads. */
export class InvalidBody extends AppError {
  constructor(readonly flattened: unknown) {
    super(400, "invalid request");
  }

  override body(): Record<string, unknown> {
    return { error: this.flattened };
  }
}

/** Parses a body with a zod schema or throws InvalidBody. */
export function parseBody<T>(schema: { safeParse(v: unknown): { success: true; data: T } | { success: false; error: { flatten(): unknown } } }, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new InvalidBody(parsed.error.flatten());
  return parsed.data;
}
