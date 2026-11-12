"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { isGitHost, PROVIDER_LABELS, type GitHost, type ProviderConnectionSummary } from "@infralift/shared";
import { api, errorText } from "../../../lib/api";
import { STARTING_POINTS, startingPointOf, type StartingPoint } from "../../../lib/new-project";
import {
  backendProblem,
  newProjectStacks,
  tfcConnectionOf,
  toSettings,
  withBackend,
  type Stack,
} from "../../../lib/stacks";
import { AssessPanel } from "../../../components/assess-panel";
import { ImportPanel } from "../../../components/import-panel";
import { BackendPicker, FilePreview, SettingsFields, type StackFile } from "../../../components/stack-settings";
import {
  CARD,
  ErrorState,
  INPUT,
  LABEL,
  MONO,
  Note,
  PrimaryButton,
  Skeleton,
  SMALL_BTN,
  TEXT_BTN,
} from "../../../components/ui";

// /projects/new: start a project, which is the Terraform for one cloud
// account in one environment (ADR 0010). Three starting points, in the ADR's
// order. The choice is in the URL (?start=adopt|stack|terraform) so the
// browser's back button returns to the picker.
//
// What each one reuses:
//   adopt     AssessPanel: run a read-only assessment of a connection, then
//             adopt its resources from the report (AdoptCard, POST
//             /tf/imports/from-assessment). There is no one-step
//             adopt-from-account endpoint yet; this is the existing flow.
//   stack     The catalog (GET /tf/stacks) minus app stacks (isAppStack).
//   terraform ImportPanel: scan a repository and import a root module behind
//             the zero-change check.

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-text";

export default function NewProjectPage() {
  return (
    <Suspense fallback={<PickerSkeleton />}>
      <NewProject />
    </Suspense>
  );
}

function PickerSkeleton() {
  return (
    <div role="status" aria-label="Loading">
      <Skeleton className="h-8 w-48 mb-6" />
      <Skeleton className="h-28 w-full mb-3" />
      <Skeleton className="h-28 w-full" />
    </div>
  );
}

function NewProject() {
  const params = useSearchParams();
  const router = useRouter();
  const start = startingPointOf(params.get("start"));
  const chosen = STARTING_POINTS.find((s) => s.key === start);

  return (
    <>
      <a className={`${TEXT_BTN} ${FOCUS} -ml-1 mb-2 gap-1`} href="/projects">
        <span aria-hidden="true">{"\u2190"}</span>Projects
      </a>
      <h1 className="text-3xl font-bold tracking-tight mb-2">New project</h1>
      <p className="text-muted mb-8 max-w-[640px]">
        A project is the Terraform for one cloud account in one environment, kept in your repository. infralift writes
        the code and opens a pull request; nothing is applied until you merge it.
      </p>

      {!chosen ? (
        <StartingPointPicker />
      ) : (
        <section aria-labelledby="start-heading">
          <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1">
            <h2 id="start-heading" className="text-lg font-semibold">
              {chosen.title}
            </h2>
            <Link className={`${TEXT_BTN} ${FOCUS}`} href="/projects/new">
              Change starting point
            </Link>
          </div>
          {/* Adopt is a grid of account tiles, so it gets no card around it;
              the stack and import forms sit in one. */}
          {chosen.key === "adopt" ? (
            <AssessPanel highlight={params.get("assess")} />
          ) : (
            <div className={CARD}>
              <StartPanel start={chosen.key} onCreated={() => router.push("/projects")} />
            </div>
          )}
        </section>
      )}
    </>
  );
}

function StartingPointPicker() {
  return (
    <nav aria-label="Starting points" className="grid gap-3 md:grid-cols-3">
      {STARTING_POINTS.map((s, i) => (
        <Link
          key={s.key}
          href={`/projects/new?start=${s.key}`}
          className={`block rounded-xl border p-5 hover:border-control active:bg-bg ${i === 0 ? "border-control bg-surface" : "border-border bg-surface"} ${FOCUS}`}
        >
          <span className="block text-base font-semibold text-text mb-1.5">{s.title}</span>
          <span className="block text-sm text-muted">{s.body}</span>
        </Link>
      ))}
    </nav>
  );
}

function StartPanel({ start, onCreated }: { start: Exclude<StartingPoint, "adopt">; onCreated: () => void }) {
  if (start === "terraform") return <ImportPanel onCreated={onCreated} />;
  return <StackStart onCreated={onCreated} />;
}

// -- start from a stack ----------------------------------------------------------

function StackStart({ onCreated }: { onCreated: () => void }) {
  const [stacks, setStacks] = useState<Stack[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setError(null);
    api<Stack[]>("/tf/stacks")
      .then((all) => setStacks(newProjectStacks(all)))
      .catch((e) => setError(errorText(e)));
  };
  useEffect(load, []);

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!stacks) {
    return (
      <div role="status" aria-label="Loading stacks">
        <Skeleton className="h-16 w-full mb-2" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }
  if (stacks.length === 0) {
    return (
      <>
        <Note>
          The catalog has no infrastructure stacks yet. Stacks that deploy an app are no longer offered for new projects;
          projects already made from one keep working.
        </Note>
        <div className="mt-4 flex flex-wrap gap-2">
          <Link className={`${SMALL_BTN} ${FOCUS}`} href="/projects/new?start=adopt">
            Adopt from an account
          </Link>
          <Link className={`${SMALL_BTN} ${FOCUS}`} href="/projects/new?start=terraform">
            Bring existing Terraform
          </Link>
        </div>
      </>
    );
  }
  return <StackForm stacks={stacks} onCreated={onCreated} />;
}

/** A stack project in an existing repository. Unlike the old drawer there is
 *  no app template and no "create a repository" option (ADR 0010): the
 *  infrastructure lands in a repository you already have, as a pull request. */
function StackForm({ stacks, onCreated }: { stacks: Stack[]; onCreated: () => void }) {
  const [stackSlug, setStackSlug] = useState(stacks[0]?.slug ?? "");
  const stack = stacks.find((s) => s.slug === stackSlug);
  const [name, setName] = useState("");
  const [gitConns, setGitConns] = useState<ProviderConnectionSummary[] | null>(null);
  const [connectionId, setConnectionId] = useState("");
  const [destRepo, setDestRepo] = useState("");
  const [destBranch, setDestBranch] = useState("main");
  const [values, setValues] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<StackFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<ProviderConnectionSummary[]>("/connections")
      .then((all) => {
        const git = all.filter((c) => isGitHost(c.provider) && c.status === "valid");
        setGitConns(git);
        if (git[0]) setConnectionId(git[0].id);
      })
      .catch((e) => {
        setGitConns([]);
        setError(errorText(e));
      });
  }, []);

  const conn = gitConns?.find((c) => c.id === connectionId);
  const gitHost = (conn?.provider ?? "github") as GitHost;
  // Delivery follows the repository's host: GitHub Actions on GitHub, GitLab
  // CI on GitLab. That is the compatibility rule the API enforces too.
  const delivery = stack?.deliveries.find((d) => d.gitHost === gitHost);

  // The resource prefix and the repository the deploy secrets go to default to
  // the project name and the repo above, rather than asking twice.
  const settings = stack
    ? toSettings(
        stack.inputSchema,
        withBackend({
          ...values,
          name: values.name || name,
          delivery: delivery?.slug ?? "",
          ...(gitHost === "gitlab"
            ? { gitlab_project: destRepo }
            : { github_repository: values.github_repository || destRepo.split("/").pop() || "" }),
        })
      )
    : {};

  const changed = (v: Record<string, string>) => {
    setValues(v);
    setPreview(null);
  };

  async function doPreview() {
    if (!stack) return;
    const problem = backendProblem(values);
    setError(problem);
    if (problem) return;
    try {
      const out = await api<{ files: StackFile[] }>(`/tf/stacks/${stack.slug}/preview`, {
        method: "POST",
        body: JSON.stringify({ arguments: settings, tfcConnectionId: tfcConnectionOf(values) }),
      });
      setPreview(out.files);
    } catch (e) {
      setPreview(null);
      setError(errorText(e));
    }
  }

  async function create() {
    if (!stack || busy) return;
    const problem = backendProblem(values);
    if (problem) return setError(problem);
    setBusy(true);
    setError(null);
    try {
      // createRepo is left out, so the API's default (false) applies.
      await api(`/tf/stacks/${stack.slug}/projects`, {
        method: "POST",
        body: JSON.stringify({
          name,
          destRepo,
          destBranch,
          gitHost,
          connectionId,
          tfcConnectionId: tfcConnectionOf(values),
          arguments: settings,
        }),
      });
      onCreated();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }

  return (
    <>
      <div id="stack-label" className={LABEL}>
        Stack
      </div>
      <div role="group" aria-labelledby="stack-label" className="grid gap-2 mb-5 sm:grid-cols-2">
        {stacks.map((s) => (
          <button
            key={s.slug}
            type="button"
            aria-pressed={stackSlug === s.slug}
            onClick={() => {
              setStackSlug(s.slug);
              setPreview(null);
            }}
            className={`min-h-11 text-left rounded-lg border p-3 cursor-pointer ${stackSlug === s.slug ? "border-text bg-surface" : "border-border bg-bg hover:border-muted"} ${FOCUS}`}
          >
            <span className="block text-sm font-semibold">{s.name}</span>
            <span className="block text-xs text-muted mt-1">{s.description}</span>
            <span className="block text-xs text-faint mt-1">{s.target.name}</span>
          </button>
        ))}
      </div>

      {stack && (
        <>
          <div className="mb-4">
            <label htmlFor="proj-project-name" className={LABEL}>
              Project name *
            </label>
            <input
              id="proj-project-name"
              className={INPUT}
              placeholder="aws-prod"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          {gitConns === null ? (
            <Skeleton className="h-11 w-full mb-4" />
          ) : gitConns.length === 0 ? (
            <div className="mb-4">
              <Note>
                Connect <a href="/connections/new?type=github">GitHub</a> or{" "}
                <a href="/connections/new?type=gitlab">GitLab</a> first. The project&apos;s infrastructure lands in a
                repository there as a pull request.
              </Note>
            </div>
          ) : (
            <div className="mb-4">
              <label htmlFor="proj-git-connection" className={LABEL}>
                Repository connection *
              </label>
              <select
                id="proj-git-connection"
                className={`${INPUT} mb-3`}
                value={connectionId}
                onChange={(e) => setConnectionId(e.target.value)}
              >
                {gitConns.map((c) => (
                  <option key={c.id} value={c.id}>
                    {PROVIDER_LABELS[c.provider]} · {c.label}
                  </option>
                ))}
              </select>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_160px]">
                <div>
                  <label htmlFor="proj-repo" className={LABEL}>
                    Repository *
                  </label>
                  <input
                    id="proj-repo"
                    className={`${INPUT} ${MONO}`}
                    placeholder={gitHost === "gitlab" ? "group/project" : "owner/repo"}
                    value={destRepo}
                    onChange={(e) => setDestRepo(e.target.value)}
                  />
                </div>
                <div>
                  <label htmlFor="proj-branch" className={LABEL}>
                    Branch
                  </label>
                  <input
                    id="proj-branch"
                    className={INPUT}
                    value={destBranch}
                    onChange={(e) => setDestBranch(e.target.value)}
                  />
                </div>
              </div>
              <div className="text-xs text-faint mt-1">
                {delivery
                  ? `Delivered by ${delivery.name}, as a ${gitHost === "gitlab" ? "merge request" : "pull request"}.`
                  : `${stack.name} has no delivery that runs on ${PROVIDER_LABELS[gitHost]}.`}
              </div>
            </div>
          )}

          <SettingsFields
            schema={stack.inputSchema}
            values={values}
            hide={["name", "github_repository", "gitlab_project", "delivery"]}
            onChange={changed}
          />
          <BackendPicker values={values} onChange={changed} />
          {preview && <FilePreview files={preview} />}
          {error && (
            <div role="alert" className="text-danger text-sm mt-3">
              {error}
            </div>
          )}
          <div className="flex flex-wrap gap-2 mt-5">
            <button type="button" onClick={doPreview} className={SMALL_BTN}>
              Preview files
            </button>
            <PrimaryButton onClick={create} disabled={busy || !name || !destRepo || !connectionId || !delivery}>
              {busy ? "Working..." : gitHost === "gitlab" ? "Open merge request" : "Open pull request"}
            </PrimaryButton>
          </div>
        </>
      )}
    </>
  );
}
