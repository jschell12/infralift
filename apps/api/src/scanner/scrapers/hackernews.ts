import type { ScrapedPost } from "../index.js";
import { httpFetch } from "../../lib/http.js";

const SEARCH_QUERIES = [
  "vercel expensive OR pricing OR bill",
  "heroku migration OR alternative",
  "firebase billing OR cost OR expensive",
  "cloud bill OR cloud cost OR egress fees",
  "self-host OR self-hosting migration",
  "moved from vercel OR moved from heroku OR moved from firebase",
];

export async function scrapeHackerNews(
  since: Date
): Promise<ScrapedPost[]> {
  const sinceUnix = Math.floor(since.getTime() / 1000);
  const posts: ScrapedPost[] = [];
  const seen = new Set<string>();

  for (const query of SEARCH_QUERIES) {
    const url = `https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(query)}&tags=story&numericFilters=created_at_i>${sinceUnix}&hitsPerPage=20`;
    try {
      const res = await httpFetch(url);
      if (!res.ok) continue;
      const data: any = await res.json();

      for (const hit of data.hits ?? []) {
        if (seen.has(hit.objectID)) continue;
        seen.add(hit.objectID);

        posts.push({
          sourceId: hit.objectID,
          sourceUrl: `https://news.ycombinator.com/item?id=${hit.objectID}`,
          title: hit.title ?? "",
          body: hit.story_text ?? hit.url ?? "",
          authorName: hit.author ?? undefined,
          engagementScore: hit.points ?? 0,
          postedAt: hit.created_at ? new Date(hit.created_at) : undefined,
        });
      }
    } catch (err) {
      console.warn(`HN search "${query}": ${err}`);
    }
  }

  return posts;
}
