"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  PROVIDER_LABELS,
  type CodegenProject,
  type DriftStatus,
  type ImportedProject,
  type MigrationSummary,
  type Project,
  type StackProject,
} from "@infralift/shared";
import { api, errorText, siteUrl } from "../../lib/api";
import {
  backendProblem,
  TFC_CONNECTION,
  tfcConnectionOf,
  toSettings,
  toValues,
  withBackend,
  type Stack,
} from "../../lib/stacks";
import { legacyNewProjectUrl } from "../../lib/new-project";
import { ImportCheckStatus } from "../../components/import-panel";
import { MigrationCard } from "../../components/migration-card";
import { BackendPicker, SettingsFields } from "../../components/stack-settings";
import {
  CARD,
  Chip,
  Drawer,
  ErrorState,
  MONO,
  PrimaryButton,
  SkeletonCards,
  type Tone,
  SMALL_BTN,
  SMALL_BTN_STRONG,
} from "../../components/ui";

// Projects: the Terraform for one cloud account in one environment, kept as
// code in a repository (ADR 0010). This page lists them; starting one is its
// own page, /projects/new. Existing project kinds that ADR 0010 no longer
// offers for new projects (app stacks, codegen migrations) are still listed
// here and keep working. Done-for-you migrations are listed here too.
// Nothing on this page applies infrastructure; merging and applying stay
// with you.

// Projects come from the API as one type per kind (@infralift/shared). This
// page lists the kinds it manages; template projects belong to /terraform.
type ListedProject = CodegenProject | StackProject | ImportedProject;
const isListed = (p: Project): p is ListedProject => p.kind === "stack" || p.kind === "codegen" || p.kind === "imported";

interface Job {
  id: string;
  stage: string;
  status: string;
  statusMessage: string;
  prUrl: string | null;
  createdAt: string;
}

const STATUS_TONE: Record<string, Tone> = {
  success: "ok",
  errored: "danger",
  running: "warn",
  pending: "muted",
};

// Codegen targets as the API names them (TfProject.migrationTarget).
const TARGET_NAMES: Record<string, string> = { hetzner: "Hetzner", cloudflare: "Cloudflare" };

const BACKEND_NAMES: Record<string, string> = {
  s3: "S3",
  r2: "R2",
  gcs: "GCS",
  azurerm: "Azure Storage",
};

const DRIFT_LOOK: Record<DriftStatus["state"], { tone: Tone; text: string }> = {
  drift: { tone: "danger", text: "drift detected" },
  none: { tone: "ok", text: "no drift" },
  unknown: { tone: "muted", text: "drift unknown" },
  unapplied: { tone: "warn", text: "adopted, not yet applied" },
};

/** What the daily drift check on the default branch last said, read by the
 *  API's drift sweep. Nothing until it has been read once. */
function DriftBadge({ drift }: { drift: DriftStatus | null }) {
  if (!drift) return null;
  const look = DRIFT_LOOK[drift.state] ?? DRIFT_LOOK.unknown;
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm mb-2">
      <Chip tone={look.tone}>{look.text}</Chip>
      <span className="min-w-0 text-muted break-words" title={drift.message}>
        {drift.message}
      </span>
      <span className="text-faint whitespace-nowrap">
        last checked {new Date(drift.ranAt ?? drift.checkedAt).toLocaleString()}
      </span>
      {drift.checkUrl && (
        <a className="ml-auto text-text underline text-sm font-semibold whitespace-nowrap" href={drift.checkUrl}>
          View check
        </a>
      )}
    </div>
  );
}

function SettingsDrawer({
  project,
  stack,
  onClose,
  onSaved,
}: {
  project: StackProject;
  stack: Stack;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [values, setValues] = useState({
    ...toValues(project.providerConfig),
    ...(project.tfcConnectionId ? { [TFC_CONNECTION]: project.tfcConnectionId } : {}),
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    if (backendProblem(values)) return setError(backendProblem(values));
    setBusy(true);
    setError(null);
    try {
      await api(`/tf/stacks/projects/${project.id}/settings`, {
        method: "PUT",
        body: JSON.stringify({
          arguments: toSettings(stack.inputSchema, withBackend(values)),
          tfcConnectionId: tfcConnectionOf(values),
        }),
      });
      onSaved();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer
      title={`${project.name} settings`}
      subtitle={`Saving opens a pull request against ${project.destRepo}@${project.destBranch}, or updates the one already open.`}
      onClose={onClose}
    >
      <SettingsFields
        schema={stack.inputSchema}
        values={values}
        onChange={setValues}
        locked={["name"]}
        hide={["delivery", "gitlab_project"]}
      />
      <BackendPicker values={values} onChange={setValues} />
      {error && <div className="text-danger text-sm mt-3">{error}</div>}
      <div className="mt-5">
        <PrimaryButton onClick={save} disabled={busy}>
          {busy ? "Saving..." : "Save and open pull request"}
        </PrimaryButton>
      </div>
    </Drawer>
  );
}

// -- page ----------------------------------------------------------------------

export default function ProjectsPage() {
  const [stacks, setStacks] = useState<Stack[]>([]);
  const [projects, setProjects] = useState<ListedProject[]>([]);
  const [jobs, setJobs] = useState<Record<string, Job[]>>({});
  const [migrations, setMigrations] = useState<MigrationSummary[]>([]);
  const [editing, setEditing] = useState<StackProject | null>(null);
  const [error, setError] = useState<string | null>(null);
  // False until the first load answers, so "No projects yet" is never shown
  // to a customer whose projects are still on their way.
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    const [s, p, m] = await Promise.all([
      api<Stack[]>("/tf/stacks"),
      api<Project[]>("/tf/projects"),
      api<MigrationSummary[]>("/migrations"),
    ]);
    // Template projects belong to the older /terraform page.
    const mine = p.filter(isListed);
    setStacks(s);
    setProjects(mine);
    setMigrations(m);
    const entries = await Promise.all(
      mine.map(async (x) => [x.id, await api<Job[]>(`/tf/jobs?projectId=${x.id}`)] as const)
    );
    setJobs(Object.fromEntries(entries));
    setLoaded(true);
  }, []);

  const firstLoad = useCallback(() => {
    setError(null);
    load().catch((e) => setError(errorText(e)));
  }, [load]);

  useEffect(firstLoad, [firstLoad]);

  // Old links opened the new-project drawer here: /projects?start=existing,
  // ?start=import and ?assess=<connectionId>. Starting a project is its own
  // page now, so send them there with the same meaning.
  const router = useRouter();
  useEffect(() => {
    const target = legacyNewProjectUrl(window.location.search);
    if (target) router.replace(target);
  }, [router]);

  // Poll while any job is still moving through the pipeline.
  useEffect(() => {
    const active = Object.values(jobs).some((list) =>
      list.some((j) => j.status === "pending" || j.status === "running")
    );
    if (!active) return;
    const t = setInterval(() => load().catch(() => {}), 3000);
    return () => clearInterval(t);
  }, [jobs, load]);

  const stackBySlug = new Map(stacks.map((s) => [s.slug, s]));

  return (
    <div>
      <div className="mb-8 flex flex-wrap items-start gap-x-4 gap-y-3">
        <div className="min-w-0 flex-1 basis-[280px]">
          <h1 className="text-3xl font-bold tracking-tight mb-2">Projects</h1>
          <p className="text-muted max-w-[640px]">
            The Terraform for one cloud account in one environment, kept as code in your
            repository. Every change arrives as a pull request you review and merge.
          </p>
        </div>
        <PrimaryButton href="/projects/new">New project</PrimaryButton>
      </div>

      {error && (
        <div className="mb-4">
          <ErrorState message={error} onRetry={firstLoad} />
        </div>
      )}

      {!loaded && !error && <SkeletonCards count={2} label="Loading projects" />}

      {loaded && projects.length === 0 && migrations.length === 0 && !error && (
        <div className={`${CARD} mb-4`}>
          <h3 className="text-base font-semibold mb-1.5">No projects yet</h3>
          <p className="text-muted text-sm mb-3">
            Adopt what a cloud account already runs, start from a stack, or bring Terraform you
            already have. Nothing that is running changes until you merge and apply.
          </p>
          <a className={SMALL_BTN_STRONG} href="/projects/new">
            Start a project
          </a>
        </div>
      )}

      {projects.map((p) => {
        if (p.kind === "codegen") {
          const list = jobs[p.id] ?? [];
          const latest = list[0];
          const from = String(p.providerConfig.source ?? "");
          return (
            <div key={p.id} className={`${CARD} mb-4`}>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2 mb-2">
                <h3 className="text-base font-semibold">{p.name}</h3>
                <Chip tone="muted">
                  {PROVIDER_LABELS[from as keyof typeof PROVIDER_LABELS] ?? from} to{" "}
                  {TARGET_NAMES[p.migrationTarget ?? ""] ?? p.migrationTarget ?? "?"}
                </Chip>
                <Chip tone="muted">from existing infrastructure</Chip>
                {p.assessmentId && (
                  <a
                    className="ml-auto inline-flex min-h-11 items-center text-xs font-semibold text-muted hover:text-text"
                    href={`/assessments/${p.assessmentId}`}
                  >
                    Assessment
                  </a>
                )}
              </div>
              <div className={`text-sm text-muted ${MONO} mb-3 break-all`}>
                <a href={`https://${p.gitHost === "gitlab" ? "gitlab.com" : "github.com"}/${p.destRepo}`}>
                  {p.destRepo}
                </a>
                @{p.destBranch}
              </div>
              {latest ? (
                <div className="flex items-center gap-2 text-sm">
                  <Chip tone={STATUS_TONE[latest.status] ?? "muted"}>
                    {latest.stage} · {latest.status}
                  </Chip>
                  <span className="text-muted truncate">{latest.statusMessage}</span>
                </div>
              ) : (
                <div className="text-sm text-faint">No jobs yet.</div>
              )}
            </div>
          );
        }
        if (p.kind === "imported") {
          const list = jobs[p.id] ?? [];
          const latest = list[0];
          const pr = list.find((j) => j.prUrl)?.prUrl;
          const scan = p.importJson;
          return (
            <div key={p.id} className={`${CARD} mb-4`}>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2 mb-2">
                <h3 className="text-base font-semibold">{p.name}</h3>
                <Chip tone="muted">imported</Chip>
                {scan && (
                  <Chip tone="muted">
                    {scan.resources} resources · {scan.tool === "tofu" ? "OpenTofu" : "Terraform"} ·{" "}
                    {BACKEND_NAMES[scan.backend.kind] ?? scan.backend.kind} state
                  </Chip>
                )}
              </div>
              <div className={`text-sm text-muted ${MONO} mb-3 break-all`}>
                <a href={`https://github.com/${p.destRepo}`}>{p.destRepo}</a>@{p.destBranch}
                {p.destPath && ` · ${p.destPath}`}
              </div>
              <DriftBadge drift={p.drift} />
              {/* Once the pull request exists, the check is what matters; the
                  job row stays only while it is running or if it failed. */}
              {latest && (!pr || latest.status !== "success") && (
                <div className="flex items-center gap-2 text-sm mb-2">
                  <Chip tone={STATUS_TONE[latest.status] ?? "muted"}>
                    {latest.stage} · {latest.status}
                  </Chip>
                  <span className="text-muted truncate">{latest.statusMessage}</span>
                </div>
              )}
              {pr ? (
                <ImportCheckStatus projectId={p.id} last={p.importCheckJson} />
              ) : (
                !latest && <div className="text-sm text-faint">No jobs yet.</div>
              )}
            </div>
          );
        }
        // Only stack projects are left.
        const stack = stackBySlug.get(p.stackSlug);
        const list = jobs[p.id] ?? [];
        const latest = list[0];
        const pr = list.find((j) => j.prUrl)?.prUrl;
        return (
          <div key={p.id} className={`${CARD} mb-4`}>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 mb-2">
              <h3 className="text-base font-semibold">{p.name}</h3>
              {stack && (
                <Chip tone="muted">
                  {stack.template ? `${stack.template.name} on ${stack.target.name}` : stack.name}
                </Chip>
              )}
              <Chip tone="muted">
                {p.providerConfig.backend === "tfc" ? "Terraform Cloud" : "OpenTofu + R2"}
              </Chip>
              {stack && (
                <Chip tone="muted">
                  {stack.deliveries.find((d) => d.slug === p.providerConfig.delivery)?.name ??
                    stack.deliveries.find((d) => d.gitHost === p.gitHost)?.name}
                </Chip>
              )}
              <div className="ml-auto flex gap-2">
                {stack && (
                  <button
                    type="button"
                    onClick={() => setEditing(p)}
                    className={SMALL_BTN}
                  >
                    Settings
                  </button>
                )}
              </div>
            </div>
            <div className={`text-sm text-muted ${MONO} mb-3 break-all`}>
              {p.destRepo}@{p.destBranch}
              {siteUrl(p.providerConfig) && ` · ${siteUrl(p.providerConfig)}`}
            </div>
            <DriftBadge drift={p.drift} />
            {latest ? (
              <div className="flex items-center gap-2 text-sm">
                <Chip tone={STATUS_TONE[latest.status] ?? "muted"}>
                  {latest.stage} · {latest.status}
                </Chip>
                <span className="text-muted truncate">{latest.statusMessage}</span>
                {pr && (
                  <a className="ml-auto text-text underline text-sm font-semibold" href={pr}>
                    View pull request
                  </a>
                )}
              </div>
            ) : (
              <div className="text-sm text-faint">No jobs yet.</div>
            )}
          </div>
        );
      })}

      {migrations.length > 0 && (
        <>
          <h2 id="migrations" className="text-lg font-semibold mt-8 mb-3">
            Done-for-you migrations
          </h2>
          {migrations.map((m) => (
            <MigrationCard key={m.id} m={m} />
          ))}
        </>
      )}

      {editing && editing.stackSlug && stackBySlug.get(editing.stackSlug) && (
        <SettingsDrawer
          project={editing}
          stack={stackBySlug.get(editing.stackSlug)!}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load().catch(() => {});
          }}
        />
      )}
    </div>
  );
}
