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
