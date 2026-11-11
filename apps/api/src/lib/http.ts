// ---------------------------------------------------------------------------
// Outbound HTTP with a deadline.
//
// Every call infralift makes to another system (a provider API, a git host,
// Terraform Cloud, Cloudflare's analytics API) goes through httpFetch(), so
// none of them can wait forever. Before this, a provider that accepted the
// connection and never answered held an assessment request, or a job, open
// until the process restarted.
//
// The timeout covers the whole exchange: if the deadline passes while the body
// is still being read, res.json() / res.text() rejects with a DOMException
// named "TimeoutError". Neither that nor HttpTimeoutError carries an HTTP
// status, so a timeout is never mistaken for a provider refusing a credential
// (services/connections.ts marks a connection invalid only on 401/403).
//
// Timeouts are not retried here. A caller that knows its request is safe to
// repeat can retry; most of ours write to a customer's repository and do not.
// ---------------------------------------------------------------------------

/** Every outbound deadline, in one place. */
export const HTTP_TIMEOUTS_MS = {
  /** Provider APIs, Terraform Cloud: one small JSON request. */
  default: 15_000,
  /** GitHub and GitLab: recursive tree listings of a large repository and
   *  commits carrying many files are measured in tens of seconds. */
  gitHost: 30_000,
  /** Workers Analytics Engine SQL: an aggregate over a day of raw events. */
  analyticsSql: 60_000,
  /** The scanner's LLM classification call (Anthropic SDK `timeout`). */
  llm: 60_000,
} as const;

/** AWS SDK clients take their own handler options rather than a fetch
 *  signal; see connectors/aws.ts. maxAttempts counts the first try. */
export const AWS_HTTP = {
  connectionTimeoutMs: 5_000,
  requestTimeoutMs: 30_000,
  maxAttempts: 3,
} as const;

/** The other system did not answer in time. The message names the host and
 *  the limit, never the path or query, which can carry identifiers. */
export class HttpTimeoutError extends Error {
  constructor(
    readonly host: string,
    readonly timeoutMs: number,
    options?: { cause?: unknown }
  ) {
    super(`${host} did not answer within ${formatDuration(timeoutMs)}`, options);
    this.name = "HttpTimeoutError";
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${Math.round(ms / 1000)}s`;
}

function hostOf(url: string | URL | Request): string {
  try {
    return new URL(url instanceof Request ? url.url : url).host;
  } catch {
    return "the remote host";
  }
}

export interface HttpFetchOptions {
  /** Defaults to HTTP_TIMEOUTS_MS.default. */
  timeoutMs?: number;
}

/** fetch() with a deadline. Throws HttpTimeoutError when the deadline passes
 *  before the response headers arrive; other network errors are rethrown
 *  as fetch threw them. A caller's own `init.signal` still works. */
export async function httpFetch(
  url: string | URL | Request,
  init: RequestInit = {},
  options: HttpFetchOptions = {}
): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? HTTP_TIMEOUTS_MS.default;
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = init.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
  try {
    return await fetch(url, { ...init, signal });
  } catch (err) {
    if (deadline.aborted) throw new HttpTimeoutError(hostOf(url), timeoutMs, { cause: err });
    throw err;
  }
}
