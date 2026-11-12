// API calls go through the same-origin /api rewrite (next.config.ts proxies
// to the Express backend). This avoids cross-origin issues with Cloudflare
// Access cookies. In local dev, set NEXT_PUBLIC_API_URL to override.
export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "/api";

/** Thrown by api() for a failed request. `message` is always a sentence a
 *  customer can read (see errorMessageFor); `status` is null when no response
 *  arrived. Nothing else from the response body is carried. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null
  ) {
    super(message);
  }
}

const NETWORK_MESSAGE =
  "We couldn't reach infralift. Check your connection and try again.";

const STATUS_MESSAGES: Record<number, string> = {
  400: "Something in that request wasn't right. Check the form and try again.",
  401: "You're not signed in. Sign in again, then retry.",
  403: "Your account doesn't have access to that.",
  404: "We couldn't find that. It may have been deleted.",
  409: "That clashes with something already in progress. Refresh and try again.",
  422: "Some of those values aren't accepted. Check the form and try again.",
  429: "Too many requests. Wait a minute and try again.",
};

const SERVER_MESSAGE = "Something went wrong on our side, try again.";

function statusMessage(status: number): string {
  if (status >= 500) return SERVER_MESSAGE;
  return STATUS_MESSAGES[status] ?? STATUS_MESSAGES[400];
}

/** True when the API's `error` field is a sentence written for people: a
 *  non-empty string that is not JSON and not a dump. */
function isHumanSentence(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const text = value.trim();
  if (text.length === 0 || text.length > 240) return false;
  return !text.startsWith("{") && !text.startsWith("[");
}

/** The two structured `error` shapes the API sends on a 4xx: zod's flatten()
 *  from InvalidBody (read as "label: Required" lines), and a list of
 *  sentences from Unprocessable. Anything else is not shown. */
function fieldProblems(value: unknown): string | null {
  if (Array.isArray(value)) {
    const readable = value.filter(isHumanSentence);
    return readable.length ? `Check the form. ${readable.join("; ")}` : null;
  }
  if (!value || typeof value !== "object") return null;
  const flat = value as {
    formErrors?: unknown;
    fieldErrors?: Record<string, unknown>;
  };
  const lines: string[] = [];
  if (Array.isArray(flat.formErrors)) {
    lines.push(...flat.formErrors.filter(isHumanSentence));
  }
  for (const [field, messages] of Object.entries(flat.fieldErrors ?? {})) {
    if (!Array.isArray(messages)) continue;
    const readable = messages.filter(isHumanSentence);
    if (readable.length) lines.push(`${field}: ${readable.join(", ")}`);
  }
  return lines.length ? `Check the form. ${lines.join("; ")}` : null;
}

/**
 * The message a customer sees for a failed request: the API's own `error`
 * sentence, or one chosen from the status.
 *
 * Never `detail`, which is where the API used to put a provider's raw error
 * text and still puts validation internals, and never a bare status code or
 * JSON. A server failure (5xx) always gets the status message, whatever its
 * body says: a 500 body is whatever the failing code had at hand, and a 502's
 * `error` can quote a git host's response body (lib/git/github.ts). So does a
 * 401: its `error` is Cloudflare Access's wording ("Invalid access token"),
 * and what the customer needs to know is that they are signed out.
 */
export function errorMessageFor(status: number, body: unknown): string {
  const error =
    body && typeof body === "object" ? (body as { error?: unknown }).error : undefined;
  if (status >= 500 || status === 401) return statusMessage(status);
  if (isHumanSentence(error)) return error;
  return fieldProblems(error) ?? statusMessage(status);
}

/** The message for anything thrown while calling the API: an ApiError's own
 *  message, or the network message for a fetch that never got a response. */
export function errorText(err: unknown): string {
  return err instanceof ApiError ? err.message : NETWORK_MESSAGE;
}

export async function api<T>(
  path: string,
  init?: RequestInit
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...init?.headers },
      credentials: "include",
      cache: "no-store",
    });
  } catch {
    throw new ApiError(NETWORK_MESSAGE, null);
  }
  if (!res.ok) {
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      // non-JSON error body: the status decides the message
    }
    throw new ApiError(errorMessageFor(res.status, body), res.status);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export function formatCents(cents: number | null | undefined): string {
  if (cents == null) return "—";
  return `$${(cents / 100).toFixed(2)}`;
}

/** An assessment's savings in a few words. An unknown bill reads "enter your
 * bill", never $0, and a negative figure is said as one rather than hidden. */
export function savingsNote(a: {
  netMonthlySavingsCents: number | null;
  currentSpend: { source: string };
}): string {
  const net = a.netMonthlySavingsCents;
  if (net === null) {
    return a.currentSpend.source === "unknown"
      ? "enter your bill to compare"
      : "no sized target yet";
  }
  return net > 0
    ? `saves ${formatCents(net)}/mo net`
    : "staying put is cheaper";
}

/** "August 2026" from an ISO date. Read in UTC so the first of a month does
 * not render as the month before in a timezone west of Greenwich. */
export function formatMonth(iso: string): string {
  return new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** The live URL of a stack project, from the subdomain and zone_name settings
 *  its template asks for. null when the zone is missing, so a project created
 *  without them never reads "https://undefined.undefined". An empty subdomain
 *  means the zone apex. */
export function siteUrl(settings: Record<string, unknown>): string | null {
  const zone = typeof settings.zone_name === "string" ? settings.zone_name.trim() : "";
  if (!zone) return null;
  const sub = typeof settings.subdomain === "string" ? settings.subdomain.trim() : "";
  return sub ? `https://${sub}.${zone}` : `https://${zone}`;
}
