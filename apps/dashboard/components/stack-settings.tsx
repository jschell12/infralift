"use client";

// The stack settings form, the state backend picker and the file preview.
// Shared by /projects/new (starting a project from a stack) and the settings
// drawer of an existing stack project on /projects.

import { useEffect, useState } from "react";
import type { ProviderConnectionSummary } from "@infralift/shared";
import { api } from "../lib/api";
import { TFC } from "../lib/connections";
import { BACKEND_KEYS, TFC_CONNECTION, type InputSchema } from "../lib/stacks";
import { INPUT, LABEL, MONO, Note } from "./ui";

export interface StackFile {
  path: string;
  ownership: "managed" | "seed";
}

const label = (key: string) =>
  key.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

export function SettingsFields({
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

export function BackendPicker({
  values,
  onChange,
}: {
  values: Record<string, string>;
  onChange: (v: Record<string, string>) => void;
}) {
  const backend = values.backend || "r2";
  // The org's Terraform Cloud connections (Connections, type Terraform
  // Cloud). The workspace goes in the chosen one's organization.
  const [tfcConns, setTfcConns] = useState<ProviderConnectionSummary[] | null>(null);
  useEffect(() => {
    api<ProviderConnectionSummary[]>("/connections")
      .then((c) => setTfcConns(c.filter((x) => String(x.provider) === TFC)))
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
            className={`text-left rounded-lg border p-3 ${backend === o.key ? "border-text bg-surface" : "border-border bg-bg hover:border-muted"}`}
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
                None yet. <a className="text-text underline" href="/connections/new?type=tfc">Connect Terraform Cloud</a> first.
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

export function FilePreview({ files }: { files: StackFile[] }) {
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
          <div key={f.path} className={f.ownership === "seed" ? "font-semibold text-text" : ""}>
            {f.path}
          </div>
        ))}
      </div>
    </Note>
  );
}
