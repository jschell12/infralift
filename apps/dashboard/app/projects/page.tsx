"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  isGitHost,
  PROVIDER_LABELS,
  type GitHost,
  type CodegenProject,
  type DriftStatus,
  type ImportedProject,
  type MigrationSummary,
  type Project,
  type ProviderConnectionSummary,
  type StackProject,
} from "@infralift/shared";
import { api, errorText, siteUrl } from "../../lib/api";
import { AssessPanel } from "../../components/assess-panel";
import { ImportCheckStatus, ImportPanel } from "../../components/import-panel";
import { MigrationCard } from "../../components/migration-card";
import {
  CARD,
  Chip,
  Drawer,
  ErrorState,
  INPUT,
  LABEL,
  MONO,
  Note,
  PrimaryButton,
  SkeletonCards,
  type Tone,
  SMALL_BTN,
} from "../../components/ui";

// Projects: an app and where it runs, kept as code in a repository. A project
// starts one of three ways:
//   - from a template: pick an app and a target, and infralift opens a pull
//     request with the infrastructure, server scripts and CI (a stack);
//   - from existing infrastructure: assess a connected account, pick a target
//     on the assessment's options page, and infralift generates the code for
//     it (codegen);
//   - from a Terraform repo: scan a repository for root modules and import one
//     behind a read-only plan check that must change nothing (imported).
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
  runtime: { slug: string; name: string };
  deliveries: { slug: string; name: string; gitHost: GitHost }[];
  gitHosts: GitHost[];
  inputSchema: InputSchema;
  example: Settings;
}

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

interface StackFile {
  path: string;
  ownership: "managed" | "seed";
}

type Settings = Record<string, string | number | boolean>;

// Targets on the roadmap, shown so the shape of the product is visible. Only
// targets with a stack behind them can be picked.
// Layers that have options on the roadmap but no stack behind them yet. Each
// says what holds it back, so the dashboard shows the shape of the product
// and the rule, not just a greyed-out word.
const ROADMAP_RUNTIMES = [
  { slug: "kubernetes", name: "Kubernetes", why: "coming: k3s on Hetzner first" },
  { slug: "nomad", name: "Nomad", why: "coming" },
  { slug: "ecs", name: "AWS ECS", why: "coming, with the AWS target" },
  { slug: "serverless", name: "Serverless", why: "needs a serverless-shaped template" },
];
const ROADMAP_DELIVERIES = [
  { slug: "jenkins", name: "Jenkins", why: "coming: needs a Jenkins connection" },
  { slug: "argo", name: "Argo CD", why: "needs a Kubernetes runtime" },
];

const ROADMAP_TARGETS = [
  { slug: "aws", name: "AWS" },
  { slug: "gcp", name: "Google Cloud" },
  { slug: "digitalocean", name: "DigitalOcean" },
  { slug: "azure", name: "Azure" },
];

// The state backend has its own control; the generic settings form skips it.
/** Form-only key for the chosen Terraform Cloud connection. It is sent as
 *  tfcConnectionId, not as a stack setting; the API fills tfc_organization
 *  from the connection. */
const TFC_CONNECTION = "__tfc_connection";

const BACKEND_KEYS = new Set(["backend", "tfc_organization", "tfc_workspace", TFC_CONNECTION]);

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

function toValues(settings: Record<string, unknown> | undefined): Record<string, string> {
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
            <label htmlFor={`setting-${key}`} className={LABEL}>
              {label(key)}
              {required.has(key) ? " *" : ""}
            </label>
            {prop.enum ? (
              <select
                id={`setting-${key}`}
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
                id={`setting-${key}`}
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
  // The org's Terraform Cloud connections (Connections, "Connect Terraform
  // Cloud"). The workspace goes in the chosen one's organization.
  const [tfcConns, setTfcConns] = useState<ProviderConnectionSummary[] | null>(null);
  useEffect(() => {
    api<ProviderConnectionSummary[]>("/connections")
      .then((c) => setTfcConns(c.filter((x) => String(x.provider) === "tfc")))
      .catch(() => setTfcConns([]));
  }, []);
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
      <div id="proj-backend-label" className={LABEL}>State backend</div>
      <div role="group" aria-labelledby="proj-backend-label" className="grid grid-cols-2 gap-2">
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
            <label htmlFor="proj-tfc-connection" className={LABEL}>Terraform Cloud connection *</label>
            {tfcConns && tfcConns.length === 0 ? (
              <div className="text-xs text-muted pt-2">
                None yet. <a className="text-accent" href="/connections">Connect Terraform Cloud</a> first.
              </div>
            ) : (
              <select
                id="proj-tfc-connection"
                className={INPUT}
                value={values[TFC_CONNECTION] ?? ""}
                onChange={(e) => onChange({ ...values, [TFC_CONNECTION]: e.target.value })}
              >
                <option value="">Pick one</option>
                {(tfcConns ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                    {c.status !== "valid" ? ` (${c.status})` : ""}
                  </option>
                ))}
              </select>
            )}
          </div>
          <div>
            <label htmlFor="proj-workspace" className={LABEL}>Workspace</label>
            <input id="proj-workspace"
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
  return values.backend === "tfc" && !values[TFC_CONNECTION]
    ? "Terraform Cloud needs a connection: the workspace goes in its organization."
    : null;
}

function tfcConnectionOf(values: Record<string, string>): string | null {
  return values.backend === "tfc" ? values[TFC_CONNECTION] || null : null;
}

/** Settings sent for the chosen backend only: switching back to R2 must not
 *  carry a stale Terraform Cloud org along. */
function withBackend(values: Record<string, string>): Record<string, string> {
  const v: Record<string, string> = { ...values, backend: values.backend || "r2" };
  delete v[TFC_CONNECTION];
  // Always the connection's organization, filled in by the API.
  delete v.tfc_organization;
  if (v.backend !== "tfc") delete v.tfc_workspace;
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
            , and <b>{seed.length}</b> that are yours once they exist in your repo (
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
      <div className={`${MONO} text-xs leading-5 max-h-48 overflow-y-auto`}>
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

type Start = "template" | "existing" | "import";

const BACKEND_NAMES: Record<string, string> = {
  s3: "S3",
  r2: "R2",
  gcs: "GCS",
  azurerm: "Azure Storage",
};

function NewProjectDrawer({
  stacks,
  start,
  highlight,
  onClose,
  onCreated,
}: {
  stacks: Stack[];
  start: Start;
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
  // Where the project's code lives. A new repository is created from the
  // template's repo (app code) and then gets the infrastructure as a PR/MR.
  const [gitConns, setGitConns] = useState<ProviderConnectionSummary[]>([]);
  const [connectionId, setConnectionId] = useState("");
  const [newRepo, setNewRepo] = useState(true);
  const [owner, setOwner] = useState("");
  const [repoName, setRepoName] = useState("");
  const [existingRepo, setExistingRepo] = useState("");
  const [destBranch, setDestBranch] = useState("main");
  useEffect(() => {
    api<ProviderConnectionSummary[]>("/connections")
      .then((all) => {
        const git = all.filter((c) => isGitHost(c.provider) && c.status === "valid");
        setGitConns(git);
        if (git[0]) setConnectionId(git[0].id);
      })
      .catch(() => {});
  }, []);
  const conn = gitConns.find((c) => c.id === connectionId);
  const gitHost = (conn?.provider ?? "github") as GitHost;
  const destRepo = newRepo ? (owner && (repoName || name) ? `${owner}/${repoName || name}` : "") : existingRepo;
  // Delivery follows the repository's host: GitHub Actions on GitHub, GitLab
  // CI on GitLab. That is the compatibility rule the API enforces too.
  const delivery = stack?.deliveries.find((d) => d.gitHost === gitHost);
  const hostSupported = !!delivery;
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
          delivery: delivery?.slug ?? "",
          ...(gitHost === "gitlab"
            ? { gitlab_project: destRepo }
            : { github_repository: values.github_repository || destRepo.split("/").pop() || "" }),
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
        body: JSON.stringify({ arguments: settings, tfcConnectionId: tfcConnectionOf(values) }),
      });
      setPreview(out.files);
    } catch (e) {
      setPreview(null);
      setError(errorText(e));
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
        body: JSON.stringify({
          name,
          destRepo,
          destBranch: newRepo ? "main" : destBranch,
          gitHost,
          connectionId,
          createRepo: newRepo,
          tfcConnectionId: tfcConnectionOf(values),
          arguments: settings,
        }),
      });
      onCreated();
    } catch (e) {
      setError(errorText(e));
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
      <div className="grid grid-cols-3 gap-1 rounded-lg bg-bg p-1 mb-5">
        {(
          [
            ["template", "From a template"],
            ["existing", "From a cloud account"],
            ["import", "From a Terraform repo"],
          ] as const
        ).map(([key, text]) => (
          <button
            key={key}
            type="button"
            onClick={() => setMode(key)}
            className={`min-h-11 rounded-md px-2 py-2 text-[13px] font-semibold active:text-text ${mode === key ? "bg-surface text-text" : "text-muted hover:text-text"}`}
          >
            {text}
          </button>
        ))}
      </div>

      {mode === "import" ? (
        <ImportPanel onCreated={onCreated} />
      ) : mode === "existing" ? (
        <AssessPanel highlight={highlight} />
      ) : (
      <>
      <div id="proj-template-label" className={LABEL}>App template</div>
      <div role="group" aria-labelledby="proj-template-label" className="grid gap-2 mb-5">
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
            <div className={`text-xs text-faint mt-1 ${MONO}`}>{t.repo}</div>
          </button>
        ))}
      </div>

      <div id="proj-target-label" className={LABEL}>Target</div>
      <div role="group" aria-labelledby="proj-target-label" className="flex flex-wrap gap-2 mb-5">
        {targets.map((s) => (
          <button
            key={s.slug}
            type="button"
            onClick={() => {
              setStackSlug(s.slug);
              setPreview(null);
            }}
            className={`inline-flex min-h-11 items-center rounded-full px-3 text-xs font-semibold border active:bg-bg ${stackSlug === s.slug ? "border-accent text-accent" : "border-border text-muted"}`}
          >
            {s.target.name}
          </button>
        ))}
        {ROADMAP_TARGETS.filter((r) => !targets.some((s) => s.target.slug === r.slug)).map(
          (r) => (
            <span
              key={r.slug}
              className="rounded-full px-3 py-1.5 text-xs border border-border text-faint cursor-not-allowed"
            >
              {r.name}: coming soon
            </span>
          )
        )}
      </div>

      {stack && (
        <>
          <div className="mb-4">
            <label htmlFor="proj-project-name" className={LABEL}>Project name *</label>
            <input id="proj-project-name"
              className={INPUT}
              placeholder="acme-web"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <label htmlFor="proj-git-connection" className={LABEL}>Repository *</label>
          {gitConns.length === 0 ? (
            <div className="mb-4">
              <Note>
                Connect <a href="/connections?provider=github">GitHub</a> or{" "}
                <a href="/connections?provider=gitlab">GitLab</a> first. The project&apos;s app
                code and infrastructure live in a repository there.
              </Note>
            </div>
          ) : (
            <div className="mb-4">
              <div className="flex gap-2 mb-2">
                <select
                  id="proj-git-connection"
                  className={INPUT}
                  value={connectionId}
                  onChange={(e) => setConnectionId(e.target.value)}
                >
                  {gitConns.map((c) => (
                    <option key={c.id} value={c.id}>
                      {PROVIDER_LABELS[c.provider]} · {c.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-1 rounded-lg bg-bg p-1 mb-2">
                {(
                  [
                    [true, "Create a new repository"],
                    [false, "Use an existing one"],
                  ] as const
                ).map(([v, text]) => (
                  <button
                    key={String(v)}
                    type="button"
                    onClick={() => setNewRepo(v)}
                    className={`min-h-11 rounded-md px-2 py-1.5 text-[13px] font-semibold active:text-text ${newRepo === v ? "bg-surface text-text" : "text-muted hover:text-text"}`}
                  >
                    {text}
                  </button>
                ))}
              </div>
              {newRepo ? (
                <>
                  <div className="grid grid-cols-2 gap-2">
                    <input
                      className={`${INPUT} ${MONO}`}
                      placeholder={gitHost === "gitlab" ? "group or group/subgroup" : "owner or org"}
                      value={owner}
                      onChange={(e) => setOwner(e.target.value)}
                    />
                    <input
                      className={`${INPUT} ${MONO}`}
                      placeholder={name || "repo name"}
                      value={repoName}
                      onChange={(e) => setRepoName(e.target.value)}
                    />
                  </div>
                  <div className="text-xs text-faint mt-1">
                    Private, created from {stack.template.repo}; the infrastructure then arrives as a{" "}
                    {gitHost === "gitlab" ? "merge request" : "pull request"}.
                  </div>
                </>
              ) : (
                <div className="grid grid-cols-[1fr_120px] gap-2">
                  <input
                    className={`${INPUT} ${MONO}`}
                    placeholder={gitHost === "gitlab" ? "group/project" : "owner/repo"}
                    value={existingRepo}
                    onChange={(e) => setExistingRepo(e.target.value)}
                  />
                  <input
                    className={INPUT}
                    value={destBranch}
                    onChange={(e) => setDestBranch(e.target.value)}
                  />
                </div>
              )}
              {!hostSupported && (
                <div className="text-xs text-warn mt-2">
                  {stack.name} has no delivery that runs on {PROVIDER_LABELS[gitHost]}.
                </div>
              )}
            </div>
          )}
          <div className={LABEL}>Runtime</div>
          <div className="flex flex-wrap gap-2 mb-4">
            <span className="rounded-full px-3 py-1.5 text-xs font-semibold border border-accent text-accent">
              {stack.runtime.name}
            </span>
            {ROADMAP_RUNTIMES.map((r) => (
              <span
                key={r.slug}
                className="rounded-full px-3 py-1.5 text-xs border border-border text-faint cursor-not-allowed"
              >
                {r.name}: {r.why}
              </span>
            ))}
          </div>
          <div className={LABEL}>Delivery</div>
          <div className="flex flex-wrap gap-2 mb-1">
            {stack.deliveries.map((d) => (
              <span
                key={d.slug}
                className={`rounded-full px-3 py-1.5 text-xs border ${d.gitHost === gitHost ? "border-accent text-accent font-semibold" : "border-border text-faint cursor-not-allowed"}`}
              >
                {d.name}
                {d.gitHost === gitHost ? "" : `: needs a ${PROVIDER_LABELS[d.gitHost]} repository`}
              </span>
            ))}
            {ROADMAP_DELIVERIES.map((r) => (
              <span
                key={r.slug}
                className="rounded-full px-3 py-1.5 text-xs border border-border text-faint cursor-not-allowed"
              >
                {r.name}: {r.why}
              </span>
            ))}
          </div>
          <div className="text-xs text-faint mb-4">
            Follows the repository: {delivery ? `${delivery.name} on ${PROVIDER_LABELS[gitHost]}` : "none for this host"}.
          </div>
          <SettingsFields
            schema={stack.inputSchema}
            values={values}
            hide={["name", "github_repository", "gitlab_project", "delivery"]}
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
              className="min-h-11 rounded-lg border border-border px-4 py-3 text-sm font-semibold text-muted hover:text-text active:bg-border"
            >
              Preview files
            </button>
            <PrimaryButton
              onClick={create}
              disabled={busy || !name || !destRepo || !connectionId || !hostSupported}
            >
              {busy
                ? "Working..."
                : newRepo
                  ? "Create repository"
                  : gitHost === "gitlab"
                    ? "Open merge request"
                    : "Open pull request"}
            </PrimaryButton>
          </div>
        </>
      )}
      </>
      )}
    </Drawer>
  );
}

const DRIFT_LOOK: Record<DriftStatus["state"], { tone: Tone; text: string }> = {
  drift: { tone: "danger", text: "drift detected" },
  none: { tone: "accent", text: "no drift" },
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
        <a className="ml-auto text-accent text-sm font-semibold whitespace-nowrap" href={drift.checkUrl}>
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
  const [creating, setCreating] = useState<null | { start: Start; highlight: string | null }>(null);
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

  // /projects?start=existing and /projects?assess=<connectionId> (from
  // Connections, and where /assessments now redirects) open the drawer on the
  // existing-infrastructure path.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const assess = q.get("assess");
    if (q.get("start") === "import") {
      setCreating({ start: "import", highlight: null });
    } else if (assess || q.get("start") === "existing") {
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

      {error && (
        <div className="mb-4">
          <ErrorState message={error} onRetry={firstLoad} />
        </div>
      )}

      {!loaded && !error && <SkeletonCards count={2} label="Loading projects" />}

      {loaded && projects.length === 0 && migrations.length === 0 && !error && (
        <div className={`${CARD} mb-4`}>
          <h3 className="text-base font-semibold mb-1.5">No projects yet</h3>
          <p className="text-muted text-sm">
            Start from an app template and a target, assess a cloud account you already run,
            or import a Terraform repository without touching what is running.
          </p>
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
                <Chip tone="info">
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
                <Chip tone="info">imported</Chip>
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
                <Chip tone="info">
                  {stack.template.name} on {stack.target.name}
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
