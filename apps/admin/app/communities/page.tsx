"use client";

import { useCallback, useEffect, useState } from "react";
import { api, errorText } from "../../lib/api";
import { ErrorState, LoadingRows } from "../../components/ui";

interface Community {
  id: string;
  slug: string;
  name: string;
  platform: string;
  url: string;
  category: string;
  audience: string;
  relevance: string;
  memberCount: number | null;
  isActive: boolean;
}

const PLATFORM_LABEL: Record<string, string> = {
  reddit: "Reddit",
  hackernews: "Hacker News",
  stackexchange: "Stack Exchange",
  discord: "Discord",
  slack: "Slack",
  forum: "Forum",
  blog: "Blog",
  vendor: "Vendor",
};

export default function CommunitiesPage() {
  const [communities, setCommunities] = useState<Community[]>([]);
  const [platform, setPlatform] = useState("");
  const [category, setCategory] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (platform) params.set("platform", platform);
      if (category) params.set("category", category);
      setCommunities(await api<Community[]>(`/communities?${params}`));
      setError(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoaded(true);
    }
  }, [platform, category]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <h1 className="mb-2 text-2xl font-bold tracking-tight sm:text-3xl">
        Community sources
      </h1>
      <p className="text-muted mb-8">
        Forums, subreddits, Discords, and blogs where infralift&apos;s target
        audience discusses cloud costs and migrations.
        {loaded && !error ? ` ${communities.length} communities tracked.` : ""}
      </p>

      {error && <ErrorState message={error} onRetry={() => void load()} />}

      <div className="rounded-xl border border-border bg-surface p-4 sm:p-6">
        <div className="mb-4 flex flex-wrap gap-3">
          <div className="min-w-[150px] flex-1">
            <label className="block text-sm font-semibold text-muted mt-3.5 mb-1">Platform</label>
            <select
              className="w-full bg-bg border border-border rounded-lg px-3 py-2 text-text text-sm mb-4 focus:outline-none focus:border-accent"
              value={platform}
              onChange={(e) => setPlatform(e.target.value)}
            >
              <option value="">All</option>
              <option value="reddit">Reddit</option>
              <option value="hackernews">Hacker News</option>
              <option value="stackexchange">Stack Exchange</option>
              <option value="discord">Discord</option>
              <option value="slack">Slack</option>
              <option value="forum">Forum</option>
              <option value="blog">Blog</option>
              <option value="vendor">Vendor</option>
            </select>
          </div>
          <div className="min-w-[150px] flex-1">
            <label className="block text-sm font-semibold text-muted mt-3.5 mb-1">Category</label>
            <select
              className="w-full bg-bg border border-border rounded-lg px-3 py-2 text-text text-sm mb-4 focus:outline-none focus:border-accent"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            >
              <option value="">All</option>
              <option value="cloud">Cloud</option>
              <option value="devops">DevOps</option>
              <option value="selfhosting">Self-hosting</option>
              <option value="frontend">Frontend</option>
              <option value="startup">Startup</option>
              <option value="general">General</option>
            </select>
          </div>
        </div>

        {!loaded ? (
          <LoadingRows label="Loading communities" />
        ) : communities.length === 0 ? (
          <p className="text-muted text-sm">No communities found.</p>
        ) : (
          <div className="-mx-4 overflow-x-auto px-4 sm:-mx-6 sm:px-6">
            <table className="w-full min-w-[620px] border-collapse text-sm">
              <thead>
                <tr>
                  <th className="text-left p-3 border-b border-border text-muted font-medium text-xs">Name</th>
                  <th className="text-left p-3 border-b border-border text-muted font-medium text-xs">Platform</th>
                  <th className="text-left p-3 border-b border-border text-muted font-medium text-xs">Category</th>
                  <th className="text-left p-3 border-b border-border text-muted font-medium text-xs">Members</th>
                  <th className="text-left p-3 border-b border-border text-muted font-medium text-xs">Relevance</th>
                </tr>
              </thead>
              <tbody>
                {communities.map((c) => (
                  <tr key={c.id}>
                    <td className="p-3 border-b border-border">
                      <a href={c.url} target="_blank" rel="noopener noreferrer">
                        {c.name}
                      </a>
                    </td>
                    <td className="p-3 border-b border-border">{PLATFORM_LABEL[c.platform] ?? c.platform}</td>
                    <td className="p-3 border-b border-border">{c.category}</td>
                    <td className="p-3 border-b border-border">
                      {c.memberCount
                        ? c.memberCount >= 1000
                          ? `${Math.round(c.memberCount / 1000)}k`
                          : c.memberCount
                        : ""}
                    </td>
                    <td className="p-3 border-b border-border max-w-[300px] overflow-hidden text-ellipsis whitespace-nowrap">
                      {c.relevance}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
