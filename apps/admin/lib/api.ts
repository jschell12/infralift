// API calls go through the same-origin /api rewrite (next.config.ts proxies
// to the Express backend). This avoids cross-origin issues with Cloudflare
// Access cookies. In local dev, set NEXT_PUBLIC_API_URL to override.
export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "/api";

/** Thrown by api() for a failed request. `message` is always a sentence (see
 *  errorMessageFor); `status` is null when no response arrived. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null
  ) {
    super(message);
  }
}

const NETWORK_MESSAGE = "Couldn't reach the API. Check your connection and try again.";
const SERVER_MESSAGE = "Something went wrong on the server. Try again.";

const STATUS_MESSAGES: Record<number, string> = {
  400: "That request wasn't accepted. Check it and try again.",
  401: "You're signed out. Sign in again, then retry.",
  403: "Your account doesn't have access to this.",
  404: "That wasn't found. It may have been deleted.",
  409: "That clashes with a change made elsewhere. Refresh and try again.",
  429: "Too many requests. Wait a minute and try again.",
};

/**
 * The message an admin sees for a failed request, never a bare status code.
 *
 * A 4xx shows the API's own `error` sentence when it is one (short, not JSON).
 * A 5xx and a 401 always get the status message: a 5xx body is whatever the
 * failing code had at hand, and a 401's `error` is Cloudflare Access's wording
 * rather than "you are signed out". `detail` is never shown; it carries
 * internals. Same rules as apps/dashboard/lib/api.ts, kept separate because
 * the two apps share no client code.
 */
export function errorMessageFor(status: number, body: unknown): string {
  if (status >= 500) return SERVER_MESSAGE;
  const fallback = STATUS_MESSAGES[status] ?? STATUS_MESSAGES[400];
  if (status === 401) return fallback;
  const error =
    body && typeof body === "object" ? (body as { error?: unknown }).error : undefined;
  if (typeof error !== "string") return fallback;
  const text = error.trim();
  const readable = text.length > 0 && text.length <= 240 && !text.startsWith("{") && !text.startsWith("[");
  return readable ? text : fallback;
}

/** The message for anything thrown while calling the API. */
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
