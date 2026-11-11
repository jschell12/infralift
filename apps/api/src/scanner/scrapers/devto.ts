import type { ScrapedPost } from "../index.js";
import { httpFetch } from "../../lib/http.js";

const TAGS = ["cloud", "devops", "hosting", "terraform", "migration", "selfhosting"];
const KEYWORDS = /\b(billing|cost|expensive|migrate|migration|moved from|switched|alternative|self[- ]host|egress)\b/i;

export async function scrapeDevTo(
  since: Date
): Promise<ScrapedPost[]> {
  const posts: ScrapedPost[] = [];
  const seen = new Set<string>();

  for (const tag of TAGS) {
    const url = `https://dev.to/api/articles?tag=${tag}&per_page=30&top=1`;
    try {
      const res = await httpFetch(url, {
        headers: { "User-Agent": "infralift-scanner/1.0" },
      });
      if (!res.ok) continue;
      const articles: any[] = (await res.json()) as any[];

      for (const a of articles) {
        const published = new Date(a.published_at ?? a.created_at);
        if (published < since) continue;

        const id = String(a.id);
        if (seen.has(id)) continue;
        seen.add(id);

        const text = `${a.title ?? ""} ${a.description ?? ""}`;
        if (!KEYWORDS.test(text)) continue;

        posts.push({
          sourceId: id,
          sourceUrl: a.url ?? `https://dev.to/${a.path}`,
          title: a.title ?? "",
          body: (a.description ?? "").slice(0, 2000),
          authorName: a.user?.username ?? undefined,
          engagementScore: (a.public_reactions_count ?? 0) + (a.comments_count ?? 0),
          postedAt: published,
        });
      }
    } catch (err) {
      console.warn(`DEV.to tag "${tag}": ${err}`);
    }
  }

  return posts;
}
