export const API_URL =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

// Dev-mode org until magic-link auth is wired into the UI.
export const DEV_ORG_ID = "dev-org";

export async function api<T>(
  path: string,
  init?: RequestInit
): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
    cache: "no-store",
  });
  if (!res.ok) {
    let detail = `${res.status}`;
    try {
      const body = await res.json();
      detail = body.detail ?? body.error ?? detail;
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
