// Connection types the dashboard can add, and the one function that adds one.
//
// A connection is a stored credential: read-only access to one cloud account,
// or write access to a repository host or a Terraform Cloud organization.
// Terraform Cloud is a connection type like any provider (ADR 0004, ADR 0010),
// but the API stores it through its own endpoint, POST /workspaces/connections,
// because it carries an organization and a hostname besides the token. That
// difference stays in connectionRequest() below, so the pages never branch on
// endpoints.

import { isGitHost, PROVIDERS, PROVIDER_LABELS, type Provider, type ProviderConnectionSummary } from "@infralift/shared";
import { api } from "./api";
import type { Tone } from "../components/ui";

/** Terraform Cloud's provider value in the API (TFC_PROVIDER in apps/api). */
export const TFC = "tfc";

export type ConnectionType = Provider | typeof TFC;

/** What the add form collects. organization and hostname are Terraform
 *  Cloud's; every other type sends label and token only. */
export interface ConnectionFields {
  label: string;
  token: string;
  organization?: string;
  hostname?: string;
}

export type SecretKind = "token" | "arn" | "json";

export interface ConnectionTypeInfo {
  type: ConnectionType;
  name: string;
  group: "cloud" | "code";
  /** The credential field: a password-style token, an AWS role ARN (not a
   *  secret) or a pasted JSON key. */
  secret: { kind: SecretKind; label: string; placeholder: string };
  /** Where to create the credential and what infralift does with it. */
  help: string;
  /** False for the types infralift writes with (repository hosts, Terraform
   *  Cloud), so the form does not promise read-only use for them. */
  readOnly: boolean;
}

const TOKEN = (label: string, placeholder = "paste token") => ({ kind: "token" as const, label, placeholder });
const GOOGLE_JSON = {
  kind: "json" as const,
  label: "Service account JSON key",
  placeholder: '{"type": "service_account", "project_id": "…", …}',
};

/** Per type: the credential field and its setup help. The wording is what the
 *  connections page carried before this file existed. */
const PROVIDER_INFO: Record<Provider, Omit<ConnectionTypeInfo, "type" | "name" | "group">> = {
  vercel: {
    secret: TOKEN("Read-only API token"),
    readOnly: true,
    help: "Create a token at vercel.com/account/tokens, scoped to the team you want assessed. Vercel tokens inherit your role, so for strict read-only use a token from a member with the Viewer role. We read projects, domains, env var names (never values), deployments and usage.",
  },
  cloudflare: {
    secret: TOKEN("Read-only API token"),
    readOnly: true,
    help: "Create a custom token at dash.cloudflare.com/profile/api-tokens with: Account · Workers Scripts · Read, Account · Cloudflare Pages · Read, Account · Workers R2 Storage · Read, Zone · Zone · Read, Zone · DNS · Read.",
  },
  heroku: {
    secret: TOKEN("Read-only API key", "paste key"),
    readOnly: true,
    help: "Generate an API key at dashboard.heroku.com/account, or run heroku authorizations:create for a scoped authorization. We only call read endpoints: apps, formation, add-ons.",
  },
  aws: {
    secret: { kind: "arn", label: "Role ARN", placeholder: "arn:aws:iam::123456789012:role/infralift-readonly" },
    readOnly: true,
    help: "Create an IAM role with the trust policy and permissions policy above, then paste its ARN. The permissions are tag:GetResources and ce:GetCostAndUsage only: both read, neither can create, modify, or delete anything. To scan regions other than the default six, paste JSON instead: {\"roleArn\": \"…\", \"regions\": [\"ap-southeast-2\"]}.",
  },
  firebase: {
    secret: GOOGLE_JSON,
    readOnly: true,
    help: "Create a service account at console.cloud.google.com/iam-admin/serviceaccounts with the Viewer role (or granular: Firebase Viewer, Cloud Functions Viewer, Cloud Datastore Viewer), generate a JSON key, and paste the full JSON. We inventory Hosting sites, Cloud Functions, and Firestore databases.",
  },
  github: {
    secret: TOKEN("Fine-grained personal access token"),
    readOnly: false,
    help: "Create a fine-grained PAT at github.com/settings/tokens for the account or organization your projects live in, with Contents, Pull requests and Workflows: Read and write. Unlike the cloud connections this one writes: infralift opens pull requests with the infrastructure. It never pushes to your default branch.",
  },
  gitlab: {
    secret: TOKEN("Personal access token (api scope)", "glpat-..."),
    readOnly: false,
    help: "Create a personal (or group) access token at gitlab.com/-/user_settings/personal_access_tokens with the api scope. infralift opens merge requests with the infrastructure; it never pushes to your default branch.",
  },
  netlify: {
    secret: TOKEN("Personal access token"),
    readOnly: true,
    help: "Create a personal access token at app.netlify.com/user/applications. We read sites, forms, DNS zones, and build hooks, all read-only.",
  },
  render: {
    secret: TOKEN("API key", "paste key"),
    readOnly: true,
    help: "Create an API key at dashboard.render.com/account/api-keys. We read services, databases, Redis instances, and env groups, all read-only.",
  },
  railway: {
    secret: TOKEN("API token"),
    readOnly: true,
    help: "Create an API token at railway.com/account/tokens. We read projects, services, plugins (databases), and environments via the GraphQL API, all read-only.",
  },
  flyio: {
    secret: TOKEN("Deploy or personal access token"),
    readOnly: true,
    help: "Create a token via fly tokens create or the Fly.io dashboard. We read apps, machines, and volumes, all read-only.",
  },
  digitalocean: {
    secret: TOKEN("Read-only personal access token"),
    readOnly: true,
    help: "Create a personal access token at cloud.digitalocean.com/account/api/tokens with read-only scope. We inventory Droplets, App Platform apps, managed databases, Spaces, and Kubernetes clusters.",
  },
  gcp: {
    secret: GOOGLE_JSON,
    readOnly: true,
    help: "Create a service account at console.cloud.google.com/iam-admin/serviceaccounts with the Viewer role, generate a JSON key, and paste the full JSON. We inventory Cloud Run, GCE, Cloud SQL, GCS, and Cloud Functions.",
  },
  azure: {
    secret: {
      kind: "json",
      label: "Service principal JSON",
      placeholder: '{"tenantId": "…", "clientId": "…", "clientSecret": "…", "subscriptionId": "…"}',
    },
    readOnly: true,
    help: "Register an app in Azure AD, create a client secret, and grant the Reader role on the subscription. We inventory App Services, VMs, SQL databases, and storage accounts, read-only.",
  },
};

const TFC_INFO: ConnectionTypeInfo = {
  type: TFC,
  name: "Terraform Cloud",
  group: "code",
  secret: TOKEN("Team or user API token"),
  readOnly: false,
  help: "For projects that keep state in HCP Terraform or Terraform Enterprise. infralift creates each project's workspace in this organization, and the generated code points at it. A team token with \"Manage workspaces\" on the organization is enough. infralift creates workspaces and queues plans; it never applies.",
};

/** Every type the add page offers: cloud providers in PROVIDERS order, then
 *  Terraform Cloud and the repository hosts. */
export const CONNECTION_TYPES: ConnectionTypeInfo[] = [
  ...PROVIDERS.filter((p) => !isGitHost(p)).map((p) => ({
    type: p,
    name: PROVIDER_LABELS[p],
    group: "cloud" as const,
    ...PROVIDER_INFO[p],
  })),
  TFC_INFO,
  ...PROVIDERS.filter(isGitHost).map((p) => ({
    type: p,
    name: PROVIDER_LABELS[p],
    group: "code" as const,
    ...PROVIDER_INFO[p],
  })),
];

export function connectionTypeInfo(type: string | null | undefined): ConnectionTypeInfo | null {
  return CONNECTION_TYPES.find((t) => t.type === type) ?? null;
}

/** A connection's provider as people say it, Terraform Cloud included. */
export function connectionName(provider: string): string {
  return connectionTypeInfo(provider)?.name ?? provider;
}

/** True for a connection to a cloud account, the kind a project adopts from
 *  (ADR 0010). Repository hosts and Terraform Cloud are not accounts. */
export function isCloudAccount(provider: string): boolean {
  return connectionTypeInfo(provider)?.group === "cloud";
}

/** The request that stores a connection of this type. Pure, so the routing
 *  is testable without a network. Bodies match the API's schemas:
 *  createSchema in apps/api/src/routes/connections.ts, and connectionSchema
 *  in apps/api/src/routes/workspaces.ts for Terraform Cloud. */
export function connectionRequest(
  type: ConnectionType,
  fields: ConnectionFields
): { path: string; body: Record<string, string> } {
  if (type === TFC) {
    const body: Record<string, string> = {
      label: fields.label,
      organization: fields.organization ?? "",
      token: fields.token,
    };
    // Blank means app.terraform.io; the API refuses an empty string less
    // kindly than an absent field.
    const hostname = fields.hostname?.trim();
    if (hostname) body.hostname = hostname;
    return { path: "/workspaces/connections", body };
  }
  return { path: "/connections", body: { provider: type, label: fields.label, token: fields.token } };
}

/** Stores and verifies a connection. Both endpoints save a credential that
 *  fails verification as invalid rather than refusing it, so the caller
 *  shows the result on the connections page either way. */
export async function createConnection(
  type: ConnectionType,
  fields: ConnectionFields
): Promise<{ id: string; status: string }> {
  const { path, body } = connectionRequest(type, fields);
  return api<{ id: string; status: string }>(path, { method: "POST", body: JSON.stringify(body) });
}

/** What a connection's status chip says. Only problems carry color: a valid
 *  connection is a neutral check mark, an expiring one warns under 14 days,
 *  an expired or invalid one is danger. */
export function connectionStatus(
  c: Pick<ProviderConnectionSummary, "status" | "expiresAt">,
  now: number = Date.now()
): { tone: Tone; text: string } {
  if (c.status === "valid" && c.expiresAt) {
    const days = Math.ceil((new Date(c.expiresAt).getTime() - now) / 86_400_000);
    if (days <= 0) return { tone: "danger", text: "expired" };
    return { tone: days < 14 ? "warn" : "ok", text: `expires in ${days} day${days === 1 ? "" : "s"}` };
  }
  if (c.status === "valid") return { tone: "ok", text: "valid" };
  if (c.status === "invalid") return { tone: "danger", text: "invalid" };
  return { tone: "muted", text: c.status };
}
