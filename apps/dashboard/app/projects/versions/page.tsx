"use client";

import { useCallback, useEffect, useState } from "react";
import type { ProjectVersions, VersionsPage } from "@infralift/shared";
import { api, errorText } from "../../../lib/api";
import { CARD, ErrorState, NUM, SkeletonCards, SMALL_BTN, SMALL_BTN_STRONG } from "../../../components/ui";
import { VersionCard } from "../../../components/version-table";

// The fleet view (ADR 0012, phase 1): every project's stack release,
// required_version and provider pins against infralift's baseline. Read-only;
// upgrade pull requests are a later phase. The API reads each repository once
// a day and caches what it found, so this page never waits on a git host
// unless someone presses Check now.

export default function VersionsPageView() {
  const [projects, setProjects] = useState<ProjectVersions[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [checking, setChecking] = useState<Record<string, boolean>>({});
  const [checkErrors, setCheckErrors] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setError(null);
    try {
      const page = await api<VersionsPage>("/tf/versions");
      setProjects(page.projects);
      setNextCursor(page.nextCursor);
      setLoaded(true);
    } catch (e) {
      setError(errorText(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function loadMore() {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const page = await api<VersionsPage>(`/tf/versions?cursor=${encodeURIComponent(nextCursor)}`);
      setProjects((p) => [...p, ...page.projects]);
      setNextCursor(page.nextCursor);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoadingMore(false);
    }
  }

  async function check(id: string) {
    setChecking((c) => ({ ...c, [id]: true }));
    setCheckErrors(({ [id]: _, ...rest }) => rest);
    try {
      const fresh = await api<ProjectVersions>(`/tf/projects/${encodeURIComponent(id)}/versions/check`, { method: "POST", body: "{}" });
      setProjects((list) => list.map((p) => (p.projectId === id ? fresh : p)));
    } catch (e) {
      setCheckErrors((c) => ({ ...c, [id]: errorText(e) }));
    } finally {
      setChecking(({ [id]: _, ...rest }) => rest);
    }
  }

  const count = (s: ProjectVersions["status"]) => projects.filter((p) => p.status === s).length;

  return (
    <div>
      <div className="mb-8">
        <a className="inline-flex min-h-11 items-center text-sm text-muted underline" href="/projects">
          Projects
        </a>
        <h1 className="text-3xl font-bold tracking-tight mb-2 [text-wrap:balance]">Versions</h1>
        <p className="text-muted max-w-[640px]">
          How far each project&apos;s stack release, Terraform version and providers are behind what
          infralift writes today. Read from each project&apos;s branch once a day.
        </p>
      </div>

      {error && (
        <div className="mb-4">
          <ErrorState message={error} onRetry={() => void load()} />
        </div>
      )}

      {!loaded && !error && <SkeletonCards count={3} label="Loading versions" />}

      {loaded && projects.length === 0 && (
        <div className={`${CARD} mb-4`}>
          <h2 className="text-base font-semibold mb-1.5">No projects yet</h2>
          <p className="text-muted text-sm mb-3">
            Once a project has a repository, its stack release and provider versions show here.
          </p>
          <a className={SMALL_BTN_STRONG} href="/projects/new">
            Start a project
          </a>
        </div>
      )}

      {loaded && projects.length > 0 && (
        <p className={`text-sm text-muted mb-4 ${NUM}`}>
          {count("behind-major")} a major release behind · {count("behind-minor")} behind · {count("unknown")} not compared ·{" "}
          {count("current")} current
          {nextCursor ? " (first page)" : ""}
        </p>
      )}

      {projects.map((v) => (
        <VersionCard
          key={v.projectId}
          v={v}
          onCheck={v.destRepo ? () => void check(v.projectId) : undefined}
          checking={!!checking[v.projectId]}
          checkError={checkErrors[v.projectId] ?? null}
        />
      ))}

      {nextCursor && (
        <button type="button" className={SMALL_BTN} onClick={() => void loadMore()} disabled={loadingMore}>
          {loadingMore ? "Loading..." : "Load more"}
        </button>
      )}
    </div>
  );
}
