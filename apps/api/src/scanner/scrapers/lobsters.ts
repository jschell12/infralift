import type { ScrapedPost } from "../index.js";

const KEYWORDS = /\b(billing|cost|expensive|migrate|migration|hosting|cloud|self[- ]host|egress|vercel|heroku|firebase|aws)\b/i;

export async function scrapeLobsters(
  since: Date
): Promise<ScrapedPost[]> {
  const url = "https://lobste.rs/newest.json";
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "infralift-scanner/1.0" },
    });
    if (!res.ok) {
      console.warn(`Lobsters: ${res.status}`);
      return [];
    }
    const stories: any[] = (await res.json()) as any[];
    const posts: ScrapedPost[] = [];

    for (const s of stories) {
      const created = new Date(s.created_at);
      if (created < since) continue;

      const text = `${s.title ?? ""} ${s.description ?? ""} ${(s.tags ?? []).join(" ")}`;
      if (!KEYWORDS.test(text)) continue;

      posts.push({
        sourceId: s.short_id ?? String(s.id),
        sourceUrl: s.comments_url ?? `https://lobste.rs/s/${s.short_id}`,
        title: s.title ?? "",
        body: (s.description ?? s.url ?? "").slice(0, 2000),
        authorName: s.submitter_user?.username ?? undefined,
        engagementScore: (s.score ?? 0) + (s.comment_count ?? 0),
        postedAt: created,
      });
    }

    return posts;
  } catch (err) {
    console.warn(`Lobsters: ${err}`);
    return [];
  }
}
