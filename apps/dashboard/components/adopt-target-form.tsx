"use client";

// Where adopted resources go, on /projects/new/adopt: always a new project
// (the API refuses an existing one for now, ADR 0011), in a GitHub
// repository, with its state in an R2 or S3 bucket the customer owns.
//
// Not the shared BackendPicker from stack-settings.tsx: that one offers
// Terraform Cloud, and POST /connections/:id/adopt accepts only an s3 or r2
// backend, so offering it here would be a choice the request cannot carry.

import { PROVIDER_LABELS, type ProviderConnectionSummary } from "@infralift/shared";
import type { AdoptForm } from "../lib/adopt-account";
import { INPUT, LABEL, MONO, Note } from "./ui";

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-text";

const BACKENDS: { key: AdoptForm["backendKind"]; title: string; body: string }[] = [
  { key: "r2", title: "Cloudflare R2", body: "State in an R2 bucket in your Cloudflare account." },
  { key: "s3", title: "AWS S3", body: "State in an S3 bucket in your AWS account." },
];

function Field({
  id,
  label,
  value,
  onChange,
  placeholder,
  mono = false,
  hint,
  autoComplete = "off",
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
  hint?: string;
  autoComplete?: string;
}) {
  return (
    <div>
      <label htmlFor={id} className={LABEL}>
        {label}
      </label>
      <input
        id={id}
        className={`${INPUT} ${mono ? MONO : ""}`}
        value={value}
        placeholder={placeholder}
        autoComplete={autoComplete}
        spellCheck={false}
        aria-describedby={hint ? `${id}-hint` : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
      {hint && (
        <div id={`${id}-hint`} className="mt-1 text-xs text-muted">
          {hint}
        </div>
      )}
    </div>
  );
}

export function AdoptTargetForm({
  form,
  onChange,
  gitConnections,
}: {
  form: AdoptForm;
  onChange: (next: AdoptForm) => void;
  /** Valid GitHub connections of the org. The select shows only when there is more than one. */
  gitConnections: ProviderConnectionSummary[];
}) {
  const set = <K extends keyof AdoptForm>(key: K) => (value: AdoptForm[K]) => onChange({ ...form, [key]: value });

  return (
    <div className="flex flex-col gap-4">
      <Field
        id="adopt-name"
        label="Project name"
        value={form.name}
        onChange={set("name")}
        hint="3 to 32 lowercase letters, digits and dashes."
      />

      {gitConnections.length === 0 ? (
        <Note>
          Connect <a href="/connections/new?type=github">GitHub</a> first. The adoption arrives there as a pull request
          you review and merge.
        </Note>
      ) : (
        <>
          {gitConnections.length > 1 && (
            <div>
              <label htmlFor="adopt-git-connection" className={LABEL}>
                GitHub connection
              </label>
              <select
                id="adopt-git-connection"
                className={INPUT}
                value={form.gitConnectionId}
                onChange={(e) => set("gitConnectionId")(e.target.value)}
              >
                {gitConnections.map((c) => (
                  <option key={c.id} value={c.id}>
                    {PROVIDER_LABELS[c.provider]} · {c.label}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_140px]">
            <Field
              id="adopt-repo"
              label="Repository"
              value={form.repo}
              onChange={set("repo")}
              placeholder="owner/name"
              mono
            />
            <Field id="adopt-branch" label="Branch" value={form.branch} onChange={set("branch")} />
          </div>
          <Field
            id="adopt-path"
            label="Directory"
            value={form.path}
            onChange={set("path")}
            mono
            hint="Where the project's Terraform goes in the repository."
          />
        </>
      )}

      <div>
        <div id="adopt-backend-label" className={LABEL}>
          State backend
        </div>
        <div role="group" aria-labelledby="adopt-backend-label" className="grid grid-cols-2 gap-2">
          {BACKENDS.map((b) => (
            <button
              key={b.key}
              type="button"
              aria-pressed={form.backendKind === b.key}
              onClick={() => set("backendKind")(b.key)}
              className={`min-h-11 cursor-pointer rounded-lg border p-3 text-left ${form.backendKind === b.key ? "border-text bg-surface" : "border-border bg-bg hover:border-muted"} ${FOCUS}`}
            >
              <span className="block text-sm font-semibold">{b.title}</span>
              <span className="mt-1 block text-xs text-muted">{b.body}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field
          id="adopt-bucket"
          label="Bucket"
          value={form.bucket}
          onChange={set("bucket")}
          placeholder="acme-terraform-state"
          mono
        />
        <Field id="adopt-state-key" label="State key" value={form.stateKey} onChange={set("stateKey")} mono />
      </div>
      {form.backendKind === "r2" ? (
        <Field
          id="adopt-account-id"
          label="Cloudflare account id"
          value={form.accountId}
          onChange={set("accountId")}
          placeholder="32 hex characters"
          mono
        />
      ) : (
        <Field id="adopt-region" label="Region" value={form.region} onChange={set("region")} mono />
      )}
    </div>
  );
}
