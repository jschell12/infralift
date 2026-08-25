import { createSign } from "node:crypto";
import type { ResourceInventoryItem } from "@infralift/shared";
import type { Connector, ConnectorAssessment } from "./types.js";

// GCP assessment via a read-only service account (Viewer role). Uses the same
// JWT bearer flow as the Firebase connector but inventories Cloud Run, GCE,
// Cloud SQL, and GCS rather than Firebase-specific resources. The connection
// "token" is the service account JSON key.

const TOKEN_URL = "https://oauth2.googleapis.com/token";
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

async function mintAccessToken(key: ServiceAccountKey): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(
    JSON.stringify({
      iss: key.client_email,
      scope: SCOPE,
      aud: TOKEN_URL,
      iat: now,
      exp: now + 3600,
    })
  );
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  const signature = signer.sign(key.private_key).toString("base64url");
  const assertion = `${header}.${claims}.${signature}`;

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (!res.ok) {
    throw new Error(`GCP token exchange failed: ${res.status}`);
  }
  const body: any = await res.json();
  return body.access_token as string;
}

async function gFetch(accessToken: string, url: string): Promise<any> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`GCP API ${new URL(url).pathname} -> ${res.status}`);
  }
  return res.json();
}

export const gcpConnector: Connector = {
  provider: "gcp",

  async verify(token) {
    const key = parseKey(token);
    if (!key) return false;
    try {
      await mintAccessToken(key);
      return true;
    } catch {
      return false;
    }
  },

  async assess(token): Promise<ConnectorAssessment> {
    const key = parseKey(token);
    if (!key) {
      throw new Error("GCP connection must be a service account JSON key");
    }
    const accessToken = await mintAccessToken(key);
    const project = key.project_id;

    const inventory: ResourceInventoryItem[] = [];
    const findings: ConnectorAssessment["findings"] = [];

    inventory.push({
      provider: "gcp",
      type: "gcp:project",
      externalId: project,
      name: project,
    });

    // Cloud Run services
    try {
      const services = await gFetch(
        accessToken,
        `https://run.googleapis.com/v2/projects/${project}/locations/-/services`
      );
      for (const s of services.services ?? []) {
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
      const runCount = (services.services ?? []).length;
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
        `https://compute.googleapis.com/compute/v1/projects/${project}/aggregated/instances`
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
        `https://sqladmin.googleapis.com/v1/projects/${project}/instances`
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
        `https://storage.googleapis.com/storage/v1/b?project=${project}`
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

    // Cloud Functions (gen2)
    try {
      const fns = await gFetch(
        accessToken,
        `https://cloudfunctions.googleapis.com/v2/projects/${project}/locations/-/functions`
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
      estimatedMonthlySavingsCents: null,
    };
  },
};
