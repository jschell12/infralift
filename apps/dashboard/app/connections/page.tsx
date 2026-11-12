"use client";

import { useCallback, useEffect, useState } from "react";
import {
  PROVIDERS,
  PROVIDER_LABELS,
  type AwsSetup,
  type Provider,
  type ProviderConnectionSummary,
} from "@infralift/shared";
import { api, errorText } from "../../lib/api";
import {
  Card,
  CardTitle,
  Chip,
  Drawer,
  ErrorState,
  H1,
  INPUT,
  LABEL,
  Note,
  PrimaryButton,
  Skeleton,
  TableHead,
  SMALL_BTN,
  SMALL_BTN_DANGER,
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
  gitlab: { kind: "token", label: "Personal access token (api scope)", placeholder: "glpat-..." },
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
    "Create an IAM role with the trust policy and permissions policy above, then paste its ARN. The permissions are tag:GetResources and ce:GetCostAndUsage only: both read, neither can create, modify, or delete anything. To scan regions other than the default six, paste JSON instead: {\"roleArn\": \"…\", \"regions\": [\"ap-southeast-2\"]}.",
  firebase:
    "Create a service account at console.cloud.google.com/iam-admin/serviceaccounts with the Viewer role (or granular: Firebase Viewer, Cloud Functions Viewer, Cloud Datastore Viewer), generate a JSON key, and paste the full JSON. We inventory Hosting sites, Cloud Functions, and Firestore databases.",
  github:
    "Create a fine-grained PAT at github.com/settings/tokens for the account or organization your projects live in, with Contents, Pull requests and Workflows: Read and write, plus Administration: Read and write if infralift should create new repositories for you. Unlike the cloud connections this one writes: infralift creates project repositories from templates and opens pull requests with the infrastructure. It never pushes to your default branch.",
  gitlab:
    "Create a personal (or group) access token at gitlab.com/-/user_settings/personal_access_tokens with the api scope. infralift creates project repositories from templates and opens merge requests with the infrastructure; it never pushes to your default branch.",
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

const COLS = "grid-cols-[1fr_1fr_120px]";

function providerName(provider: string): string {
  return PROVIDER_LABELS[provider as Provider] ?? (provider === "tfc" ? "Terraform Cloud" : provider);
}

/** valid / invalid / expires in N days (warn under 14). */
function StatusChip({ c }: { c: ProviderConnectionSummary }) {
  if (c.status === "valid" && c.expiresAt) {
    const days = Math.ceil((new Date(c.expiresAt).getTime() - Date.now()) / 86_400_000);
    if (days <= 0) return <Chip tone="danger">expired</Chip>;
    return <Chip tone={days < 14 ? "warn" : "ok"}>{`expires in ${days} day${days === 1 ? "" : "s"}`}</Chip>;
  }
  return (
    <Chip tone={c.status === "valid" ? "ok" : c.status === "invalid" ? "danger" : "muted"}>{c.status}</Chip>
  );
}

/** Replace a connection's credential. The API verifies the new one first and
 *  keeps the old one if it fails, so a failure here changes nothing. */
function ReplaceDrawer({
  c,
  onClose,
  onDone,
}: {
  c: ProviderConnectionSummary;
  onClose: () => void;
  onDone: () => void;
}) {
  const isTfc = String(c.provider) === "tfc";
  const field = isTfc ? null : FIELD[c.provider];
  const [token, setToken] = useState("");
  const [organization, setOrganization] = useState("");
  const [hostname, setHostname] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/connections/${c.id}`, {
        method: "PATCH",
        body: JSON.stringify(
          isTfc ? { token, organization: organization || undefined, hostname: hostname || undefined } : { token }
        ),
      });
      onDone();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer
      title="Replace credential"
      subtitle={`${providerName(c.provider)} · ${c.label}. The new credential is verified before it replaces the current one.`}
      onClose={onClose}
    >
      <form onSubmit={submit}>
        {isTfc && (
          <>
            <label htmlFor="replace-organization" className={LABEL}>Organization (blank keeps the current one)</label>
            <input id="replace-organization" className={`${INPUT} mb-4`} value={organization} onChange={(e) => setOrganization(e.target.value)} />
            <label htmlFor="replace-hostname" className={LABEL}>Hostname (blank keeps the current one)</label>
            <input id="replace-hostname" className={`${INPUT} mb-4`} value={hostname} onChange={(e) => setHostname(e.target.value)} placeholder="app.terraform.io" />
          </>
        )}
        <label htmlFor="replace-token" className={LABEL}>{field?.label ?? "Team or user API token"}</label>
        {field?.kind === "json" ? (
          <textarea
            id="replace-token"
            className={`${INPUT} mb-4 font-mono`}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            rows={6}
            placeholder={field.placeholder}
            required
          />
        ) : (
          <input
            id="replace-token"
            className={`${INPUT} mb-4 font-mono`}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            type={field?.kind === "arn" ? "text" : "password"}
            placeholder={field?.placeholder}
            required
          />
        )}
        <PrimaryButton disabled={busy}>{busy ? "Verifying..." : "Verify & replace"}</PrimaryButton>
        {error && <div className="mt-2 text-sm text-danger">{error}</div>}
      </form>
    </Drawer>
  );
}

/** One connection: what state it is in, why, and the three ways to act on it. */
function ConnectionRow({ c, onChanged }: { c: ProviderConnectionSummary; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [replacing, setReplacing] = useState(false);
  const [confirming, setConfirming] = useState(false);

  async function act(path: string, method: string) {
    setBusy(true);
    setError(null);
    try {
      await api(path, { method });
      setConfirming(false);
      onChanged();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border-b border-border py-3 text-[13px]">
      <div className={`grid ${COLS} items-center gap-2`}>
        <span>{providerName(c.provider)}</span>
        <span className="text-muted">{c.label}</span>
        <StatusChip c={c} />
      </div>
      {c.status === "invalid" && c.lastError && <div className="mt-1.5 text-xs text-danger">{c.lastError}</div>}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button className={SMALL_BTN} disabled={busy} onClick={() => void act(`/connections/${c.id}/verify`, "POST")}>
          {busy && !confirming ? "Verifying..." : "Re-verify"}
        </button>
        <button className={SMALL_BTN} disabled={busy} onClick={() => setReplacing(true)}>
          Replace credential
        </button>
        {confirming ? (
          <>
            <span className="text-xs text-muted">Remove &quot;{c.label}&quot; and its stored credential?</span>
            <button className={SMALL_BTN_DANGER} disabled={busy} onClick={() => void act(`/connections/${c.id}`, "DELETE")}>
              Remove
            </button>
            <button className={SMALL_BTN} disabled={busy} onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </>
        ) : (
          <button className={SMALL_BTN} disabled={busy} onClick={() => setConfirming(true)}>
            Remove
          </button>
        )}
      </div>
      {error && <div className="mt-1.5 text-xs text-danger">{error}</div>}
      {replacing && (
        <ReplaceDrawer
          c={c}
          onClose={() => setReplacing(false)}
          onDone={() => {
            setReplacing(false);
            onChanged();
          }}
        />
      )}
    </div>
  );
}

/** HCP Terraform / TFE: where a project's workspace lives when it uses a
 *  Terraform Cloud backend. Stored by /workspaces/connections as a "tfc"
 *  connection; a project picks one in its backend settings. */
function TfcConnectCard({ onAdded }: { onAdded: () => void }) {
  const [label, setLabel] = useState("");
  const [organization, setOrganization] = useState("");
  const [hostname, setHostname] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setAdded(null);
    try {
      const out = await api<{ status: string; organization: string }>("/workspaces/connections", {
        method: "POST",
        body: JSON.stringify({ label, organization, hostname: hostname || undefined, token }),
      });
      setAdded(out.status === "valid" ? `Connected to ${out.organization}.` : `Saved, but ${out.organization} could not be read with that token.`);
      setLabel("");
      setToken("");
      onAdded();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardTitle>Connect Terraform Cloud</CardTitle>
      <p className="mb-4 text-[13px] text-muted">
        For projects that keep state in HCP Terraform or Terraform Enterprise. infralift creates each project&apos;s
        workspace in this organization, and the generated code points at it.
      </p>
      <form onSubmit={submit}>
        <label htmlFor="tfc-label" className={LABEL}>Label</label>
        <input id="tfc-label" className={`${INPUT} mb-4`} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. platform" required />
        <label htmlFor="tfc-organization" className={LABEL}>Organization</label>
        <input id="tfc-organization" className={`${INPUT} mb-4`} value={organization} onChange={(e) => setOrganization(e.target.value)} required />
        <label htmlFor="tfc-hostname" className={LABEL}>Hostname (Terraform Enterprise only)</label>
        <input id="tfc-hostname" className={`${INPUT} mb-4`} value={hostname} onChange={(e) => setHostname(e.target.value)} placeholder="app.terraform.io" />
        <label htmlFor="tfc-token" className={LABEL}>Team or user API token</label>
        <input id="tfc-token" className={`${INPUT} mb-3.5 font-mono`} type="password" value={token} onChange={(e) => setToken(e.target.value)} required />
        <div className="mb-5 rounded-lg border border-border bg-bg p-3 font-mono text-xs leading-relaxed text-muted">
          A team token with &quot;Manage workspaces&quot; on the organization is enough. infralift creates workspaces and
          queues plans; it never applies.
        </div>
        <PrimaryButton disabled={busy}>{busy ? "Verifying..." : "Connect & verify"}</PrimaryButton>
        {added && <div className="mt-2 text-sm text-muted"><span aria-hidden="true">{"\u2713 "}</span>{added}</div>}
        {error && <div className="mt-2 text-sm text-danger">{error}</div>}
      </form>
    </Card>
  );
}

function CopyBlock({ title, text }: { title: string; text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mb-3">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[13px] font-semibold text-muted">{title}</span>
        <button
          type="button"
          className={SMALL_BTN}
          onClick={() => {
            void navigator.clipboard.writeText(text).then(() => setCopied(true));
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="max-h-48 overflow-auto rounded-lg border border-border bg-bg p-3 font-mono text-xs text-muted">
        {text}
      </pre>
    </div>
  );
}

/** The AWS add flow: this org's external ID and the policies to paste. */
function AwsSetupPanel({ setup }: { setup: AwsSetup | null }) {
  if (!setup) return <div className="mb-3 text-sm text-faint">Loading AWS setup...</div>;
  if (!setup.enabled) {
    return (
      <div className="mb-3">
        <Note>AWS isn&apos;t available yet on this server. Connect another provider for now.</Note>
      </div>
    );
  }
  return (
    <div className="mb-1">
      <div className={LABEL}>Your external ID</div>
      <div className="mb-3 break-all rounded-lg border border-border bg-bg p-2 font-mono text-xs">{setup.externalId}</div>
      <CopyBlock title="Trust policy" text={setup.trustPolicy ?? ""} />
      <CopyBlock title="Permissions policy" text={setup.permissionsPolicy ?? ""} />
    </div>
  );
}

export default function ConnectionsPage() {
  const [connections, setConnections] = useState<ProviderConnectionSummary[]>([]);
  const [provider, setProvider] = useState<Provider>("vercel");
  const [label, setLabel] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [awsSetup, setAwsSetup] = useState<AwsSetup | null>(null);
  // False until the list first answers, so "No connections yet" is not shown
  // while connections are still loading.
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    try {
      setConnections(await api<ProviderConnectionSummary[]>("/connections"));
      setError(null);
      setLoaded(true);
    } catch (e) {
      setError(errorText(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (provider !== "aws" || awsSetup) return;
    api<AwsSetup>("/connections/aws-setup")
      .then(setAwsSetup)
      .catch((e) => setError(errorText(e)));
  }, [provider, awsSetup]);

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
      setError(errorText(e));
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
            <label htmlFor="conn-provider" className={LABEL}>Provider</label>
            <select id="conn-provider"
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

            <label htmlFor="conn-label" className={LABEL}>Label</label>
            <input id="conn-label"
              className={`${INPUT} mb-4`}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. production team"
              required
            />

            {provider === "aws" && <AwsSetupPanel setup={awsSetup} />}

            <label htmlFor="conn-token" className={LABEL}>{field.label}</label>
            {field.kind === "json" ? (
              <textarea
                id="conn-token"
                className={`${INPUT} mb-3.5 font-mono`}
                value={token}
                onChange={(e) => setToken(e.target.value)}
                rows={provider === "azure" ? 4 : 6}
                placeholder={field.placeholder}
                required
              />
            ) : (
              <input
                id="conn-token"
                className={`${INPUT} mb-3.5 font-mono`}
                value={token}
                onChange={(e) => setToken(e.target.value)}
                type={field.kind === "arn" ? "text" : "password"}
                placeholder={field.placeholder}
                required
              />
            )}

            <div className="mb-3">
              <Note tone="emphasis">
                Your token is encrypted with AES-256 before storage, never
                displayed again, and only used for read-only API calls. You can
                revoke it from your provider at any time.
              </Note>
            </div>

            <div className="mb-5 rounded-lg border border-border bg-bg p-3 font-mono text-xs leading-relaxed text-muted">
              {SCOPE_HELP[provider]}
            </div>

            <PrimaryButton disabled={busy || (provider === "aws" && !awsSetup?.enabled)}>
              {busy ? "Verifying..." : "Connect & verify"}
            </PrimaryButton>
            {error && <div className="mt-2 text-sm text-danger">{error}</div>}
          </form>
        </Card>

        <Card>
          <CardTitle>Connected</CardTitle>
          {loaded ? (
            <p className="mb-3 text-[13px] text-faint">
              {connections.length
                ? "Each connection is assessed independently and combined into one report."
                : "No connections yet."}
            </p>
          ) : error ? (
            <ErrorState message={error} onRetry={() => void load()} />
          ) : (
            <div role="status" aria-label="Loading connections">
              <Skeleton className="h-3 w-2/3 mb-4" />
              <Skeleton className="h-10 w-full mb-2" />
              <Skeleton className="h-10 w-full" />
            </div>
          )}
          {connections.length > 0 && (
            <>
              <TableHead cols={COLS}>
                <span>Provider</span>
                <span>Label</span>
                <span>Status</span>
              </TableHead>
              {connections.map((c) => (
                <ConnectionRow key={c.id} c={c} onChanged={() => void load()} />
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
        <TfcConnectCard onAdded={() => void load()} />
      </div>
    </>
  );
}
