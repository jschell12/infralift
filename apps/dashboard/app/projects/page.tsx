"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { PROVIDER_LABELS, type MigrationSummary } from "@infralift/shared";
import { api } from "../../lib/api";
import { AssessPanel } from "../../components/assess-panel";
import { MigrationCard } from "../../components/migration-card";
import {
  CARD,
  Chip,
  Drawer,
  INPUT,
  LABEL,
  MONO,
  Note,
  PrimaryButton,
  type Tone,
} from "../../components/ui";

// Projects: an app and where it runs, kept as code in a repository. A project
// starts one of two ways:
//   - from a template: pick an app and a target, and infralift opens a pull
//     request with the infrastructure, server scripts and CI (a stack);
//   - from existing infrastructure: assess a connected account, pick a target
//     on the assessment's options page, and infralift generates the code for
//     it (codegen).
// Done-for-you migrations are listed here too. Nothing on this page applies
// infrastructure; merging and applying stay with you.

// -- API shapes ---------------------------------------------------------------

interface SchemaProperty {
  type?: string;
  enum?: (string | number)[];
  pattern?: string;
  minimum?: number;
  maximum?: number;
  default?: string | number;
  description?: string;
}

interface InputSchema {
  properties?: Record<string, SchemaProperty>;
  required?: string[];
}

interface Stack {
  slug: string;
  name: string;
  description: string;
  template: { slug: string; name: string; description: string; repo: string };
  target: { slug: string; name: string };
  inputSchema: InputSchema;
  example: Settings;
}

interface Project {
  id: string;
  name: string;
  source: string;
  stackSlug: string | null;
  assessmentId: string | null;
  migrationTarget: string | null;
  destRepo: string;
  destBranch: string;
  providerConfig: Settings;
}

interface Job {
  id: string;
  stage: string;
  status: string;
  statusMessage: string;
  prUrl: string | null;
  createdAt: string;
}

interface StackFile {
  path: string;
  ownership: "managed" | "seed";
}

type Settings = Record<string, string | number | boolean>;

// Targets on the roadmap, shown so the shape of the product is visible. Only
// targets with a stack behind them can be picked.
const ROADMAP_TARGETS = [
  { slug: "aws", name: "AWS" },
  { slug: "gcp", name: "Google Cloud" },
  { slug: "digitalocean", name: "DigitalOcean" },
  { slug: "azure", name: "Azure" },
];

// The state backend has its own control; the generic settings form skips it.
const BACKEND_KEYS = new Set(["backend", "tfc_organization", "tfc_workspace"]);

const STATUS_TONE: Record<string, Tone> = {
  success: "accent",
  errored: "danger",
  running: "warn",
  pending: "muted",
};

// Codegen targets as the API names them (TfProject.migrationTarget).
const TARGET_NAMES: Record<string, string> = { hetzner: "Hetzner", cloudflare: "Cloudflare" };

const label = (key: string) =>
  key.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

/** Form values are strings; the API wants the schema's types. Blank fields are
 *  left out so the stack's defaults apply. */
function toSettings(schema: InputSchema, values: Record<string, string>): Settings {
  const out: Settings = {};
  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    const raw = values[key];
    if (raw === undefined || raw === "") continue;
    out[key] = prop.type === "integer" || prop.type === "number" ? Number(raw) : raw;
  }
  return out;
}

function toValues(settings: Settings | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(settings ?? {})) out[k] = String(v);
  return out;
}

// -- settings form -------------------------------------------------------------

function SettingsFields({
  schema,
  values,
  onChange,
  hide = [],
  locked = [],
}: {
  schema: InputSchema;
  values: Record<string, string>;
  onChange: (v: Record<string, string>) => void;
  /** keys the surrounding form already asks for in its own words */
  hide?: string[];
  /** shown but not editable */
  locked?: string[];
}) {
  const required = new Set(schema.required ?? []);
  const set = (k: string, v: string) => onChange({ ...values, [k]: v });
  return (
    <>
      {Object.entries(schema.properties ?? {})
        .filter(([key]) => !BACKEND_KEYS.has(key) && !hide.includes(key))
        .map(([key, prop]) => (
          <div key={key} className="mb-4">
            <label className={LABEL}>
              {label(key)}
              {required.has(key) ? " *" : ""}
            </label>
            {prop.enum ? (
              <select
                className={INPUT}
                value={values[key] ?? String(prop.default ?? "")}
                onChange={(e) => set(key, e.target.value)}
              >
                {prop.enum.map((v) => (
                  <option key={String(v)} value={String(v)}>
                    {String(v)}
                  </option>
                ))}
              </select>
            ) : (
              <input
                className={`${INPUT} ${locked.includes(key) ? "opacity-60" : ""}`}
                readOnly={locked.includes(key)}
                type={prop.type === "integer" ? "number" : "text"}
                min={prop.minimum}
                max={prop.maximum}
                placeholder={prop.default !== undefined ? String(prop.default) : ""}
                value={values[key] ?? ""}
                onChange={(e) => set(key, e.target.value)}
              />
            )}
            {locked.includes(key) && (
              <div className="text-xs text-warn mt-1">
                Fixed after creation: every resource is named from it, so changing it would replace them.
              </div>
            )}
            {prop.description && (
              <div className="text-xs text-faint mt-1">{prop.description}</div>
            )}
          </div>
        ))}
    </>
  );
}

function BackendPicker({
  values,
  onChange,
}: {
  values: Record<string, string>;
  onChange: (v: Record<string, string>) => void;
}) {
  const backend = values.backend || "r2";
  const options = [
    {
      key: "r2",
      title: "OpenTofu + R2",
      body: "State in a Cloudflare R2 bucket, encrypted before it leaves your machine. No account needed.",
    },
    {
      key: "tfc",
      title: "Terraform Cloud",
      body: "State and runs in your HCP Terraform org. infralift creates the workspace.",
    },
  ];
  return (
    <div className="mb-4">
      <label className={LABEL}>State backend</label>
      <div className="grid grid-cols-2 gap-2">
        {options.map((o) => (
          <button
            key={o.key}
            type="button"
            onClick={() => onChange({ ...values, backend: o.key })}
            className={`text-left rounded-lg border p-3 ${backend === o.key ? "border-accent bg-accent-dim/30" : "border-border bg-bg hover:border-muted"}`}
          >
            <div className="text-sm font-semibold">{o.title}</div>
            <div className="text-xs text-muted mt-1">{o.body}</div>
          </button>
        ))}
      </div>
      {backend === "tfc" && (
        <div className="mt-3 grid grid-cols-2 gap-2">
          <div>
            <label className={LABEL}>Organization *</label>
            <input
              className={INPUT}
              value={values.tfc_organization ?? ""}
              onChange={(e) => onChange({ ...values, tfc_organization: e.target.value })}
            />
          </div>
          <div>
            <label className={LABEL}>Workspace</label>
            <input
              className={INPUT}
              placeholder={values.name || "project name"}
              value={values.tfc_workspace ?? ""}
              onChange={(e) => onChange({ ...values, tfc_workspace: e.target.value })}
            />
          </div>
        </div>
      )}
    </div>
  );
}

/** The one cross-field rule a person is likely to trip over, said plainly
 *  before the API answers with schema language. */
function backendProblem(values: Record<string, string>): string | null {
  return values.backend === "tfc" && !values.tfc_organization
    ? "Terraform Cloud needs the organization the workspace goes in."
    : null;
}

/** Settings sent for the chosen backend only: switching back to R2 must not
 *  carry a stale Terraform Cloud org along. */
function withBackend(values: Record<string, string>): Record<string, string> {
  const v: Record<string, string> = { ...values, backend: values.backend || "r2" };
  if (v.backend !== "tfc") {
    delete v.tfc_organization;
    delete v.tfc_workspace;
  }
  return v;
}

function FilePreview({ files }: { files: StackFile[] }) {
  const managed = files.filter((f) => f.ownership === "managed");
  const seed = files.filter((f) => f.ownership === "seed");
  return (
    <Note>
      <div className="mb-2">
        <b>{managed.length}</b> files infralift keeps up to date
        {seed.length > 0 && (
          <>
            , and <b>{seed.length}</b> that are yours after the first PR (
            {seed.map((f) => (
              <code key={f.path} className={MONO}>
                {f.path}
              </code>
            ))}
            )
          </>
        )}
        .
      </div>
      <div className={`${MONO} text-[11px] leading-5 max-h-48 overflow-y-auto`}>
        {files.map((f) => (
          <div key={f.path} className={f.ownership === "seed" ? "text-accent" : ""}>
            {f.path}
          </div>
        ))}
      </div>
    </Note>
  );
}

// -- drawers -------------------------------------------------------------------

function NewProjectDrawer({
  stacks,
  start,
  highlight,
  onClose,
  onCreated,
}: {
  stacks: Stack[];
  start: "template" | "existing";
  /** connection to point at when arriving from Connections */
  highlight: string | null;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [mode, setMode] = useState(start);
  const templates = useMemo(() => {
    const seen = new Map<string, Stack["template"]>();
    for (const s of stacks) seen.set(s.template.slug, s.template);
    return [...seen.values()];
  }, [stacks]);
  const [templateSlug, setTemplateSlug] = useState(templates[0]?.slug ?? "");
  const targets = stacks.filter((s) => s.template.slug === templateSlug);
  const [stackSlug, setStackSlug] = useState(targets[0]?.slug ?? "");
  const stack = stacks.find((s) => s.slug === stackSlug);

  const [name, setName] = useState("");
  const [destRepo, setDestRepo] = useState("");
  const [destBranch, setDestBranch] = useState("main");
  const [values, setValues] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<StackFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The resource prefix and the repository the deploy secrets go to default to
  // the project name and the repo above, rather than asking twice. Both stay
  // editable later in the project's settings.
  const settings = stack
    ? toSettings(
        stack.inputSchema,
        withBackend({
          ...values,
          name: values.name || name,
          github_repository: values.github_repository || destRepo.split("/")[1] || "",
        })
      )
    : {};

  async function doPreview() {
    if (!stack) return;
    setError(backendProblem(values));
    if (backendProblem(values)) return;
    try {
      const out = await api<{ files: StackFile[] }>(`/tf/stacks/${stack.slug}/preview`, {
        method: "POST",
        body: JSON.stringify({ arguments: settings }),
      });
      setPreview(out.files);
    } catch (e) {
      setPreview(null);
      setError((e as Error).message);
    }
  }

  async function create() {
    if (!stack) return;
    if (backendProblem(values)) return setError(backendProblem(values));
    setBusy(true);
    setError(null);
    try {
      await api(`/tf/stacks/${stack.slug}/projects`, {
        method: "POST",
        body: JSON.stringify({ name, destRepo, destBranch, arguments: settings }),
      });
      onCreated();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer
      title="New project"
      subtitle="infralift writes the infrastructure as code into your repo. Nothing is applied until you merge it and run the plan."
      onClose={onClose}
    >
      <div className="grid grid-cols-2 gap-1 rounded-lg bg-bg p-1 mb-5">
        {(
          [
            ["template", "From a template"],
            ["existing", "From existing infrastructure"],
          ] as const
        ).map(([key, text]) => (
          <button
            key={key}
            type="button"
            onClick={() => setMode(key)}
            className={`rounded-md px-2 py-2 text-[13px] font-semibold ${mode === key ? "bg-surface text-text" : "text-muted hover:text-text"}`}
          >
            {text}
          </button>
        ))}
      </div>

      {mode === "existing" ? (
        <AssessPanel highlight={highlight} />
      ) : (
      <>
      <label className={LABEL}>App template</label>
      <div className="grid gap-2 mb-5">
        {templates.map((t) => (
          <button
            key={t.slug}
            type="button"
            onClick={() => {
              setTemplateSlug(t.slug);
              setStackSlug(stacks.find((s) => s.template.slug === t.slug)?.slug ?? "");
              setPreview(null);
            }}
            className={`text-left rounded-lg border p-3 ${templateSlug === t.slug ? "border-accent bg-accent-dim/30" : "border-border bg-bg hover:border-muted"}`}
          >
            <div className="text-sm font-semibold">{t.name}</div>
            <div className="text-xs text-muted mt-1">{t.description}</div>
            <div className={`text-[11px] text-faint mt-1 ${MONO}`}>{t.repo}</div>
          </button>
        ))}
      </div>

      <label className={LABEL}>Target</label>
      <div className="flex flex-wrap gap-2 mb-5">
        {targets.map((s) => (
          <button
            key={s.slug}
            type="button"
            onClick={() => {
              setStackSlug(s.slug);
              setPreview(null);
            }}
            className={`rounded-full px-3 py-1.5 text-xs font-semibold border ${stackSlug === s.slug ? "border-accent text-accent" : "border-border text-muted"}`}
          >
            {s.target.name}
          </button>
        ))}
        {ROADMAP_TARGETS.filter((r) => !targets.some((s) => s.target.slug === r.slug)).map(
          (r) => (
            <span
              key={r.slug}
              title="Coming soon"
              className="rounded-full px-3 py-1.5 text-xs border border-border text-faint cursor-not-allowed"
            >
              {r.name}
            </span>
          )
        )}
      </div>

      {stack && (
        <>
          <div className="mb-4">
            <label className={LABEL}>Project name *</label>
            <input
              className={INPUT}
              placeholder="acme-web"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-[1fr_120px] gap-2 mb-4">
            <div>
              <label className={LABEL}>App repository *</label>
              <input
                className={`${INPUT} ${MONO}`}
                placeholder="owner/repo"
                value={destRepo}
                onChange={(e) => setDestRepo(e.target.value)}
              />
            </div>
            <div>
              <label className={LABEL}>Branch</label>
              <input
                className={INPUT}
                value={destBranch}
                onChange={(e) => setDestBranch(e.target.value)}
              />
            </div>
          </div>
          <SettingsFields
            schema={stack.inputSchema}
            values={values}
            hide={["name", "github_repository"]}
            onChange={(v) => {
              setValues(v);
              setPreview(null);
            }}
          />
          <BackendPicker
            values={values}
            onChange={(v) => {
              setValues(v);
              setPreview(null);
            }}
          />
          {preview && <FilePreview files={preview} />}
          {error && <div className="text-danger text-sm mt-3">{error}</div>}
          <div className="flex gap-2 mt-5">
            <button
              type="button"
              onClick={doPreview}
              className="rounded-lg border border-border px-4 py-3 text-sm font-semibold text-muted hover:text-text"
            >
              Preview files
            </button>
            <PrimaryButton onClick={create} disabled={busy || !name || !destRepo}>
              {busy ? "Opening PR..." : "Open pull request"}
            </PrimaryButton>
          </div>
        </>
      )}
      </>
      )}
    </Drawer>
  );
}

function SettingsDrawer({
  project,
  stack,
  onClose,
  onSaved,
}: {
  project: Project;
  stack: Stack;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [values, setValues] = useState(toValues(project.providerConfig));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    if (backendProblem(values)) return setError(backendProblem(values));
    setBusy(true);
    setError(null);
    try {
      await api(`/tf/stacks/projects/${project.id}/settings`, {
        method: "PUT",
        body: JSON.stringify({ arguments: toSettings(stack.inputSchema, withBackend(values)) }),
      });
      onSaved();
    } catch (e) {
      setError((e as Error).message);
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
  const [projects, setProjects] = useState<Project[]>([]);
  const [jobs, setJobs] = useState<Record<string, Job[]>>({});
  const [migrations, setMigrations] = useState<MigrationSummary[]>([]);
  const [creating, setCreating] = useState<null | { start: "template" | "existing"; highlight: string | null }>(null);
  const [editing, setEditing] = useState<Project | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [s, p, m] = await Promise.all([
      api<Stack[]>("/tf/stacks"),
      api<Project[]>("/tf/projects"),
      api<MigrationSummary[]>("/migrations"),
    ]);
    // Template projects belong to the older /terraform page.
    const mine = p.filter((x) => x.source === "stack" || x.source === "codegen");
    setStacks(s);
    setProjects(mine);
    setMigrations(m);
    const entries = await Promise.all(
      mine.map(async (x) => [x.id, await api<Job[]>(`/tf/jobs?projectId=${x.id}`)] as const)
    );
    setJobs(Object.fromEntries(entries));
  }, []);

  useEffect(() => {
    load().catch((e) => setError((e as Error).message));
  }, [load]);

  // /projects?start=existing and /projects?assess=<connectionId> (from
  // Connections, and where /assessments now redirects) open the drawer on the
  // existing-infrastructure path.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const assess = q.get("assess");
    if (assess || q.get("start") === "existing") {
      setCreating({ start: "existing", highlight: assess });
    }
  }, []);

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
      <div className="flex items-start gap-4">
        <div className="flex-1">
          <h1 className="text-3xl font-bold tracking-tight mb-2">Projects</h1>
          <p className="text-muted mb-8 max-w-[640px]">
            An app, where it runs, and the infrastructure that runs it, kept as code in your
            repository. Every change arrives as a pull request you review and merge.
          </p>
        </div>
        <PrimaryButton onClick={() => setCreating({ start: "template", highlight: null })}>
          New project
        </PrimaryButton>
      </div>

      {error && <div className="text-danger text-sm mb-4">{error}</div>}

      {projects.length === 0 && migrations.length === 0 && !error && (
        <div className={`${CARD} mb-4`}>
          <h3 className="text-base font-semibold mb-1.5">No projects yet</h3>
          <p className="text-muted text-sm">
            Start from an app template and a target, or assess infrastructure you already run
            and pick where it should go. Either way infralift writes it as code in your repo.
          </p>
        </div>
      )}

      {projects.map((p) => {
        if (p.source === "codegen") {
          const list = jobs[p.id] ?? [];
          const latest = list[0];
          const from = String(p.providerConfig.source ?? "");
          return (
            <div key={p.id} className={`${CARD} mb-4`}>
              <div className="flex items-center gap-3 mb-2">
                <h3 className="text-base font-semibold">{p.name}</h3>
                <Chip tone="info">
                  {PROVIDER_LABELS[from as keyof typeof PROVIDER_LABELS] ?? from} to{" "}
                  {TARGET_NAMES[p.migrationTarget ?? ""] ?? p.migrationTarget ?? "?"}
                </Chip>
                <Chip tone="muted">from existing infrastructure</Chip>
                {p.assessmentId && (
                  <a
                    className="ml-auto text-xs font-semibold text-muted hover:text-text"
                    href={`/assessments/${p.assessmentId}`}
                  >
                    Assessment
                  </a>
                )}
              </div>
              <div className={`text-sm text-muted ${MONO} mb-3`}>
                <a href={`https://github.com/${p.destRepo}`}>{p.destRepo}</a>@{p.destBranch}
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
        const stack = p.stackSlug ? stackBySlug.get(p.stackSlug) : undefined;
        const list = jobs[p.id] ?? [];
        const latest = list[0];
        const pr = list.find((j) => j.prUrl)?.prUrl;
        return (
          <div key={p.id} className={`${CARD} mb-4`}>
            <div className="flex items-center gap-3 mb-2">
              <h3 className="text-base font-semibold">{p.name}</h3>
              {stack && (
                <Chip tone="info">
                  {stack.template.name} on {stack.target.name}
                </Chip>
              )}
              <Chip tone="muted">
                {p.providerConfig.backend === "tfc" ? "Terraform Cloud" : "OpenTofu + R2"}
              </Chip>
              <div className="ml-auto flex gap-2">
                {stack && (
                  <button
                    type="button"
                    onClick={() => setEditing(p)}
                    className="rounded-lg border border-border px-3 py-1.5 text-xs font-semibold text-muted hover:text-text"
                  >
                    Settings
                  </button>
                )}
              </div>
            </div>
            <div className={`text-sm text-muted ${MONO} mb-3`}>
              {p.destRepo}@{p.destBranch} · https://{String(p.providerConfig.subdomain)}.
              {String(p.providerConfig.zone_name)}
            </div>
            {latest ? (
              <div className="flex items-center gap-2 text-sm">
                <Chip tone={STATUS_TONE[latest.status] ?? "muted"}>
                  {latest.stage} · {latest.status}
                </Chip>
                <span className="text-muted truncate">{latest.statusMessage}</span>
                {pr && (
                  <a className="ml-auto text-accent text-sm font-semibold" href={pr}>
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

      {creating && (
        <NewProjectDrawer
          stacks={stacks}
          start={creating.start}
          highlight={creating.highlight}
          onClose={() => setCreating(null)}
          onCreated={() => {
            setCreating(null);
            load().catch(() => {});
          }}
        />
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
