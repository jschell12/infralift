"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { ProviderConnectionSummary, UnmanagedPage, UnmanagedResource } from "@infralift/shared";
import { api, errorText } from "../../../../lib/api";
import { connectionName, isCloudAccount } from "../../../../lib/connections";
import {
  ADOPT_MAX_RESOURCES,
  AdoptRequestError,
  INVENTORY_MAX_AGE_MINUTES,
  adoptFormProblem,
  appendPage,
  buildAdoptRequest,
  defaultAdoptForm,
  fetchUnmanagedPage,
  fetchedAtText,
  groupByType,
  keepLoadedPicks,
  postAdopt,
  toggleGroup,
  toggleResource,
  type AdoptForm,
  type AdoptProblem,
} from "../../../../lib/adopt-account";
import { AdoptTargetForm } from "../../../../components/adopt-target-form";
import { UnmanagedPicker } from "../../../../components/unmanaged-picker";
import {
  CARD,
  ErrorState,
  NUM,
  Note,
  PrimaryButton,
  Skeleton,
  SMALL_BTN,
  SMALL_BTN_STRONG,
  TEXT_BTN,
} from "../../../../components/ui";

// /projects/new/adopt?connection=<id>: the "Adopt from an account" starting
// point for one cloud account (ADR 0010, 0011). Lists what the account runs
// that no infralift project manages (GET /connections/:id/unmanaged, a page
// at a time), lets you pick resources, and adopts them into a new project
// (POST /connections/:id/adopt): an import-block pull request held to a plan
// that changes nothing. Its own page rather than a drawer, so the URL names
// the account and back returns to the account tiles at /projects/new?start=adopt.

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-text";
const BACK_HREF = "/projects/new?start=adopt";

export default function AdoptFromAccountPage() {
  return (
    <Suspense fallback={<ListSkeleton />}>
      <AdoptFromAccount />
    </Suspense>
  );
}

function ListSkeleton() {
  return (
    <div role="status" aria-label="Loading resources" className="flex flex-col gap-4">
      {[0, 1].map((i) => (
        <div key={i} className={`${CARD} p-5`}>
          <Skeleton className="mb-4 h-4 w-1/3" />
          <Skeleton className="mb-3 h-11 w-full" />
          <Skeleton className="mb-3 h-11 w-full" />
          <Skeleton className="h-11 w-2/3" />
        </div>
      ))}
    </div>
  );
}

function BackLink() {
  return (
    <a className={`${TEXT_BTN} ${FOCUS} -ml-1 mb-2 gap-1`} href={BACK_HREF}>
      <span aria-hidden="true">{"←"}</span>Accounts
    </a>
  );
}

/** Loads the org's connections, then hands the account to the picker. A
 *  missing, unknown or broken account gets a sentence and a way out. */
function AdoptFromAccount() {
  const connectionId = useSearchParams().get("connection") ?? "";
  const [connections, setConnections] = useState<ProviderConnectionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    api<ProviderConnectionSummary[]>("/connections")
      .then(setConnections)
      .catch((e) => setError(errorText(e)));
  }, []);
  useEffect(load, [load]);

  const account = connections?.find((c) => c.id === connectionId && isCloudAccount(c.provider));
  const gitConnections = (connections ?? []).filter((c) => c.provider === "github" && c.status === "valid");

  let body;
  if (error) body = <ErrorState message={error} onRetry={load} />;
  else if (!connections) body = <ListSkeleton />;
  else if (!account) {
    body = (
      <div className={CARD}>
        <p className="mb-3 text-sm text-text">
          {connectionId
            ? "We couldn't find that cloud account. It may have been removed."
            : "Pick a cloud account to look in first."}
        </p>
        <a className={`${SMALL_BTN_STRONG} ${FOCUS}`} href={BACK_HREF}>
          Choose an account
        </a>
      </div>
    );
  } else if (account.status !== "valid") {
    body = (
      <div className={CARD}>
        <p className="mb-3 text-sm text-text">
          infralift can&apos;t read this account until its connection is fixed
          {account.lastError ? `: ${account.lastError}` : "."}
        </p>
        <a className={`${SMALL_BTN_STRONG} ${FOCUS}`} href="/connections">
          Fix on Connections
        </a>
      </div>
    );
  } else {
    body = <AdoptWorkspace key={account.id} account={account} gitConnections={gitConnections} />;
  }

  return (
    <>
      <BackLink />
      <h1 className="mb-2 text-3xl font-bold tracking-tight text-balance break-words">
        Adopt from {account ? `${connectionName(account.provider)} · ${account.label}` : "an account"}
      </h1>
      <p className="mb-8 max-w-[640px] text-muted">
        Pick what this account runs that no infralift project manages yet. infralift adopts it into a new project as a
        pull request with import blocks only; its check passes when the plan imports and changes nothing. Nothing in the
        account changes, and nothing is applied until you merge.
      </p>
      {body}
    </>
  );
}

type ListState =
  | { status: "loading" }
  | { status: "error"; problem: AdoptProblem }
  | { status: "ready"; page: Omit<UnmanagedPage, "resources">; resources: UnmanagedResource[]; nextCursor: string | null };

function AdoptWorkspace({
  account,
  gitConnections,
}: {
  account: ProviderConnectionSummary;
  gitConnections: ProviderConnectionSummary[];
}) {
  const router = useRouter();
  const [list, setList] = useState<ListState>({ status: "loading" });
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [form, setForm] = useState<AdoptForm>(() => ({
    ...defaultAdoptForm(account.provider),
    gitConnectionId: gitConnections[0]?.id ?? "",
  }));
  const [submitError, setSubmitError] = useState<AdoptProblem | null>(null);
  const [busy, setBusy] = useState(false);
  // Read on the click itself, before React re-renders the disabled button, so
  // a double tap cannot send two adopt requests (same guard as
  // /connections/new and AssessPanel).
  const inFlight = useRef(false);
  // Each list request gets a number; an answer that is not the newest one is
  // dropped, so a slow "Load more" cannot land on top of a refresh.
  const requestSeq = useRef(0);

  // How many resources were on screen before a refresh, so the refresh reads
  // back at least as far and picks made after "Load more" are not dropped.
  const loadedCount = useRef(0);

  const loadFirst = useCallback(
    async (refresh: boolean) => {
      const seq = ++requestSeq.current;
      const depth = refresh ? loadedCount.current : 0;
      setList({ status: "loading" });
      setMoreError(null);
      try {
        // Only the first request reads the account again; the pages after it
        // come from the inventory that read just cached.
        const first = await fetchUnmanagedPage(account.id, { refresh });
        const { resources: firstPage, ...meta } = first.page;
        let resources = firstPage;
        let nextCursor = first.nextCursor;
        while (nextCursor && resources.length < depth && seq === requestSeq.current) {
          const more = await fetchUnmanagedPage(account.id, { cursor: nextCursor });
          resources = appendPage(resources, more.page.resources);
          nextCursor = more.nextCursor;
        }
        if (seq !== requestSeq.current) return;
        loadedCount.current = resources.length;
        setList({ status: "ready", page: meta, resources, nextCursor });
        setSelected((s) => keepLoadedPicks(s, resources));
      } catch (e) {
        if (seq !== requestSeq.current) return;
        setList({
          status: "error",
          problem: e instanceof AdoptRequestError ? e.problem : { message: errorText(e), resources: [] },
        });
      }
    },
    [account.id]
  );
  useEffect(() => {
    void loadFirst(false);
  }, [loadFirst]);

  async function loadMore() {
    if (list.status !== "ready" || !list.nextCursor || loadingMore) return;
    const seq = requestSeq.current;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const { page, nextCursor } = await fetchUnmanagedPage(account.id, { cursor: list.nextCursor });
      if (seq !== requestSeq.current) return;
      setList((cur) => {
        if (cur.status !== "ready") return cur;
        const resources = appendPage(cur.resources, page.resources);
        loadedCount.current = resources.length;
        return { ...cur, resources, nextCursor };
      });
    } catch (e) {
      if (seq === requestSeq.current) setMoreError(e instanceof AdoptRequestError ? e.message : errorText(e));
    } finally {
      setLoadingMore(false);
    }
  }

  const resources = list.status === "ready" ? list.resources : [];
  const groups = useMemo(() => groupByType(resources), [resources]);
  const picked = selected.size;

  async function adopt() {
    if (inFlight.current) return;
    const problem = adoptFormProblem(form, picked);
    if (problem) {
      setSubmitError({ message: problem, resources: [] });
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setSubmitError(null);
    try {
      // A 202 and a 200 replay (the same request already accepted) both mean
      // the project exists and its pull request is on its way.
      await postAdopt(account.id, buildAdoptRequest(form, selected, resources), resources);
      router.push("/projects");
    } catch (e) {
      setSubmitError(e instanceof AdoptRequestError ? e.problem : { message: errorText(e), resources: [] });
      inFlight.current = false;
      setBusy(false);
    }
  }

  if (list.status === "loading") return <ListSkeleton />;
  if (list.status === "error") {
    return <ErrorState message={list.problem.message} onRetry={() => void loadFirst(false)} />;
  }

  const { page } = list;
  const shownCount = resources.length;

  if (page.total === 0) {
    return (
      <div className={CARD}>
        <h2 className="mb-2 text-base font-semibold">Nothing unmanaged found</h2>
        <p className="mb-4 max-w-[560px] text-sm text-muted">
          Everything infralift can read in this account is already managed by an infralift project, or the account has
          nothing infralift can read yet. {fetchedAtText(page.fetchedAt)}
        </p>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={`${SMALL_BTN_STRONG} ${FOCUS}`} onClick={() => void loadFirst(true)}>
            Read the account again
          </button>
          <a className={`${SMALL_BTN} ${FOCUS}`} href={BACK_HREF}>
            Choose another account
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_380px] lg:items-start">
      <section aria-labelledby="resources-heading" className="min-w-0">
        <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 id="resources-heading" className="text-lg font-semibold">
            Unmanaged resources
          </h2>
          <span className={`text-sm text-muted ${NUM}`}>
            {page.total} found, {page.adoptable} can be adopted
          </span>
        </div>
        <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
          <span className="min-w-0 flex-1">
            {fetchedAtText(page.fetchedAt)} The list can be up to {INVENTORY_MAX_AGE_MINUTES} minutes old; something
            deleted since then fails at the import check, not here.
          </span>
          <button type="button" className={`${SMALL_BTN} ${FOCUS}`} onClick={() => void loadFirst(true)}>
            Refresh
          </button>
        </div>
        <div className="mb-4">
          <Note>
            This list leaves out only what infralift has adopted from this account. Resources managed by a stack, a
            repository import, or a project made before adoption was tracked can still show here, and adopting one of
            them would give it a second Terraform state.
          </Note>
        </div>

        <UnmanagedPicker
          groups={groups}
          selected={selected}
          onToggle={(key) => setSelected((s) => toggleResource(s, key))}
          onToggleGroup={(g) => setSelected((s) => toggleGroup(g, s))}
        />

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <span className={`text-sm text-muted ${NUM}`}>
            Showing {shownCount} of {page.total}
          </span>
          {list.nextCursor && (
            <button
              type="button"
              className={`${SMALL_BTN_STRONG} ${FOCUS}`}
              onClick={() => void loadMore()}
              disabled={loadingMore}
            >
              {loadingMore ? "Loading..." : "Load more"}
            </button>
          )}
          {moreError && (
            <span role="alert" className="text-sm text-danger">
              {moreError}
            </span>
          )}
        </div>
      </section>

      <section aria-labelledby="target-heading" className={`${CARD} min-w-0 p-5 lg:sticky lg:top-6`}>
        <h2 id="target-heading" className="mb-1 text-lg font-semibold">
          New project
        </h2>
        <p className="mb-4 text-sm text-muted">
          Adopted resources go into a new project. Adding them to an existing project isn&apos;t supported yet.
        </p>
        <AdoptTargetForm form={form} onChange={setForm} gitConnections={gitConnections} />

        <p aria-live="polite" className={`mt-5 mb-3 text-sm font-semibold ${NUM}`}>
          {picked === 0
            ? "No resources selected"
            : `${picked} ${picked === 1 ? "resource" : "resources"} selected`}
          {picked > ADOPT_MAX_RESOURCES ? ` (at most ${ADOPT_MAX_RESOURCES} at a time)` : ""}
        </p>
        {submitError && (
          <div role="alert" className="mb-3 text-sm text-danger">
            <p>{submitError.message}</p>
            {submitError.resources.length > 0 && (
              <ul className="mt-2 list-disc pl-5">
                {submitError.resources.map((r) => (
                  <li key={r.label} className="break-words">
                    {r.label}
                    {r.detail ? `: ${r.detail}` : ""}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        <PrimaryButton full onClick={() => void adopt()} disabled={busy || picked === 0 || gitConnections.length === 0}>
          {busy ? "Opening pull request..." : "Open pull request"}
        </PrimaryButton>
      </section>
    </div>
  );
}
