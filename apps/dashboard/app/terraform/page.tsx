"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { api, DEV_ORG_ID } from "../../lib/api";

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

interface TfProject {
  id: string;
  name: string;
  destRepo: string;
  destPath: string;
  destBranch: string;
  templateVersion: { releaseTag: string; template: { slug: string } };
  renderings: {
    id: string;
    fileName: string;
    commitSha: string | null;
    createdAt: string;
  }[];
}

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
  success: "badge-ok",
  errored: "badge-bad",
  running: "badge-warn",
  pending: "badge-muted",
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
          <label>
            {key}
            {required.has(key) ? " *" : " (optional)"}
          </label>
          {prop.enum ? (
            <select
              value={String(values[key] ?? "")}
              onChange={(e) => onChange({ ...values, [key]: e.target.value })}
            >
              <option value="">— select —</option>
              {prop.enum.map((v) => (
                <option key={String(v)} value={String(v)}>
                  {String(v)}
                </option>
              ))}
            </select>
          ) : prop.type === "boolean" ? (
            <select
              value={String(values[key] ?? "")}
              onChange={(e) => onChange({ ...values, [key]: e.target.value })}
            >
              <option value="">— select —</option>
              <option value="true">true</option>
              <option value="false">false</option>
            </select>
          ) : (
            <input
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

function Drawer({
  title,
  subtitle,
  onClose,
  children,
}: {
  title: string;
  subtitle: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <>
      <div className="drawer-overlay" onClick={onClose} />
      <div className="drawer">
        <h2>{title}</h2>
        <div className="drawer-sub">{subtitle}</div>
        {children}
      </div>
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
    const rows = await api<TfProject[]>(`/tf/projects?orgId=${DEV_ORG_ID}`);
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
          orgId: DEV_ORG_ID,
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
      <h1>Terraform generation</h1>
      <p className="lead">
        Render versioned Terraform templates into your repo. Each job
        validates inputs, commits the generated file, and prepares a TF Cloud
        workspace.
      </p>

      {error && <div className="error">{error}</div>}

      <div className="card">
        <h3>Templates</h3>
        <table>
          <thead>
            <tr>
              <th>Template</th>
              <th>Versions</th>
              <th>Description</th>
            </tr>
          </thead>
          <tbody>
            {templates.map((t) => (
              <tr key={t.id}>
                <td>
                  <code>{t.slug}</code>
                </td>
                <td>{t.versions.map((v) => v.releaseTag).join(", ")}</td>
                <td>{t.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h3>Projects</h3>
        {projects.length === 0 ? (
          <p>
            No projects yet. A project binds a template version to a
            destination repo.
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Project</th>
                <th>Template</th>
                <th>Destination</th>
                <th>Renderings</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {projects.map((p) => (
                <tr key={p.id}>
                  <td>{p.name}</td>
                  <td>
                    <code>
                      {p.templateVersion.template.slug}@
                      {p.templateVersion.releaseTag}
                    </code>
                  </td>
                  <td>
                    {p.destRepo}
                    {p.destPath ? `/${p.destPath}` : ""} ({p.destBranch})
                  </td>
                  <td>{p.renderings.length}</td>
                  <td>
                    <button
                      className="btn btn-secondary"
                      style={{ marginTop: 0 }}
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
          className="btn btn-primary"
          onClick={() => setShowNewProject(true)}
        >
          New project
        </button>
      </div>

      <div className="card">
        <h3>Jobs</h3>
        {projects.length > 1 && (
          <>
            <label>Project</label>
            <select
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
          <p>No jobs yet for this project.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Stage</th>
                <th>Status</th>
                <th>Message</th>
                <th>Workspace</th>
                <th>Started</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.id}>
                  <td>
                    <code>{j.stage}</code>
                  </td>
                  <td>
                    <span
                      className={`badge ${STATUS_BADGE[j.status] ?? "badge-muted"}`}
                    >
                      {j.status}
                    </span>
                  </td>
                  <td>{j.statusMessage || "—"}</td>
                  <td>{j.workspaceName ?? "—"}</td>
                  <td>{new Date(j.createdAt).toLocaleString()}</td>
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
            <label>Project name * (lowercase, digits, dashes)</label>
            <input
              value={pName}
              onChange={(e) => setPName(e.target.value)}
              required
              pattern="[a-z0-9-]+"
              maxLength={32}
            />
            <label>Template *</label>
            <select
              value={pTemplateSlug}
              onChange={(e) => {
                setPTemplateSlug(e.target.value);
                setPReleaseTag("");
              }}
              required
            >
              <option value="">— select —</option>
              {templates.map((t) => (
                <option key={t.slug} value={t.slug}>
                  {t.name}
                </option>
              ))}
            </select>
            <label>Version *</label>
            <select
              value={pReleaseTag}
              onChange={(e) => setPReleaseTag(e.target.value)}
              required
              disabled={!selectedTemplate}
            >
              <option value="">— select —</option>
              {selectedTemplate?.versions.map((v) => (
                <option key={v.releaseTag} value={v.releaseTag}>
                  {v.releaseTag}
                </option>
              ))}
            </select>
            <label>Destination repo * (owner/repo)</label>
            <input
              value={pDestRepo}
              onChange={(e) => setPDestRepo(e.target.value)}
              required
              placeholder="acme/infrastructure"
            />
            <label>Destination path</label>
            <input
              value={pDestPath}
              onChange={(e) => setPDestPath(e.target.value)}
            />
            <label>Branch</label>
            <input
              value={pDestBranch}
              onChange={(e) => setPDestBranch(e.target.value)}
            />
            <label>AWS region</label>
            <input
              value={pRegion}
              onChange={(e) => setPRegion(e.target.value)}
            />
            <button className="btn btn-primary" disabled={busy}>
              {busy ? "Creating…" : "Create project"}
            </button>
          </form>
        </Drawer>
      )}

      {runProject && runVersion && (
        <Drawer
          title={`Run job — ${runProject.name}`}
          subtitle={`${runProject.templateVersion.template.slug}@${runProject.templateVersion.releaseTag} → ${runProject.destRepo}`}
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
              className="btn btn-secondary"
              disabled={busy}
              onClick={previewRender}
            >
              Preview
            </button>{" "}
            <button className="btn btn-primary" disabled={busy}>
              {busy ? "Working…" : "Launch job"}
            </button>
          </form>
          {preview && <pre>{preview}</pre>}
        </Drawer>
      )}
    </>
  );
}
