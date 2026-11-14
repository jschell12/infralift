// ---------------------------------------------------------------------------
// Where infralift sends provider and git host API calls.
//
// Every connector and git host client takes its base URL from an Endpoints
// value instead of a constant in its own file. The defaults are the real
// vendor endpoints, so a server with no INFRALIFT_ENDPOINT_* variables set
// behaves exactly as before. Overriding them is how the local end-to-end
// stack (docker-compose.e2e.yml) points the whole adopt path at emulators
// and mocks: moto for AWS, a GitHub fake, Prism serving Cloudflare's OpenAPI
// description. See README "Testing without cloud accounts".
//
// An override sends customer credentials to whatever host it names, so a
// production server refuses to start with one set (EndpointOverrideRefused),
// unless INFRALIFT_E2E=1 says this "production" process is an e2e run (the
// API image always runs with NODE_ENV=production).
//
// Dependency injection: connectors and git clients take an Endpoints value
// (or the one URL they need) as a parameter. runtimeEndpoints() below is the
// composition root, resolved from process.env once; server.ts resolves it at
// boot so a bad override fails the start, not the first request.
// ---------------------------------------------------------------------------

interface EndpointSpec {
  /** The environment variable that overrides it. */
  env: string;
  /** The real endpoint. null for AWS: the SDK picks a regional endpoint. */
  default: string | null;
  /** What it is, for the startup log and the README table. */
  what: string;
}

/** Every outbound endpoint a connector or git host client calls. */
export const ENDPOINT_SPECS = {
  aws: { env: "INFRALIFT_ENDPOINT_AWS", default: null, what: "AWS (STS, Tagging, Cost Explorer): one URL for every service" },
  githubApi: { env: "INFRALIFT_ENDPOINT_GITHUB_API", default: "https://api.github.com", what: "GitHub REST API" },
  gitlabApi: { env: "INFRALIFT_ENDPOINT_GITLAB_API", default: "https://gitlab.com/api/v4", what: "GitLab REST API" },
  cloudflareApi: { env: "INFRALIFT_ENDPOINT_CLOUDFLARE_API", default: "https://api.cloudflare.com/client/v4", what: "Cloudflare API" },
  vercelApi: { env: "INFRALIFT_ENDPOINT_VERCEL_API", default: "https://api.vercel.com", what: "Vercel REST API" },
  netlifyApi: { env: "INFRALIFT_ENDPOINT_NETLIFY_API", default: "https://api.netlify.com/api/v1", what: "Netlify API" },
  herokuApi: { env: "INFRALIFT_ENDPOINT_HEROKU_API", default: "https://api.heroku.com", what: "Heroku Platform API" },
  renderApi: { env: "INFRALIFT_ENDPOINT_RENDER_API", default: "https://api.render.com/v1", what: "Render API" },
  railwayApi: { env: "INFRALIFT_ENDPOINT_RAILWAY_API", default: "https://backboard.railway.com/graphql/v2", what: "Railway GraphQL API (the full URL)" },
  digitaloceanApi: { env: "INFRALIFT_ENDPOINT_DIGITALOCEAN_API", default: "https://api.digitalocean.com/v2", what: "DigitalOcean API" },
  flyMachinesApi: { env: "INFRALIFT_ENDPOINT_FLY_MACHINES_API", default: "https://api.machines.dev/v1", what: "Fly.io Machines API" },
  flyApi: { env: "INFRALIFT_ENDPOINT_FLY_API", default: "https://api.fly.io", what: "Fly.io platform API (GraphQL at /graphql)" },
  azureLogin: { env: "INFRALIFT_ENDPOINT_AZURE_LOGIN", default: "https://login.microsoftonline.com", what: "Microsoft Entra token endpoint" },
  azureManagement: { env: "INFRALIFT_ENDPOINT_AZURE_MANAGEMENT", default: "https://management.azure.com", what: "Azure Resource Manager" },
  googleOauthToken: { env: "INFRALIFT_ENDPOINT_GOOGLE_OAUTH_TOKEN", default: "https://oauth2.googleapis.com/token", what: "Google OAuth token exchange (the full URL)" },
  gcpRun: { env: "INFRALIFT_ENDPOINT_GCP_RUN", default: "https://run.googleapis.com", what: "Cloud Run API" },
  gcpCompute: { env: "INFRALIFT_ENDPOINT_GCP_COMPUTE", default: "https://compute.googleapis.com", what: "Compute Engine API" },
  gcpSqlAdmin: { env: "INFRALIFT_ENDPOINT_GCP_SQLADMIN", default: "https://sqladmin.googleapis.com", what: "Cloud SQL Admin API" },
  gcpStorage: { env: "INFRALIFT_ENDPOINT_GCP_STORAGE", default: "https://storage.googleapis.com", what: "Cloud Storage JSON API" },
  gcpCloudFunctions: { env: "INFRALIFT_ENDPOINT_GCP_CLOUDFUNCTIONS", default: "https://cloudfunctions.googleapis.com", what: "Cloud Functions API" },
  firebaseHosting: { env: "INFRALIFT_ENDPOINT_FIREBASE_HOSTING", default: "https://firebasehosting.googleapis.com", what: "Firebase Hosting API" },
  firestore: { env: "INFRALIFT_ENDPOINT_FIRESTORE", default: "https://firestore.googleapis.com", what: "Firestore API" },
} as const satisfies Record<string, EndpointSpec>;

export type EndpointName = keyof typeof ENDPOINT_SPECS;

/** Resolved base URLs, no trailing slash. `aws` is null for the SDK's own. */
export type Endpoints = { readonly aws: string | null } & { readonly [K in Exclude<EndpointName, "aws">]: string };

/** The real endpoints. What every connector uses when given nothing. */
export const DEFAULT_ENDPOINTS: Endpoints = Object.freeze(
  Object.fromEntries(Object.entries(ENDPOINT_SPECS).map(([name, spec]) => [name, spec.default]))
) as Endpoints;

/** The env var that turns a production process into an allowed e2e run. */
export const E2E_FLAG = "INFRALIFT_E2E";

/** A production process was started with an endpoint override. */
export class EndpointOverrideRefused extends Error {
  constructor(readonly variables: string[]) {
    super(
      `refusing to start: ${variables.join(", ")} ${variables.length === 1 ? "is" : "are"} set while NODE_ENV=production. ` +
        `Endpoint overrides send customer credentials to another host; they are for local and CI e2e runs only. ` +
        `Unset them, or set ${E2E_FLAG}=1 if this really is an e2e run.`
    );
    this.name = "EndpointOverrideRefused";
  }
}

/** An override that is not an http(s) URL. Thrown before anything is sent. */
export class InvalidEndpoint extends Error {
  constructor(variable: string) {
    super(`${variable} must be an http:// or https:// URL`);
    this.name = "InvalidEndpoint";
  }
}

function parseOverride(variable: string, raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new InvalidEndpoint(variable);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new InvalidEndpoint(variable);
  return raw.replace(/\/+$/, "");
}

export interface ResolvedEndpoints {
  endpoints: Endpoints;
  /** Names of the env vars that were set, so the caller can say so. */
  overridden: string[];
}

/** Endpoints from an environment. Pure: takes the env, reads nothing else.
 *  Empty variables count as unset. Throws InvalidEndpoint for a value that is
 *  not an http(s) URL, and EndpointOverrideRefused for any override in
 *  production without the e2e flag. */
export function resolveEndpoints(env: Record<string, string | undefined>): ResolvedEndpoints {
  const resolved: Record<string, string | null> = {};
  const overridden: string[] = [];
  for (const [name, spec] of Object.entries(ENDPOINT_SPECS) as [EndpointName, EndpointSpec][]) {
    const raw = env[spec.env]?.trim();
    if (raw) {
      resolved[name] = parseOverride(spec.env, raw);
      overridden.push(spec.env);
    } else {
      resolved[name] = spec.default;
    }
  }
  if (overridden.length && env.NODE_ENV === "production" && env[E2E_FLAG] !== "1") {
    throw new EndpointOverrideRefused(overridden);
  }
  return { endpoints: Object.freeze(resolved) as Endpoints, overridden };
}

// -- composition root ---------------------------------------------------------

let runtime: ResolvedEndpoints | null = null;

/** The endpoints this process uses, resolved from process.env on first use.
 *  The one place connectors' and git clients' defaults come from at runtime;
 *  tests pass their own Endpoints to the factories instead. */
export function runtimeEndpoints(): Endpoints {
  runtime ??= resolveEndpoints(process.env);
  return runtime.endpoints;
}

/** Resolves the runtime endpoints now and logs any override, for server.ts
 *  to call before it listens. Throws what resolveEndpoints throws. */
export function resolveRuntimeEndpointsAtBoot(log: (line: string) => void = console.warn): Endpoints {
  runtime ??= resolveEndpoints(process.env);
  for (const variable of runtime.overridden) {
    log(`endpoint override: ${variable} is set; calls go there instead of the real API`);
  }
  return runtime.endpoints;
}

// -- collectors ---------------------------------------------------------------

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function urlOf(input: string | URL | Request): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

/** A fetch that sends URLs under `from` to the same path under `to`, and
 *  every other URL unchanged. For the published collectors
 *  (packages/collectors), which hard-code their vendor's API on purpose so a
 *  customer can audit every call they make: the connector that runs them
 *  points them at an override by rewriting the URL here, rather than giving
 *  the published script a base-URL option. When `from` equals `to` this is
 *  `fetchImpl` itself. */
export function rebasedFetch(from: string, to: string, fetchImpl: FetchLike): FetchLike {
  if (from === to) return fetchImpl;
  return (input, init) => {
    const url = urlOf(input);
    return fetchImpl(url.startsWith(from) ? `${to}${url.slice(from.length)}` : input, init);
  };
}
