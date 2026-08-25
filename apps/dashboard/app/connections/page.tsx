"use client";

import { useCallback, useEffect, useState } from "react";
import {
  PROVIDERS,
  PROVIDER_LABELS,
  type Provider,
  type ProviderConnectionSummary,
} from "@infralift/shared";
import { api, DEV_ORG_ID } from "../../lib/api";

const SCOPE_HELP: Record<Provider, React.ReactNode> = {
  vercel: (
    <>
      Create a token at <code>vercel.com/account/tokens</code>. Scope it to the
      team you want assessed. Vercel tokens are read/write by scope of your
      role — use a <code>Viewer</code> role member&apos;s token for strict
      read-only.
    </>
  ),
  cloudflare: (
    <>
      Create a token at <code>dash.cloudflare.com/profile/api-tokens</code>{" "}
      with read-only permissions: <code>Account · Workers Scripts · Read</code>
      , <code>Account · Cloudflare Pages · Read</code>,{" "}
      <code>Account · Workers R2 Storage · Read</code>,{" "}
      <code>Zone · Zone · Read</code>, <code>Zone · DNS · Read</code>.
    </>
  ),
  heroku: (
    <>
      Generate an API key at <code>dashboard.heroku.com/account</code>{" "}
      (Account → API Key) or via <code>heroku authorizations:create</code>.
      We only call read endpoints: apps, formation, add-ons.
    </>
  ),
  aws: (
    <>
      Create an IAM role with the AWS-managed <code>ReadOnlyAccess</code>{" "}
      policy plus <code>ce:GetCostAndUsage</code>, trusted to our account with
      an external ID. Paste the role ARN here (or JSON{" "}
      <code>{"{"}&quot;roleArn&quot;, &quot;externalId&quot;{"}"}</code>).
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
          `/connections?orgId=${DEV_ORG_ID}`
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
        body: JSON.stringify({ orgId: DEV_ORG_ID, provider, label, token }),
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
      <h1>Provider connections</h1>
      <p className="lead">
        Read-only credentials only. Tokens are encrypted at rest, never
        displayed again, and never used to modify your infrastructure.
      </p>

      <div className="grid grid-2">
        <div className="card">
          <h3>Connect a provider</h3>
          <form onSubmit={submit}>
            <label>Provider</label>
            <select
              value={provider}
              onChange={(e) => setProvider(e.target.value as Provider)}
            >
              {PROVIDERS.map((p) => (
                <option key={p} value={p}>
                  {PROVIDER_LABELS[p]}
                </option>
              ))}
            </select>

            <label>Label</label>
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. production team"
              required
            />

            <label>
              {provider === "aws" ? "Role ARN" : "Read-only API token"}
            </label>
            <input
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

            <div className="help">{SCOPE_HELP[provider]}</div>

            <button className="btn btn-primary" disabled={busy}>
              {busy ? "Verifying…" : "Connect & verify"}
            </button>
            {error && <div className="error">{error}</div>}
          </form>
        </div>

        <div className="card">
          <h3>Connected</h3>
          {connections.length === 0 ? (
            <p>No connections yet.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Provider</th>
                  <th>Label</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {connections.map((c) => (
                  <tr key={c.id}>
                    <td>{PROVIDER_LABELS[c.provider]}</td>
                    <td>{c.label}</td>
                    <td>
                      <span
                        className={
                          c.status === "valid"
                            ? "badge badge-ok"
                            : c.status === "invalid"
                              ? "badge badge-bad"
                              : "badge badge-muted"
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
