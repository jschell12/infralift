import { PrismaClient } from "@prisma/client";
import { scrapeReddit } from "./scrapers/reddit.js";
import { scrapeHackerNews } from "./scrapers/hackernews.js";
import { scrapeDevTo } from "./scrapers/devto.js";
import { scrapeStackExchange } from "./scrapers/stackexchange.js";
import { scrapeLobsters } from "./scrapers/lobsters.js";
import { classify } from "./classify.js";

export interface ScrapedPost {
  sourceId: string;
  sourceUrl: string;
  title: string;
  body: string;
  authorName?: string;
  engagementScore?: number;
  postedAt?: Date;
}

const SCRAPABLE_PLATFORMS = new Set([
  "reddit",
  "hackernews",
  "forum",
  "stackexchange",
]);

const prisma = new PrismaClient();

// How far back to look for new posts (24 hours).
const LOOKBACK_MS = 24 * 60 * 60 * 1000;

async function scrape(
  community: { slug: string; platform: string; url: string },
  since: Date
): Promise<ScrapedPost[]> {
  const { platform, url, slug } = community;

  if (platform === "reddit") {
    const sub = url.replace(/^https?:\/\/reddit\.com\/r\//, "").replace(/\/$/, "");
    return scrapeReddit(sub, since);
  }

  if (platform === "hackernews") {
    return scrapeHackerNews(since);
  }

  if (platform === "stackexchange") {
    // Map slug to SE site name
    const siteMap: Record<string, string> = {
      "so-cloud": "stackoverflow",
      serverfault: "serverfault",
      "devops-se": "devops",
      "softwareeng-se": "softwareengineering",
    };
    const site = siteMap[slug];
    if (!site) return [];
    return scrapeStackExchange(site, since);
  }

  // DEV.to and Lobsters are "forum" platform in the DB
  if (slug === "dev-to") {
    return scrapeDevTo(since);
  }

  if (slug === "lobsters") {
    return scrapeLobsters(since);
  }

  return [];
}

async function main() {
  const since = new Date(Date.now() - LOOKBACK_MS);
  console.log(`Community scanner starting. Looking back to ${since.toISOString()}`);

  const communities = await prisma.communitySource.findMany({
    where: {
      isActive: true,
      platform: { in: [...SCRAPABLE_PLATFORMS] },
    },
  });

  // Also include specific forum slugs
  const forumSlugs = ["dev-to", "lobsters"];
  const forumCommunities = await prisma.communitySource.findMany({
    where: { slug: { in: forumSlugs }, isActive: true },
  });

  const allCommunities = [
    ...communities.filter((c) => c.platform !== "forum"),
    ...forumCommunities,
  ];

  // Deduplicate by slug
  const uniqueMap = new Map(allCommunities.map((c) => [c.slug, c]));
  const toScan = [...uniqueMap.values()];

  console.log(`Found ${toScan.length} scrapable communities`);

  let totalScraped = 0;
  let totalClassified = 0;
  let totalStored = 0;

  for (const community of toScan) {
    try {
      const posts = await scrape(community, since);
      totalScraped += posts.length;

      if (posts.length === 0) continue;
      console.log(`  ${community.slug}: ${posts.length} posts`);

      // Filter out posts we already have
      const existing = await prisma.communityLead.findMany({
        where: {
          platform: community.platform === "forum" ? community.slug : community.platform,
          sourceId: { in: posts.map((p) => p.sourceId) },
        },
        select: { sourceId: true },
      });
      const existingIds = new Set(existing.map((e) => e.sourceId));
      const newPosts = posts.filter((p) => !existingIds.has(p.sourceId));

      if (newPosts.length === 0) {
        console.log(`    (all already indexed)`);
        continue;
      }

      // Classify and store
      for (const post of newPosts) {
        totalClassified++;
        const result = await classify(post.title, post.body);

        if (result.classification === "irrelevant") continue;

        const leadPlatform =
          community.platform === "forum" ? community.slug : community.platform;

        await prisma.communityLead.upsert({
          where: {
            sourceId_platform: {
              sourceId: post.sourceId,
              platform: leadPlatform,
            },
          },
          create: {
            communityId: community.id,
            sourceUrl: post.sourceUrl,
            sourceId: post.sourceId,
            platform: leadPlatform,
            title: post.title,
            body: post.body,
            authorName: post.authorName ?? null,
            classification: result.classification,
            confidence: result.confidence,
            engagementScore: post.engagementScore ?? null,
            postedAt: post.postedAt ?? null,
          },
          update: {
            engagementScore: post.engagementScore ?? null,
            classification: result.classification,
            confidence: result.confidence,
          },
        });
        totalStored++;
      }

      // Rate limiting between communities
      await new Promise((r) => setTimeout(r, 2000));
    } catch (err) {
      console.error(`  ${community.slug} failed: ${err}`);
    }
  }

  console.log(
    `\nDone. Scraped ${totalScraped} posts, classified ${totalClassified}, stored ${totalStored} leads.`
  );

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("Scanner failed:", err);
  await prisma.$disconnect();
  process.exit(1);
});
