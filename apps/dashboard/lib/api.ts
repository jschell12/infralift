// API calls go through the same-origin /api rewrite (next.config.ts proxies
// to the Express backend). This avoids cross-origin issues with Cloudflare
// Access cookies. In local dev, set NEXT_PUBLIC_API_URL to override.
export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "/api";

export async function api<T>(
  path: string,
  init?: RequestInit
): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
    credentials: "include",
    cache: "no-store",
  });
  if (!res.ok) {
    let detail = `${res.status}`;
    try {
      const body = await res.json();
      const raw = body.detail ?? body.error ?? detail;
      // zod's flatten() is an object; show its messages, not [object Object].
      detail =
        typeof raw === "string"
          ? raw
          : [
              ...(raw?.formErrors ?? []),
              ...Object.entries(raw?.fieldErrors ?? {}).map(
                ([k, v]) => `${k}: ${(v as string[]).join(", ")}`
              ),
            ].join("; ") || JSON.stringify(raw);
    } catch {
      // non-JSON error body
    }
    throw new Error(detail);
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
