import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { pino, type Logger } from "pino";

// ---------------------------------------------------------------------------
// One structured logger for the API process.
//
// Every line is one JSON object on stdout (pino), so the log can be searched
// by field instead of by guessing at a sentence. A line written while a
// request is being served carries that request's id, and once cfAuth has run,
// its org and user ids, without the code that logs having to pass them along:
// they come from the request context (AsyncLocalStorage), filled in by
// lib/request-context.ts.
//
// Secrets never reach the log, in two layers:
//   1. Field names that hold credentials are replaced with "[redacted]"
//      (REDACTED_PATHS), wherever they sit in the logged object.
//   2. The finished line is scrubbed for token shapes (SECRET_PATTERNS), for
//      the case where a credential ends up inside a message string, such as a
//      provider error that quotes a header.
// Errors are logged as name, message, stack and status only, never the whole
// object: body-parser attaches the raw request text to its errors as
// `err.body`, and request bodies here carry provider tokens.
//
// How to log:   log.error({ err, jobId }, "job failed")
// In tests:     const logs = captureLogs(); ... logs.lines; logs.restore()
// Level:        LOG_LEVEL (default info; silent under vitest unless captured)
// ---------------------------------------------------------------------------

/** What a log line knows about the request it was written during. */
export interface RequestContext {
  requestId: string;
  orgId?: string;
  userId?: string;
}

const contextStore = new AsyncLocalStorage<RequestContext>();

/** The context of the request being served, or undefined outside one (the
 *  job worker's timers, boot). */
export function currentRequestContext(): RequestContext | undefined {
  return contextStore.getStore();
}

/** The id of the request being served, or a fresh one outside a request.
 *  For a response that names the log line it ties to (a 502's requestId). */
export function currentRequestId(): string {
  return contextStore.getStore()?.requestId ?? randomUUID();
}

/** Runs `fn` with `ctx` as the request context. The middleware in
 *  lib/request-context.ts calls this once per request. */
export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return contextStore.run(ctx, fn);
}

/** Field paths whose values are credentials. pino matches them exactly, and
 *  `*.` one level down, so both `{ token }` and `{ connection: { token } }`
 *  are covered. Add a name here before logging an object that holds one. */
export const REDACTED_PATHS = [
  "token",
  "encryptedToken",
  "secret",
  "password",
  "apiKey",
  "accessToken",
  "refreshToken",
  "credentials",
  "authorization",
  "cookie",
  "headers.authorization",
  "headers.cookie",
  'headers["cf-access-jwt-assertion"]',
  'headers["x-api-key"]',
  "*.token",
  "*.encryptedToken",
  "*.secret",
  "*.password",
  "*.apiKey",
  "*.accessToken",
  "*.refreshToken",
  "*.credentials",
  "*.authorization",
  "*.cookie",
  "*.headers.authorization",
  "*.headers.cookie",
];

/** Token shapes scrubbed from every finished line. Each is specific enough
 *  not to eat ordinary text (ids, hashes, timestamps). */
export const SECRET_PATTERNS: RegExp[] = [
  /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/g, // Authorization header values
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWTs, Cloudflare Access included
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g, // GitHub fine-grained tokens
  /\bglpat-[A-Za-z0-9_-]{20,}/g, // GitLab personal access tokens
  /\bsk-ant-[A-Za-z0-9_-]{20,}/g, // Anthropic API keys
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, // AWS access key ids
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, // PEM keys (GCP service accounts)
];

/** Replaces every token shape in `text` with "[redacted]". */
export function scrubSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, "[redacted]");
  return out;
}

/** An error as it is logged: never the whole object (see the header). */
export function serializeError(err: unknown): Record<string, unknown> {
  if (!(err instanceof Error)) return { message: typeof err === "string" ? err : String(err) };
  const status = (err as { status?: unknown; statusCode?: unknown }).status ?? (err as { statusCode?: unknown }).statusCode;
  return {
    type: err.name,
    message: err.message,
    stack: err.stack,
    ...(typeof status === "number" ? { status } : {}),
  };
}

// The destination is a forwarder so tests can swap where lines go without
// rebuilding the logger every module already imported.
interface LineSink {
  write(line: string): unknown;
}
let destination: LineSink = process.stdout;
const forwarder: LineSink = { write: (line: string) => destination.write(line) };

function defaultLevel(): string {
  if (process.env.LOG_LEVEL) return process.env.LOG_LEVEL;
  return process.env.VITEST ? "silent" : "info";
}

/** The process's logger. Import it; do not build another. */
export const log: Logger = pino(
  {
    level: defaultLevel(),
    base: { service: "infralift-api" },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    redact: { paths: REDACTED_PATHS, censor: "[redacted]" },
    serializers: { err: serializeError, error: serializeError },
    // Request id, org and user on every line written inside a request.
    mixin() {
      const ctx = contextStore.getStore();
      if (!ctx) return {};
      return {
        requestId: ctx.requestId,
        ...(ctx.orgId ? { orgId: ctx.orgId } : {}),
        ...(ctx.userId ? { userId: ctx.userId } : {}),
      };
    },
    hooks: { streamWrite: scrubSecrets },
  },
  forwarder as NodeJS.WritableStream
);

/** For tests: collect log lines (parsed) until restore(). Raises the level to
 *  debug while capturing, so nothing is filtered out. */
export function captureLogs(): { lines: Record<string, unknown>[]; raw: string[]; restore(): void } {
  const raw: string[] = [];
  const previous = destination;
  const previousLevel = log.level;
  destination = { write: (line: string) => raw.push(line) };
  log.level = "debug";
  return {
    raw,
    get lines() {
      return raw.map((l) => JSON.parse(l) as Record<string, unknown>);
    },
    restore() {
      destination = previous;
      log.level = previousLevel;
    },
  };
}
