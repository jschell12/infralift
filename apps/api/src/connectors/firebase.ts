import { createSign } from "node:crypto";
import type { ResourceInventoryItem } from "@infralift/shared";
import type { Connector, ConnectorAssessment } from "./types.js";

// Firebase/GCP assessment via a read-only service account. The connection
// "token" is the service account JSON key (roles: Viewer or the granular
// firebase.viewer + cloudfunctions.viewer + datastore.viewer). We mint an
// OAuth2 access token with the JWT bearer flow using node:crypto — no SDK
// dependency — and only call read endpoints.

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

export const firebaseConnector: Connector = {
  provider: "firebase",

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
      throw new Error("Firebase connection must be a service account JSON key");
    }
    const accessToken = await mintAccessToken(key);
    const project = key.project_id;

    const inventory: ResourceInventoryItem[] = [];
    const findings: ConnectorAssessment["findings"] = [];

    inventory.push({
      provider: "firebase",
      type: "firebase:project",
      externalId: project,
      name: project,
    });

    // Hosting sites
    try {
      const sites = await gFetch(
        accessToken,
        `https://firebasehosting.googleapis.com/v1beta1/projects/${project}/sites`
      );
      for (const s of sites.sites ?? []) {
        inventory.push({
          provider: "firebase",
          type: "firebase:hosting_site",
          externalId: s.name,
          name: s.name?.split("/").pop() ?? s.name,
          metadata: { defaultUrl: s.defaultUrl ?? null, type: s.type ?? null },
        });
      }
      if ((sites.sites ?? []).length > 0) {
        findings.push({
          category: "recommendation",
          severity: "info",
          title: "Firebase Hosting → Cloudflare",
          detail:
            "Firebase Hosting sites (static + rewrites) map directly onto Cloudflare Workers static assets or Pages, removing per-GB hosting/egress charges.",
        });
      }
    } catch {
      // Hosting API not enabled or no permission; skip.
    }

    // Cloud Functions (gen1 + gen2)
    try {
      const fns = await gFetch(
        accessToken,
        `https://cloudfunctions.googleapis.com/v2/projects/${project}/locations/-/functions`
      );
      for (const f of fns.functions ?? []) {
        inventory.push({
          provider: "firebase",
          type: "firebase:function",
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
      if ((fns.functions ?? []).length > 0) {
        findings.push({
          category: "recommendation",
          severity: "info",
          title: `${(fns.functions ?? []).length} Cloud Functions — Workers candidates`,
          detail:
            "HTTPS-triggered functions port to Cloudflare Workers; Firestore/PubSub-triggered functions need re-architecture (Queues, cron, or webhooks) — flagged per-function in the migration plan.",
        });
      }
    } catch {
      // Functions API not enabled; skip.
    }

    // Firestore databases
    try {
      const dbs = await gFetch(
        accessToken,
        `https://firestore.googleapis.com/v1/projects/${project}/databases`
      );
      for (const d of dbs.databases ?? []) {
        inventory.push({
          provider: "firebase",
          type: "firebase:firestore_database",
          externalId: d.name,
          name: d.name?.split("/").pop() ?? d.name,
          metadata: {
            locationId: d.locationId ?? null,
            firestoreType: d.type ?? null,
          },
        });
      }
      if ((dbs.databases ?? []).length > 0) {
        findings.push({
          category: "risk",
          severity: "medium",
          title: "Firestore data model is the migration's critical path",
          detail:
            "Firestore per-document read pricing and NoSQL modeling are the usual exit drivers. Migration maps collections to a relational Postgres schema (Neon, VPS, or RDS); security rules become application-layer authorization. This phase is scoped explicitly in the fixed-fee quote.",
        });
      }
    } catch {
      // Firestore API not enabled; skip.
    }

    findings.push({
      category: "inventory",
      severity: "info",
      title: "Firebase Auth inventoried during engagement",
      detail:
        "Firebase Auth password hashes are exportable (scrypt with retrievable parameters), so user accounts migrate without forced resets. User counts and providers are confirmed during the assessment call.",
    });

    return {
      inventory,
      findings,
      estimatedMonthlyCostCents: null, // billing needs the Cloud Billing API + billing account scope
    };
  },
};
