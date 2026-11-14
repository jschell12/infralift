import { createSign } from "node:crypto";
import type { ResourceInventoryItem } from "@infralift/shared";
import { CredentialFormatError, ProviderHttpError, type Connector, type ConnectorAssessment } from "./types.js";
import { httpFetch } from "../lib/http.js";
import { DEFAULT_ENDPOINTS, type Endpoints } from "../lib/endpoints.js";
import { settleBounded } from "../lib/bounded.js";

/** Cloud Run regions listed at once. services.list takes one location, so a
 *  project is one call per region Cloud Run offers it (about 40); each call
 *  keeps httpFetch's deadline (lib/http.ts). */
export const CLOUD_RUN_CONCURRENCY = 6;
/** Pages of the locations list read before stopping with an error. */
const MAX_LOCATION_PAGES = 10;

// GCP assessment via a read-only service account (Viewer role). Uses the same
// JWT bearer flow as the Firebase connector but inventories Cloud Run, GCE,
// Cloud SQL, and GCS rather than Firebase-specific resources. The connection
// "token" is the service account JSON key.

// Google requires the JWT `aud` claim to be its token URL, whatever host
// the assertion is actually POSTed to (endpoints.googleOauthToken).
const TOKEN_AUDIENCE = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/cloud-platform.read-only";

interface ServiceAccountKey {
  type: string;
  project_id: string;
  private_key: string;
  client_email: string;
}

function parseKey(token: string): ServiceAccountKey | null {
  try {
    const key = JSON.parse(token);
    if (
      key?.type === "service_account" &&
      typeof key.project_id === "string" &&
      typeof key.private_key === "string" &&
      typeof key.client_email === "string"
    ) {
      return key;
    }
    return null;
  } catch {
    return null;
  }
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/** `tokenUrl` is DEFAULT_ENDPOINTS.googleOauthToken unless overridden
 *  (lib/endpoints.ts). */
async function mintAccessToken(tokenUrl: string, key: ServiceAccountKey): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(
    JSON.stringify({
      iss: key.client_email,
      scope: SCOPE,
      aud: TOKEN_AUDIENCE,
      iat: now,
      exp: now + 3600,
    })
  );
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  const signature = signer.sign(key.private_key).toString("base64url");
  const assertion = `${header}.${claims}.${signature}`;

  const res = await httpFetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (!res.ok) {
    throw new ProviderHttpError(`GCP token exchange failed: ${res.status}`, res.status);
  }
  const body: any = await res.json();
  return body.access_token as string;
}

async function gFetch(accessToken: string, url: string): Promise<any> {
  const res = await httpFetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new ProviderHttpError(`GCP API ${new URL(url).pathname} -> ${res.status}`, res.status);
  }
  return res.json();
}

/** The Cloud Run locations this project can see, by id ("us-central1"),
 *  from the Cloud Run v1 locations API, following nextPageToken. */
async function cloudRunLocations(runApi: string, accessToken: string, project: string): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | null = null;
  for (let page = 0; page < MAX_LOCATION_PAGES; page++) {
    const query = pageToken ? `?pageToken=${encodeURIComponent(pageToken)}` : "";
    const body = await gFetch(accessToken, `${runApi}/v1/projects/${project}/locations${query}`);
    for (const loc of body.locations ?? []) {
      const id = loc.locationId ?? String(loc.name ?? "").split("/locations/")[1];
      if (id) ids.push(id);
    }
    pageToken = body.nextPageToken || null;
    if (!pageToken) return ids;
  }
  throw new Error(`GCP API /v1/projects/${project}/locations still had more pages after ${MAX_LOCATION_PAGES}`);
}

/** Every Cloud Run service in the project. services.list refuses the
 *  "locations/-" wildcard ("cannot be the \"-\" wildcard", run v2 discovery
 *  document), which the connector used to send (#153 finding 6), so this asks
 *  each location in turn, CLOUD_RUN_CONCURRENCY at a time. `failedLocations`
 *  counts the ones that did not answer, so a partial list is said. */
async function cloudRunServices(runApi: string, accessToken: string, project: string): Promise<{ services: any[]; failedLocations: number; locations: number }> {
  const locations = await cloudRunLocations(runApi, accessToken, project);
  const reads = await settleBounded(locations, CLOUD_RUN_CONCURRENCY, (location) =>
    gFetch(accessToken, `${runApi}/v2/projects/${project}/locations/${location}/services`)
  );
  const services: any[] = [];
  const seen = new Set<string>();
  let failedLocations = 0;
  for (const read of reads) {
    if (!read.ok) {
      failedLocations++;
      continue;
    }
    for (const s of read.value.services ?? []) {
      if (seen.has(s.name)) continue;
      seen.add(s.name);
      services.push(s);
    }
  }
  // Every location refused: the API is off or the key cannot read it. Treated
  // as before, as Cloud Run not being readable.
  if (locations.length > 0 && failedLocations === locations.length) {
    const first = reads.find((r) => !r.ok) as { ok: false; error: unknown };
    throw first.error;
  }
  return { services, failedLocations, locations: locations.length };
}

/** The GCP connector, calling endpoints.googleOauthToken, gcpRun, gcpCompute, gcpSqlAdmin, gcpStorage and gcpCloudFunctions (lib/endpoints.ts). */
export function createGcpConnector(endpoints: Pick<Endpoints, "googleOauthToken" | "gcpRun" | "gcpCompute" | "gcpSqlAdmin" | "gcpStorage" | "gcpCloudFunctions"> = DEFAULT_ENDPOINTS): Connector {
  const connector: Connector = {
    provider: "gcp",

    async verify(token) {
      const key = parseKey(token);
      if (!key) return false;
      try {
        await mintAccessToken(endpoints.googleOauthToken, key);
        return true;
      } catch {
        return false;
      }
    },

    async assess(token): Promise<ConnectorAssessment> {
      const key = parseKey(token);
      if (!key) {
        throw new CredentialFormatError("GCP connection must be a service account JSON key", "a service account key");
      }
      const accessToken = await mintAccessToken(endpoints.googleOauthToken, key);
      const project = key.project_id;

      const inventory: ResourceInventoryItem[] = [];
      const findings: ConnectorAssessment["findings"] = [];

      inventory.push({
        provider: "gcp",
        type: "gcp:project",
        externalId: project,
        name: project,
      });

      // Cloud Run services, one location at a time
      try {
        const services = await cloudRunServices(endpoints.gcpRun, accessToken, project);
        if (services.failedLocations > 0) {
          findings.push({
            category: "inventory",
            severity: "low",
            title: `Cloud Run not read in ${services.failedLocations} region(s)`,
            detail: `Cloud Run did not answer for ${services.failedLocations} of ${services.locations} region(s), so services there are missing from this inventory.`,
          });
        }
        for (const s of services.services) {
          const region = s.name?.split("/locations/")[1]?.split("/")[0];
          inventory.push({
            provider: "gcp",
            type: "gcp:cloud_run_service",
            externalId: s.name,
            name: s.name?.split("/").pop() ?? s.name,
            region,
            metadata: {
              launchStage: s.launchStage ?? null,
              ingress: s.ingress ?? null,
              uri: s.uri ?? null,
              containerImage:
                s.template?.containers?.[0]?.image ?? null,
              cpuLimit:
                s.template?.containers?.[0]?.resources?.limits?.cpu ?? null,
              memoryLimit:
                s.template?.containers?.[0]?.resources?.limits?.memory ?? null,
            },
          });
        }
        const runCount = services.services.length;
        if (runCount > 0) {
          findings.push({
            category: "recommendation",
            severity: "info",
            title: `${runCount} Cloud Run service(s) — Workers or VPS candidates`,
            detail:
              "Cloud Run containers run the same Docker images on a VPS (Docker Compose + systemd) with zero per-request billing. Stateless HTTP services also port to Cloudflare Workers if they fit the edge runtime.",
          });
        }
      } catch {
        // Cloud Run API not enabled; skip.
      }

      // GCE instances
      try {
        const instances = await gFetch(
          accessToken,
          `${endpoints.gcpCompute}/compute/v1/projects/${project}/aggregated/instances`
        );
        for (const [zone, data] of Object.entries(instances.items ?? {}) as [
          string,
          any
        ][]) {
          for (const i of data.instances ?? []) {
            inventory.push({
              provider: "gcp",
              type: "gcp:gce_instance",
              externalId: String(i.id),
              name: i.name,
              region: zone.replace(/^zones\//, ""),
              metadata: {
                machineType: i.machineType?.split("/").pop() ?? null,
                status: i.status ?? null,
                preemptible:
                  i.scheduling?.preemptible ?? false,
              },
            });
          }
        }
      } catch {
        // Compute API not enabled; skip.
      }

      // Cloud SQL instances
      try {
        const sqlInstances = await gFetch(
          accessToken,
          `${endpoints.gcpSqlAdmin}/v1/projects/${project}/instances`
        );
        for (const db of sqlInstances.items ?? []) {
          inventory.push({
            provider: "gcp",
            type: "gcp:cloud_sql",
            externalId: db.name,
            name: db.name,
            region: db.region ?? null,
            metadata: {
              databaseVersion: db.databaseVersion ?? null,
              tier: db.settings?.tier ?? null,
              dataDiskSizeGb:
                db.settings?.dataDiskSizeGb ?? null,
              state: db.state ?? null,
            },
          });
          findings.push({
            category: "recommendation",
            severity: "info",
            title: `${db.name}: Cloud SQL`,
            detail: `Cloud SQL (${db.databaseVersion ?? "unknown"}) migrates to Neon, a VPS Postgres/MySQL, or another managed provider via standard dump/restore. Connection strings move to Terraform-managed env vars.`,
            resourceRef: db.name,
          });
        }
      } catch {
        // Cloud SQL API not enabled; skip.
      }

      // GCS buckets
      try {
        const buckets = await gFetch(
          accessToken,
          `${endpoints.gcpStorage}/storage/v1/b?project=${project}`
        );
        for (const b of buckets.items ?? []) {
          inventory.push({
            provider: "gcp",
            type: "gcp:gcs_bucket",
            externalId: b.id ?? b.name,
            name: b.name,
            region: b.location ?? null,
            metadata: {
              storageClass: b.storageClass ?? null,
              versioning: b.versioning?.enabled ?? false,
            },
          });
        }
        const bucketCount = (buckets.items ?? []).length;
        if (bucketCount > 0) {
          findings.push({
            category: "recommendation",
            severity: "info",
            title: `${bucketCount} GCS bucket(s) — R2 or VPS storage candidates`,
            detail:
              "GCS buckets migrate to Cloudflare R2 (zero egress fees, S3-compatible API) or local storage on a VPS. R2 is the preferred target for public assets.",
          });
        }
      } catch {
        // Storage API not enabled; skip.
      }

      // Cloud Functions (gen2). Unlike Cloud Run, functions.list accepts the
      // "locations/-" wildcard (cloudfunctions v2 discovery document).
      try {
        const fns = await gFetch(
          accessToken,
          `${endpoints.gcpCloudFunctions}/v2/projects/${project}/locations/-/functions`
        );
        for (const f of fns.functions ?? []) {
          inventory.push({
            provider: "gcp",
            type: "gcp:cloud_function",
            externalId: f.name,
            name: f.name?.split("/").pop() ?? f.name,
            region: f.name?.split("/locations/")[1]?.split("/")[0],
            metadata: {
              runtime: f.buildConfig?.runtime ?? null,
              trigger: f.eventTrigger?.eventType ?? "https",
              state: f.state ?? null,
            },
          });
        }
        const fnCount = (fns.functions ?? []).length;
        if (fnCount > 0) {
          findings.push({
            category: "recommendation",
            severity: "info",
            title: `${fnCount} Cloud Function(s) — Workers or VPS candidates`,
            detail:
              "HTTPS-triggered functions port to Cloudflare Workers. Event-triggered functions (Pub/Sub, Eventarc) need re-architecture to Queues, cron, or webhooks.",
          });
        }
      } catch {
        // Functions API not enabled; skip.
      }

      findings.push({
        category: "cost",
        severity: "medium",
        title: "GCP usage-based billing",
        detail:
          "GCP charges per-service with metered compute, storage, and egress. Consolidating to Cloudflare Workers + R2 or a Hetzner VPS eliminates egress fees and per-request billing. Full cost analysis requires Cloud Billing API access, which is confirmed during the assessment engagement.",
      });

      return {
        inventory,
        findings,
        estimatedMonthlyCostCents: null, // Cloud Billing API requires billing account scope
      };
    },
  };
  return connector;
}

export const gcpConnector: Connector = createGcpConnector();
