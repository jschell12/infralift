import type { ScrapedPost } from "../index.js";

const SITES: Record<string, string[]> = {
  stackoverflow: ["cloud-migration", "hosting", "cloud-computing", "deployment"],
  serverfault: ["migration", "cloud", "hosting"],
  devops: ["cloud", "migration", "terraform", "infrastructure"],
  softwareengineering: ["cloud", "hosting", "architecture"],
};

export async function scrapeStackExchange(
  site: string,
  since: Date
): Promise<ScrapedPost[]> {
  const tags = SITES[site];
  if (!tags) return [];

  const fromDate = Math.floor(since.getTime() / 1000);
  const tagStr = tags.join(";");
  const url = `https://api.stackexchange.com/2.3/questions?site=${site}&tagged=${tagStr}&sort=creation&order=desc&fromdate=${fromDate}&pagesize=30&filter=withbody`;

  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`Stack Exchange ${site}: ${res.status}`);
      return [];
    }
    const data: any = await res.json();
    const posts: ScrapedPost[] = [];

    for (const q of data.items ?? []) {
      posts.push({
        sourceId: String(q.question_id),
        sourceUrl: q.link ?? `https://${site}.com/q/${q.question_id}`,
        title: q.title ?? "",
        body: (q.body ?? "").replace(/<[^>]+>/g, "").slice(0, 2000),
        authorName: q.owner?.display_name ?? undefined,
        engagementScore: (q.score ?? 0) + (q.answer_count ?? 0),
        postedAt: q.creation_date ? new Date(q.creation_date * 1000) : undefined,
      });
    }

    return posts;
  } catch (err) {
    console.warn(`Stack Exchange ${site}: ${err}`);
    return [];
  }
}
