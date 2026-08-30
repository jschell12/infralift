/**
 * Map a (referrer host, utm_source) pair to a marketing channel bucket.
 * utm_source wins when present (a tagged link is authoritative about where
 * it was posted); otherwise fall back to the referrer host.
 */
export function channelFor(refHost: string, utmSource: string): string {
  const s = (utmSource || "").toLowerCase();
  if (s) {
    if (s.includes("hn") || s.includes("hackernews")) return "hn";
    if (s.includes("reddit")) return "reddit";
    if (s.includes("lobsters")) return "lobsters";
    if (s.includes("twitter") || s === "x") return "x";
    if (s.includes("newsletter") || s.includes("email")) return "email";
    return s;
  }
  const h = (refHost || "").toLowerCase();
  if (!h) return "direct";
  if (h.includes("news.ycombinator")) return "hn";
  if (h.includes("reddit")) return "reddit";
  if (h.includes("lobste.rs")) return "lobsters";
  if (h === "t.co" || h.includes("twitter") || h === "x.com") return "x";
  if (h.includes("google")) return "google";
  if (h.includes("bing") || h.includes("duckduckgo")) return "search";
  if (h.includes("github")) return "github";
  if (h.includes("linkedin")) return "linkedin";
  if (h.includes("facebook")) return "facebook";
  return "other";
}
