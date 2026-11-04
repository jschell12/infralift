"use client";

import { useCallback, useEffect, useState } from "react";
import {
  PROVIDERS,
  PROVIDER_LABELS,
  type Provider,
  type ProviderConnectionSummary,
} from "@infralift/shared";
import { api } from "../../lib/api";
import {
  Card,
  CardTitle,
  Chip,
  H1,
  INPUT,
  LABEL,
  Note,
  PrimaryButton,
  TableHead,
  TableRow,
} from "../../components/ui";

type FieldKind = "token" | "arn" | "json";

const FIELD: Record<Provider, { kind: FieldKind; label: string; placeholder: string }> = {
  vercel: { kind: "token", label: "Read-only API token", placeholder: "paste token" },
  cloudflare: { kind: "token", label: "Read-only API token", placeholder: "paste token" },
  heroku: { kind: "token", label: "Read-only API key", placeholder: "paste key" },
  aws: {
    kind: "arn",
    label: "Role ARN",
    placeholder: "arn:aws:iam::123456789012:role/infralift-readonly",
  },
  firebase: {
    kind: "json",
    label: "Service account JSON key",
    placeholder: '{"type": "service_account", "project_id": "…", …}',
  },
  github: {
    kind: "token",
    label: "Fine-grained personal access token",
    placeholder: "paste token",
  },
  netlify: { kind: "token", label: "Personal access token", placeholder: "paste token" },
  render: { kind: "token", label: "API key", placeholder: "paste key" },
  railway: { kind: "token", label: "API token", placeholder: "paste token" },
  flyio: { kind: "token", label: "Deploy or personal access token", placeholder: "paste token" },
  digitalocean: { kind: "token", label: "Read-only personal access token", placeholder: "paste token" },
  gcp: {
    kind: "json",
    label: "Service account JSON key",
    placeholder: '{"type": "service_account", "project_id": "…", …}',
  },
  azure: {
    kind: "json",
    label: "Service principal JSON",
    placeholder: '{"tenantId": "…", "clientId": "…", "clientSecret": "…", "subscriptionId": "…"}',
  },
};

const SCOPE_HELP: Record<Provider, string> = {
  vercel:
    "Create a token at vercel.com/account/tokens, scoped to the team you want assessed. Vercel tokens inherit your role, so for strict read-only use a token from a member with the Viewer role. We read projects, domains, env var names (never values), deployments and usage.",
  cloudflare:
    "Create a custom token at dash.cloudflare.com/profile/api-tokens with: Account · Workers Scripts · Read, Account · Cloudflare Pages · Read, Account · Workers R2 Storage · Read, Zone · Zone · Read, Zone · DNS · Read.",
  heroku:
    "Generate an API key at dashboard.heroku.com/account, or run heroku authorizations:create for a scoped authorization. We only call read endpoints: apps, formation, add-ons.",
  aws:
    "Create an IAM role with the AWS-managed ReadOnlyAccess policy plus ce:GetCostAndUsage, trusted to our account with the external ID shown above. ReadOnlyAccess cannot create, modify, or delete anything.",
  firebase:
    "Create a service account at console.cloud.google.com/iam-admin/serviceaccounts with the Viewer role (or granular: Firebase Viewer, Cloud Functions Viewer, Cloud Datastore Viewer), generate a JSON key, and paste the full JSON. We inventory Hosting sites, Cloud Functions, and Firestore databases.",
  github:
    "Create a fine-grained PAT at github.com/settings/tokens with Contents: Read and write. This is the one credential that is not read-only: it is used to commit generated Terraform, and nothing else. Scope it to the repository that will receive the code if you create that repository yourself. If you want infralift to create it for you, the token needs permission to create repositories for the owner instead.",
  netlify:
    "Create a personal access token at app.netlify.com/user/applications. We read sites, forms, DNS zones, and build hooks, all read-only.",
  render:
    "Create an API key at dashboard.render.com/account/api-keys. We read services, databases, Redis instances, and env groups, all read-only.",
  railway:
    "Create an API token at railway.com/account/tokens. We read projects, services, plugins (databases), and environments via the GraphQL API, all read-only.",
  flyio:
    "Create a token via fly tokens create or the Fly.io dashboard. We read apps, machines, and volumes, all read-only.",
  digitalocean:
    "Create a personal access token at cloud.digitalocean.com/account/api/tokens with read-only scope. We inventory Droplets, App Platform apps, managed databases, Spaces, and Kubernetes clusters.",
  gcp:
    "Create a service account at console.cloud.google.com/iam-admin/serviceaccounts with the Viewer role, generate a JSON key, and paste the full JSON. We inventory Cloud Run, GCE, Cloud SQL, GCS, and Cloud Functions.",
  azure:
    "Register an app in Azure AD, create a client secret, and grant the Reader role on the subscription. We inventory App Services, VMs, SQL databases, and storage accounts, read-only.",
};

const COLS = "grid-cols-[1fr_1fr_90px]";

export default function ConnectionsPage() {
  const [connections, setConnections] = useState<ProviderConnectionSummary[]>([]);
  const [provider, setProvider] = useState<Provider>("vercel");
  const [label, setLabel] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setConnections(await api<ProviderConnectionSummary[]>("/connections"));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // deep link from the dashboard provider cards: /connections?provider=heroku
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get("provider");
    if (q && (PROVIDERS as readonly string[]).includes(q)) {
      setProvider(q as Provider);
    }
  }, []);

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

  const field = FIELD[provider];
  const hasValid = connections.some((c) => c.status === "valid");

  return (
    <>
      <h1 className={H1}>Provider connections</h1>
      <p className="mb-7 max-w-[620px] text-muted">
        Read-only credentials only. Tokens are encrypted at rest, never displayed
        again, and never used to modify your infrastructure.
      </p>

      <div className="grid grid-cols-1 items-start gap-5 md:grid-cols-2">
        <Card>
          <CardTitle>Connect a provider</CardTitle>
          <form onSubmit={submit}>
            <label className={LABEL}>Provider</label>
            <select
              className={`${INPUT} mb-4`}
              value={provider}
              onChange={(e) => setProvider(e.target.value as Provider)}
            >
              {PROVIDERS.map((p) => (
                <option key={p} value={p}>
                  {PROVIDER_LABELS[p]}
                </option>
              ))}
            </select>

            <label className={LABEL}>Label</label>
            <input
              className={`${INPUT} mb-4`}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. production team"
              required
            />

            <label className={LABEL}>{field.label}</label>
            {field.kind === "json" ? (
              <textarea
                className={`${INPUT} mb-3.5 font-mono`}
                value={token}
                onChange={(e) => setToken(e.target.value)}
                rows={provider === "azure" ? 4 : 6}
                placeholder={field.placeholder}
                required
              />
            ) : (
              <input
                className={`${INPUT} mb-3.5 font-mono`}
                value={token}
                onChange={(e) => setToken(e.target.value)}
                type={field.kind === "arn" ? "text" : "password"}
                placeholder={field.placeholder}
                required
              />
            )}

            <div className="mb-3">
              <Note tone="accent">
                Your token is encrypted with AES-256 before storage, never
                displayed again, and only used for read-only API calls. You can
                revoke it from your provider at any time.
              </Note>
            </div>

            <div className="mb-5 rounded-lg border border-border bg-bg p-3 font-mono text-xs leading-relaxed text-muted">
              {SCOPE_HELP[provider]}
            </div>

            <PrimaryButton disabled={busy}>
              {busy ? "Verifying..." : "Connect & verify"}
            </PrimaryButton>
            {error && <div className="mt-2 text-sm text-danger">{error}</div>}
          </form>
        </Card>

        <Card>
          <CardTitle>Connected</CardTitle>
          <p className="mb-3 text-[13px] text-faint">
            {connections.length
              ? "Each connection is assessed independently and combined into one report."
              : "No connections yet."}
          </p>
          {connections.length > 0 && (
            <>
              <TableHead cols={COLS}>
                <span>Provider</span>
                <span>Label</span>
                <span>Status</span>
              </TableHead>
              {connections.map((c) => (
                <TableRow key={c.id} cols={COLS}>
                  <span>{PROVIDER_LABELS[c.provider]}</span>
                  <span className="text-muted">{c.label}</span>
                  <Chip
                    tone={
                      c.status === "valid"
                        ? "accent"
                        : c.status === "invalid"
                          ? "danger"
                          : "muted"
                    }
                  >
                    {c.status}
                  </Chip>
                </TableRow>
              ))}
            </>
          )}
          {hasValid && (
            <div className="mt-4">
              <PrimaryButton href="/projects?start=existing">
                Assess existing infrastructure
              </PrimaryButton>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
