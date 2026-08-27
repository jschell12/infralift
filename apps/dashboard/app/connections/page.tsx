"use client";

import { useCallback, useEffect, useState } from "react";
import {
  PROVIDERS,
  PROVIDER_LABELS,
  type Provider,
  type ProviderConnectionSummary,
} from "@infralift/shared";
import { api } from "../../lib/api";

const SCOPE_HELP: Record<Provider, React.ReactNode> = {
  vercel: (
    <>
      Create a token at <code className="text-accent font-mono text-xs">vercel.com/account/tokens</code>. Scope it to the
      team you want assessed. Vercel tokens are read/write by scope of your
      role, so use a <code className="text-accent font-mono text-xs">Viewer</code> role member&apos;s token for strict
      read-only.
    </>
  ),
  cloudflare: (
    <>
      Create a token at <code className="text-accent font-mono text-xs">dash.cloudflare.com/profile/api-tokens</code>{" "}
      with read-only permissions: <code className="text-accent font-mono text-xs">Account · Workers Scripts · Read</code>
      , <code className="text-accent font-mono text-xs">Account · Cloudflare Pages · Read</code>,{" "}
      <code className="text-accent font-mono text-xs">Account · Workers R2 Storage · Read</code>,{" "}
      <code className="text-accent font-mono text-xs">Zone · Zone · Read</code>, <code className="text-accent font-mono text-xs">Zone · DNS · Read</code>.
    </>
  ),
  heroku: (
    <>
      Generate an API key at <code className="text-accent font-mono text-xs">dashboard.heroku.com/account</code>{" "}
      (under Account, find API Key) or via{" "}
      <code className="text-accent font-mono text-xs">heroku authorizations:create</code>.
      We only call read endpoints: apps, formation, add-ons.
    </>
  ),
  aws: (
    <>
      Create an IAM role with the AWS-managed <code className="text-accent font-mono text-xs">ReadOnlyAccess</code>{" "}
      policy plus <code className="text-accent font-mono text-xs">ce:GetCostAndUsage</code>, trusted to our account with
      an external ID. Paste the role ARN here (or JSON{" "}
      <code className="text-accent font-mono text-xs">{"{"}&quot;roleArn&quot;, &quot;externalId&quot;{"}"}</code>).
    </>
  ),
  firebase: (
    <>
      Create a service account in{" "}
      <code className="text-accent font-mono text-xs">console.cloud.google.com/iam-admin/serviceaccounts</code> with the{" "}
      <code className="text-accent font-mono text-xs">Viewer</code> role (or granular: <code className="text-accent font-mono text-xs">Firebase Viewer</code>,{" "}
      <code className="text-accent font-mono text-xs">Cloud Functions Viewer</code>, <code className="text-accent font-mono text-xs">Cloud Datastore Viewer</code>),
      generate a JSON key, and paste the full JSON here. We inventory Hosting
      sites, Cloud Functions, and Firestore databases, read-only.
    </>
  ),
  github: (
    <>
      Create a fine-grained personal access token at{" "}
      <code className="text-accent font-mono text-xs">github.com/settings/tokens</code> scoped to the repository that
      will receive generated Terraform, with{" "}
      <code className="text-accent font-mono text-xs">Contents: Read and write</code> permission. Used only to commit
      rendered <code className="text-accent font-mono text-xs">.tf</code> files.
    </>
  ),
  netlify: (
    <>
      Create a personal access token at{" "}
      <code className="text-accent font-mono text-xs">app.netlify.com/user/applications#personal-access-tokens</code>.
      We read sites, forms, DNS zones, and build hooks, all read-only.
    </>
  ),
  render: (
    <>
      Create an API key at <code className="text-accent font-mono text-xs">dashboard.render.com/account/api-keys</code>.
      We read services, databases, Redis instances, and env groups, all
      read-only.
    </>
  ),
  railway: (
    <>
      Create an API token at <code className="text-accent font-mono text-xs">railway.com/account/tokens</code>. We read
      projects, services, plugins (databases), and environments via the GraphQL
      API, all read-only.
    </>
  ),
  flyio: (
    <>
      Create a deploy token or personal access token via{" "}
      <code className="text-accent font-mono text-xs">fly tokens create</code> (CLI) or the Fly.io dashboard. We read
      apps, machines, and volumes, all read-only.
    </>
  ),
  digitalocean: (
    <>
      Create a personal access token at{" "}
      <code className="text-accent font-mono text-xs">cloud.digitalocean.com/account/api/tokens</code> with read-only
      scope. We inventory Droplets, App Platform apps, managed databases,
      Spaces, and Kubernetes clusters.
    </>
  ),
  gcp: (
    <>
      Create a service account in{" "}
      <code className="text-accent font-mono text-xs">console.cloud.google.com/iam-admin/serviceaccounts</code> with the{" "}
      <code className="text-accent font-mono text-xs">Viewer</code> role, generate a JSON key, and paste the full JSON
      here. We inventory Cloud Run, GCE, Cloud SQL, GCS, and Cloud Functions,
      read-only.
    </>
  ),
  azure: (
    <>
      Register an app in Azure AD, create a client secret, and grant{" "}
      <code className="text-accent font-mono text-xs">Reader</code> role on the subscription. Paste JSON:{" "}
      <code className="text-accent font-mono text-xs">
        {"{"}&quot;tenantId&quot;, &quot;clientId&quot;,
        &quot;clientSecret&quot;, &quot;subscriptionId&quot;{"}"}
      </code>
      . We inventory App Services, VMs, SQL databases, and storage accounts,
      read-only.
    </>
  ),
};

export default function ConnectionsPage() {
  const [connections, setConnections] = useState<ProviderConnectionSummary[]>(
    []
  );
  const [provider, setProvider] = useState<Provider>("vercel");
  const [label, setLabel] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setConnections(
        await api<ProviderConnectionSummary[]>(
          `/connections`
        )
      );
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/connections", {
        method: "POST",
        body: JSON.stringify({ provider, label, token }),
      });
      setLabel("");
      setToken("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1 className="text-3xl font-bold tracking-tight mb-2">Provider connections</h1>
      <p className="text-muted mb-8">
        Read-only credentials only. Tokens are encrypted at rest, never
        displayed again, and never used to modify your infrastructure.
      </p>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        <div className="bg-surface border border-border rounded-xl p-6">
          <h3 className="text-base font-semibold mb-1.5">Connect a provider</h3>
          <form onSubmit={submit}>
            <label className="block text-sm font-semibold text-muted mt-3.5 mb-1">Provider</label>
            <select
              className="w-full bg-bg border border-border rounded-lg px-3 py-2 text-text text-sm mb-4 focus:outline-none focus:border-accent"
              value={provider}
              onChange={(e) => setProvider(e.target.value as Provider)}
            >
              {PROVIDERS.map((p) => (
                <option key={p} value={p}>
                  {PROVIDER_LABELS[p]}
                </option>
              ))}
            </select>

            <label className="block text-sm font-semibold text-muted mt-3.5 mb-1">Label</label>
            <input
              className="w-full bg-bg border border-border rounded-lg px-3 py-2 text-text text-sm mb-4 focus:outline-none focus:border-accent"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. production team"
              required
            />

            <label className="block text-sm font-semibold text-muted mt-3.5 mb-1">
              {provider === "aws"
                ? "Role ARN"
                : provider === "firebase" || provider === "gcp"
                  ? "Service account JSON key"
                  : provider === "azure"
                    ? "Service principal JSON"
                    : "Read-only API token"}
            </label>
            {provider === "firebase" || provider === "gcp" ? (
              <textarea
                className="w-full bg-bg border border-border rounded-lg px-3 py-2 text-text text-sm mb-4 focus:outline-none focus:border-accent"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                rows={6}
                placeholder='{"type": "service_account", "project_id": "…", …}'
                required
              />
            ) : provider === "azure" ? (
              <textarea
                className="w-full bg-bg border border-border rounded-lg px-3 py-2 text-text text-sm mb-4 focus:outline-none focus:border-accent"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                rows={4}
                placeholder='{"tenantId": "…", "clientId": "…", "clientSecret": "…", "subscriptionId": "…"}'
                required
              />
            ) : (
              <input
                className="w-full bg-bg border border-border rounded-lg px-3 py-2 text-text text-sm mb-4 focus:outline-none focus:border-accent"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                type={provider === "aws" ? "text" : "password"}
                placeholder={
                  provider === "aws"
                    ? "arn:aws:iam::123456789012:role/infralift-readonly"
                    : "paste token"
                }
                required
              />
            )}

            <div className="bg-accent-dim/50 border border-accent/20 rounded-lg p-3 text-sm text-text mt-3 mb-2 flex items-start gap-2">
              <svg className="w-4 h-4 mt-0.5 text-accent flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m0 0a2 2 0 100 4 2 2 0 000-4zm6-6V7a6 6 0 10-12 0v4m-2 0h16a1 1 0 011 1v8a1 1 0 01-1 1H5a1 1 0 01-1-1v-8a1 1 0 011-1z" />
              </svg>
              <span>
                Your token is encrypted with AES-256 before storage, never
                displayed again, and only used for read-only API calls. You can
                revoke it from your provider at any time.
              </span>
            </div>

            <div className="bg-bg border border-border rounded-lg p-3 text-muted text-xs font-mono mt-2 mb-4">
              {SCOPE_HELP[provider]}
            </div>

            <button
              className="inline-block mt-4 px-7 py-3 rounded-lg text-base font-semibold cursor-pointer border border-transparent bg-accent text-bg hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed"
              disabled={busy}
            >
              {busy ? "Verifying..." : "Connect & verify"}
            </button>
            {error && <div className="text-danger text-sm mt-2">{error}</div>}
          </form>
        </div>

        <div className="bg-surface border border-border rounded-xl p-6">
          <h3 className="text-base font-semibold mb-1.5">Connected</h3>
          {connections.length === 0 ? (
            <p className="text-muted text-sm">No connections yet.</p>
          ) : (
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr>
                  <th className="text-left p-3 border-b border-border text-muted font-medium text-xs">Provider</th>
                  <th className="text-left p-3 border-b border-border text-muted font-medium text-xs">Label</th>
                  <th className="text-left p-3 border-b border-border text-muted font-medium text-xs">Status</th>
                </tr>
              </thead>
              <tbody>
                {connections.map((c) => (
                  <tr key={c.id}>
                    <td className="p-3 border-b border-border">{PROVIDER_LABELS[c.provider]}</td>
                    <td className="p-3 border-b border-border">{c.label}</td>
                    <td className="p-3 border-b border-border">
                      <span
                        className={
                          c.status === "valid"
                            ? "inline-block px-2.5 py-0.5 rounded-full text-xs font-semibold bg-accent-dim text-accent"
                            : c.status === "invalid"
                              ? "inline-block px-2.5 py-0.5 rounded-full text-xs font-semibold bg-danger/20 text-danger"
                              : "inline-block px-2.5 py-0.5 rounded-full text-xs font-semibold bg-border text-muted"
                        }
                      >
                        {c.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </>
  );
}
