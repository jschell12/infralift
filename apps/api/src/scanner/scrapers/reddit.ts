import type { ScrapedPost } from "../index.js";

const KEYWORDS = /\b(billing|cost|expensive|pricing|migrate|migration|moved from|switched from|alternative to|self[- ]host|egress|overcharge|surprise bill)\b/i;
const USER_AGENT = "infralift-scanner/1.0 (community lead discovery)";

export async function scrapeReddit(
  subreddit: string,
  since: Date
): Promise<ScrapedPost[]> {
  const url = `https://www.reddit.com/r/${subreddit}/new.json?limit=50`;
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
  });
  if (!res.ok) {
    console.warn(`Reddit r/${subreddit}: ${res.status}`);
    return [];
  }

  const data: any = await res.json();
  const posts: ScrapedPost[] = [];

  for (const child of data?.data?.children ?? []) {
    const p = child.data;
    if (!p) continue;

    const createdAt = new Date(p.created_utc * 1000);
    if (createdAt < since) continue;

    const text = `${p.title ?? ""} ${p.selftext ?? ""}`;
    if (!KEYWORDS.test(text)) continue;

    posts.push({
      sourceId: p.id,
      sourceUrl: `https://reddit.com${p.permalink}`,
      title: p.title ?? "",
      body: (p.selftext ?? "").slice(0, 2000),
      authorName: p.author ?? undefined,
      engagementScore: p.score ?? 0,
      postedAt: createdAt,
    });
  }

  return posts;
}
