// The date the estimator's price tables were last checked, as the page says
// it. The date itself comes from the API (PRICES_VERIFIED_AT in
// apps/api/src/lib/pricing.ts), which owns the tables; this only formats it.

/** "August 2026" from an ISO date, or null when the API sent none. Read in
 * UTC so the first of a month does not render as the month before for a
 * reader west of Greenwich. */
export function verifiedMonth(iso: string | undefined): string | null {
  if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return null;
  const at = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(at.getTime())) return null;
  return at.toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}
