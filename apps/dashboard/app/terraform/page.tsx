"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Project, TemplateProject } from "@infralift/shared";
import { api } from "../../lib/api";
import { Drawer } from "../../components/ui";

// -- API shapes ---------------------------------------------------------------

interface SchemaProperty {
  type?: string;
  enum?: (string | number)[];
  pattern?: string;
  minimum?: number;
  maximum?: number;
}

interface InputSchema {
  properties?: Record<string, SchemaProperty>;
  required?: string[];
}

interface TemplateVersion {
  id: string;
  releaseTag: string;
  inputSchema: InputSchema;
  createdAt: string;
}

interface TfTemplate {
  id: string;
  slug: string;
  name: string;
  description: string;
  versions: TemplateVersion[];
}

// Template projects only; the API returns every kind (@infralift/shared).
type TfProject = TemplateProject;

interface TfJob {
  id: string;
  stage: string;
  status: string;
  statusMessage: string;
  workspaceName: string | null;
  createdAt: string;
}

type ArgValues = Record<string, string | boolean>;

const STATUS_BADGE: Record<string, string> = {
  success: "inline-block px-2.5 py-0.5 rounded-full text-xs font-semibold bg-accent-dim text-accent",
  errored: "inline-block px-2.5 py-0.5 rounded-full text-xs font-semibold bg-danger/20 text-danger",
  running: "inline-block px-2.5 py-0.5 rounded-full text-xs font-semibold bg-warn/20 text-warn",
  pending: "inline-block px-2.5 py-0.5 rounded-full text-xs font-semibold bg-border text-muted",
};

function coerceArguments(
  schema: InputSchema,
  values: ArgValues
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    const raw = values[key];
    if (raw === undefined || raw === "") continue;
    if (prop.type === "boolean") out[key] = raw === true || raw === "true";
    else if (prop.type === "integer" || prop.type === "number")
      out[key] = Number(raw);
    else out[key] = String(raw);
  }
  return out;
}

function ArgumentFields({
  schema,
  values,
  onChange,
}: {
  schema: InputSchema;
  values: ArgValues;
  onChange: (v: ArgValues) => void;
}) {
  const required = new Set(schema.required ?? []);
  return (
    <>
      {Object.entries(schema.properties ?? {}).map(([key, prop]) => (
        <div key={key}>
          <label className="block text-sm font-semibold text-muted mt-3.5 mb-1">
            {key}
            {required.has(key) ? " *" : " (optional)"}
          </label>
          {prop.enum ? (
            <select
              className="w-full bg-bg border border-border rounded-lg px-3 py-2 text-text text-sm mb-4 focus:outline-none focus:border-accent"
              value={String(values[key] ?? "")}
              onChange={(e) => onChange({ ...values, [key]: e.target.value })}
            >
              <option value="">Select...</option>
              {prop.enum.map((v) => (
                <option key={String(v)} value={String(v)}>
                  {String(v)}
                </option>
              ))}
            </select>
          ) : prop.type === "boolean" ? (
            <select
              className="w-full bg-bg border border-border rounded-lg px-3 py-2 text-text text-sm mb-4 focus:outline-none focus:border-accent"
              value={String(values[key] ?? "")}
              onChange={(e) => onChange({ ...values, [key]: e.target.value })}
            >
              <option value="">Select...</option>
              <option value="true">true</option>
              <option value="false">false</option>
            </select>
          ) : (
            <input
              className="w-full bg-bg border border-border rounded-lg px-3 py-2 text-text text-sm mb-4 focus:outline-none focus:border-accent"
              type={
                prop.type === "integer" || prop.type === "number"
                  ? "number"
                  : "text"
              }
              value={String(values[key] ?? "")}
              onChange={(e) => onChange({ ...values, [key]: e.target.value })}
            />
          )}
        </div>
      ))}
    </>
  );
}

export default function TerraformPage() {
  const [templates, setTemplates] = useState<TfTemplate[]>([]);
  const [projects, setProjects] = useState<TfProject[]>([]);
  const [jobs, setJobs] = useState<TfJob[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Drawers
  const [showNewProject, setShowNewProject] = useState(false);
  const [runProject, setRunProject] = useState<TfProject | null>(null);

  // New-project form
  const [pName, setPName] = useState("");
  const [pTemplateSlug, setPTemplateSlug] = useState("");
  const [pReleaseTag, setPReleaseTag] = useState("");
  const [pDestRepo, setPDestRepo] = useState("");
  const [pDestPath, setPDestPath] = useState("terraform");
  const [pDestBranch, setPDestBranch] = useState("main");
  const [pRegion, setPRegion] = useState("us-east-1");

  // Run-job form
  const [argValues, setArgValues] = useState<ArgValues>({});
  const [preview, setPreview] = useState<string | null>(null);

  const loadTemplates = useCallback(async () => {
    setTemplates(await api<TfTemplate[]>("/tf/templates"));
  }, []);

  const loadProjects = useCallback(async () => {
    const rows = (await api<Project[]>(`/tf/projects`)).filter((p): p is TfProject => p.kind === "template");
    setProjects(rows);
    setSelectedProjectId((cur) => cur || rows[0]?.id || "");
  }, []);

  const loadJobs = useCallback(async (projectId: string) => {
    if (!projectId) return setJobs([]);
    setJobs(await api<TfJob[]>(`/tf/jobs?projectId=${projectId}`));
  }, []);

  useEffect(() => {
    Promise.all([loadTemplates(), loadProjects()]).catch((e) =>
      setError(e instanceof Error ? e.message : String(e))
    );
  }, [loadTemplates, loadProjects]);

  useEffect(() => {
    loadJobs(selectedProjectId).catch(() => {});
  }, [selectedProjectId, loadJobs]);

  // Poll while any job is still moving through the pipeline.
  useEffect(() => {
    const active = jobs.some(
      (j) => j.status === "pending" || j.status === "running"
    );
    if (!active || !selectedProjectId) return;
    const t = setInterval(() => {
      loadJobs(selectedProjectId).catch(() => {});
      loadProjects().catch(() => {});
    }, 3000);
    return () => clearInterval(t);
  }, [jobs, selectedProjectId, loadJobs, loadProjects]);

  const selectedTemplate = templates.find((t) => t.slug === pTemplateSlug);
  const runVersion = useMemo(() => {
    if (!runProject) return null;
    const tpl = templates.find(
      (t) => t.slug === runProject.templateVersion.template.slug
    );
    return (
      tpl?.versions.find(
        (v) => v.releaseTag === runProject.templateVersion.releaseTag
      ) ?? null
    );
  }, [runProject, templates]);

  async function createProject(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/tf/projects", {
        method: "POST",
        body: JSON.stringify({
          name: pName,
          templateSlug: pTemplateSlug,
          releaseTag: pReleaseTag,
          destRepo: pDestRepo,
          destPath: pDestPath,
          destBranch: pDestBranch,
          providerConfig: {
            name: "aws",
            source: "hashicorp/aws",
            version: "~> 5.0",
            region: pRegion,
          },
        }),
      });
      setShowNewProject(false);
      setPName("");
      await loadProjects();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function previewRender() {
    if (!runProject || !runVersion) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ rendered: string }>(
        `/tf/templates/${runProject.templateVersion.template.slug}/versions/${runProject.templateVersion.releaseTag}/preview`,
        {
          method: "POST",
          body: JSON.stringify({
            arguments: coerceArguments(runVersion.inputSchema, argValues),
          }),
        }
      );
      setPreview(res.rendered);
    } catch (err) {
      setPreview(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function launchJob(e: React.FormEvent) {
    e.preventDefault();
    if (!runProject || !runVersion) return;
    setBusy(true);
    setError(null);
    try {
      await api("/tf/jobs", {
        method: "POST",
        body: JSON.stringify({
          projectId: runProject.id,
          arguments: coerceArguments(runVersion.inputSchema, argValues),
        }),
      });
      setSelectedProjectId(runProject.id);
      setRunProject(null);
      setArgValues({});
      setPreview(null);
      await loadJobs(runProject.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1 className="text-3xl font-bold tracking-tight mb-2">Terraform generation</h1>
      <p className="text-muted mb-8">
        Render versioned Terraform templates into your repo. Each job
        validates inputs, commits the generated file, and prepares a TF Cloud
        workspace.
      </p>

      {error && <div className="text-danger text-sm mt-2">{error}</div>}

      <div className="bg-surface border border-border rounded-xl p-6 mb-4">
        <h3 className="text-base font-semibold mb-1.5">Templates</h3>
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr>
              <th className="text-left p-3 border-b border-border text-muted font-medium text-xs">Template</th>
              <th className="text-left p-3 border-b border-border text-muted font-medium text-xs">Versions</th>
              <th className="text-left p-3 border-b border-border text-muted font-medium text-xs">Description</th>
            </tr>
          </thead>
          <tbody>
            {templates.map((t) => (
              <tr key={t.id}>
                <td className="p-3 border-b border-border">
                  <code className="text-accent font-mono text-xs">{t.slug}</code>
                </td>
                <td className="p-3 border-b border-border">{t.versions.map((v) => v.releaseTag).join(", ")}</td>
                <td className="p-3 border-b border-border">{t.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="bg-surface border border-border rounded-xl p-6 mb-4">
        <h3 className="text-base font-semibold mb-1.5">Projects</h3>
        {projects.length === 0 ? (
          <p className="text-muted text-sm">
            No projects yet. A project binds a template version to a
            destination repo.
          </p>
        ) : (
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr>
                <th className="text-left p-3 border-b border-border text-muted font-medium text-xs">Project</th>
                <th className="text-left p-3 border-b border-border text-muted font-medium text-xs">Template</th>
                <th className="text-left p-3 border-b border-border text-muted font-medium text-xs">Destination</th>
                <th className="text-left p-3 border-b border-border text-muted font-medium text-xs">Renderings</th>
                <th className="text-left p-3 border-b border-border text-muted font-medium text-xs"></th>
              </tr>
            </thead>
            <tbody>
              {projects.map((p) => (
                <tr key={p.id}>
                  <td className="p-3 border-b border-border">{p.name}</td>
                  <td className="p-3 border-b border-border">
                    <code className="text-accent font-mono text-xs">
                      {p.templateVersion.template.slug}@
                      {p.templateVersion.releaseTag}
                    </code>
                  </td>
                  <td className="p-3 border-b border-border">
                    {p.destRepo}
                    {p.destPath ? `/${p.destPath}` : ""} ({p.destBranch})
                  </td>
                  <td className="p-3 border-b border-border">{p.renderings.length}</td>
                  <td className="p-3 border-b border-border">
                    <button
                      className="inline-block px-5 py-2 rounded-lg text-sm font-semibold cursor-pointer border border-border bg-transparent text-text hover:bg-surface"
                      onClick={() => {
                        setRunProject(p);
                        setArgValues({});
                        setPreview(null);
                      }}
                    >
                      Run job
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <button
          className="inline-block mt-4 px-7 py-3 rounded-lg text-base font-semibold cursor-pointer border border-transparent bg-accent text-bg hover:bg-accent/90"
          onClick={() => setShowNewProject(true)}
        >
          New project
        </button>
      </div>

      <div className="bg-surface border border-border rounded-xl p-6 mb-4">
        <h3 className="text-base font-semibold mb-1.5">Jobs</h3>
        {projects.length > 1 && (
          <>
            <label className="block text-sm font-semibold text-muted mt-3.5 mb-1">Project</label>
            <select
              className="w-full bg-bg border border-border rounded-lg px-3 py-2 text-text text-sm mb-4 focus:outline-none focus:border-accent"
              value={selectedProjectId}
              onChange={(e) => setSelectedProjectId(e.target.value)}
            >
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </>
        )}
        {jobs.length === 0 ? (
          <p className="text-muted text-sm">No jobs yet for this project.</p>
        ) : (
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr>
                <th className="text-left p-3 border-b border-border text-muted font-medium text-xs">Stage</th>
                <th className="text-left p-3 border-b border-border text-muted font-medium text-xs">Status</th>
                <th className="text-left p-3 border-b border-border text-muted font-medium text-xs">Message</th>
                <th className="text-left p-3 border-b border-border text-muted font-medium text-xs">Workspace</th>
                <th className="text-left p-3 border-b border-border text-muted font-medium text-xs">Started</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.id}>
                  <td className="p-3 border-b border-border">
                    <code className="text-accent font-mono text-xs">{j.stage}</code>
                  </td>
                  <td className="p-3 border-b border-border">
                    <span
                      className={STATUS_BADGE[j.status] ?? "inline-block px-2.5 py-0.5 rounded-full text-xs font-semibold bg-border text-muted"}
                    >
                      {j.status}
                    </span>
                  </td>
                  <td className="p-3 border-b border-border">{j.statusMessage || "—"}</td>
                  <td className="p-3 border-b border-border">{j.workspaceName ?? "—"}</td>
                  <td className="p-3 border-b border-border">{new Date(j.createdAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {showNewProject && (
        <Drawer
          title="New Terraform project"
          subtitle="Bind a template version to a destination repo. Generated files land under the destination path on the chosen branch."
          onClose={() => setShowNewProject(false)}
        >
          <form onSubmit={createProject}>
            <label className="block text-sm font-semibold text-muted mt-3.5 mb-1">Project name * (lowercase, digits, dashes)</label>
            <input
              className="w-full bg-bg border border-border rounded-lg px-3 py-2 text-text text-sm mb-4 focus:outline-none focus:border-accent"
              value={pName}
              onChange={(e) => setPName(e.target.value)}
              required
              pattern="[a-z0-9-]+"
              maxLength={32}
            />
            <label className="block text-sm font-semibold text-muted mt-3.5 mb-1">Template *</label>
            <select
              className="w-full bg-bg border border-border rounded-lg px-3 py-2 text-text text-sm mb-4 focus:outline-none focus:border-accent"
              value={pTemplateSlug}
              onChange={(e) => {
                setPTemplateSlug(e.target.value);
                setPReleaseTag("");
              }}
              required
            >
              <option value="">Select...</option>
              {templates.map((t) => (
                <option key={t.slug} value={t.slug}>
                  {t.name}
                </option>
              ))}
            </select>
            <label className="block text-sm font-semibold text-muted mt-3.5 mb-1">Version *</label>
            <select
              className="w-full bg-bg border border-border rounded-lg px-3 py-2 text-text text-sm mb-4 focus:outline-none focus:border-accent"
              value={pReleaseTag}
              onChange={(e) => setPReleaseTag(e.target.value)}
              required
              disabled={!selectedTemplate}
            >
              <option value="">Select...</option>
              {selectedTemplate?.versions.map((v) => (
                <option key={v.releaseTag} value={v.releaseTag}>
                  {v.releaseTag}
                </option>
              ))}
            </select>
            <label className="block text-sm font-semibold text-muted mt-3.5 mb-1">Destination repo * (owner/repo)</label>
            <input
              className="w-full bg-bg border border-border rounded-lg px-3 py-2 text-text text-sm mb-4 focus:outline-none focus:border-accent"
              value={pDestRepo}
              onChange={(e) => setPDestRepo(e.target.value)}
              required
              placeholder="acme/infrastructure"
            />
            <label className="block text-sm font-semibold text-muted mt-3.5 mb-1">Destination path</label>
            <input
              className="w-full bg-bg border border-border rounded-lg px-3 py-2 text-text text-sm mb-4 focus:outline-none focus:border-accent"
              value={pDestPath}
              onChange={(e) => setPDestPath(e.target.value)}
            />
            <label className="block text-sm font-semibold text-muted mt-3.5 mb-1">Branch</label>
            <input
              className="w-full bg-bg border border-border rounded-lg px-3 py-2 text-text text-sm mb-4 focus:outline-none focus:border-accent"
              value={pDestBranch}
              onChange={(e) => setPDestBranch(e.target.value)}
            />
            <label className="block text-sm font-semibold text-muted mt-3.5 mb-1">AWS region</label>
            <input
              className="w-full bg-bg border border-border rounded-lg px-3 py-2 text-text text-sm mb-4 focus:outline-none focus:border-accent"
              value={pRegion}
              onChange={(e) => setPRegion(e.target.value)}
            />
            <button
              className="inline-block mt-4 px-7 py-3 rounded-lg text-base font-semibold cursor-pointer border border-transparent bg-accent text-bg hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed"
              disabled={busy}
            >
              {busy ? "Creating..." : "Create project"}
            </button>
          </form>
        </Drawer>
      )}

      {runProject && runVersion && (
        <Drawer
          title={`Run job: ${runProject.name}`}
          subtitle={`${runProject.templateVersion.template.slug}@${runProject.templateVersion.releaseTag} to ${runProject.destRepo}`}
          onClose={() => setRunProject(null)}
        >
          <form onSubmit={launchJob}>
            <ArgumentFields
              schema={runVersion.inputSchema}
              values={argValues}
              onChange={setArgValues}
            />
            <button
              type="button"
              className="inline-block mt-4 px-5 py-2 rounded-lg text-sm font-semibold cursor-pointer border border-border bg-transparent text-text hover:bg-surface mr-2"
              disabled={busy}
              onClick={previewRender}
            >
              Preview
            </button>{" "}
            <button
              className="inline-block mt-4 px-7 py-3 rounded-lg text-base font-semibold cursor-pointer border border-transparent bg-accent text-bg hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed"
              disabled={busy}
            >
              {busy ? "Working..." : "Launch job"}
            </button>
          </form>
          {preview && (
            <pre className="bg-bg border border-border rounded-lg p-3 text-xs overflow-x-auto whitespace-pre mt-4">
              {preview}
            </pre>
          )}
        </Drawer>
      )}
    </>
  );
}
