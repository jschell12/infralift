// ---------------------------------------------------------------------------
// Connect and inventory every provider whose connector only had recorded
// fixtures before: each one verifies a credential and lists its seeded
// account in the unmanaged view, against the vendor's own description.
//
//   Prism (docker-compose.e2e.yml, profile "mocks")   DigitalOcean, Render,
//     Vercel, Heroku, Netlify, Fly.io Machines, Azure, Google Cloud/Firebase
//   provider fake (provider-fakes/server.ts)           Railway and Fly.io
//     GraphQL, executed against the vendors' schemas; OAuth token endpoints
//
// Pins: specs/sources.ts. Seeds: specs/seeds/. Each provider gets its own
// API process (harness/api-process.ts): the unmanaged view allows an org ten
// provider reads per ten minutes, in-process.
//
// Where a connector calls something the vendor's description does not have
// (sources.ts `undocumented`, `rejectedQueries`), the test pins what happens
// today and names the finding, so fixing the connector means changing the
// test on purpose.
// ---------------------------------------------------------------------------

import { generateKeyPairSync } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApi, type RunningApi } from "./harness/api-process.js";
import { STACK } from "./harness/env.js";
import { FAKE_CREDENTIALS, type Violation } from "./provider-fakes/server.js";
import { AZURE_IDS, AZURE_SEED } from "./specs/seeds/azure.js";
import { DO_SEED } from "./specs/seeds/digitalocean.js";
import { FLY_SEED } from "./specs/seeds/flyio.js";
import { GOOGLE_NAMES, GOOGLE_SEED } from "./specs/seeds/google.js";
import { HEROKU_SEED } from "./specs/seeds/heroku.js";
import { NETLIFY_SEED } from "./specs/seeds/netlify.js";
import { RAILWAY_SEED } from "./specs/seeds/railway.js";
import { RENDER_SEED } from "./specs/seeds/render.js";
import { VERCEL_SEED } from "./specs/seeds/vercel.js";

let nextPort = STACK.apiPort + 1;
/** Labels are unique per org and provider; a kept stack (E2E_KEEP=1) is reused. */
const RUN = Date.now().toString(36);

/** The infralift API of one provider's describe block. */
function ownApi(provider: string): { call: <T = any>(method: string, path: string, body?: unknown) => Promise<{ status: number; body: T }> } {
  let api: RunningApi;
  beforeAll(async () => {
    api = await startApi(nextPort++, `.api-${provider}.log`);
  });
  afterAll(() => api?.stop());
  return {
    call: async (method, path, body) => {
      const res = await fetch(`${api.url}${path}`, {
        method,
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    },
  };
}

/** Connects `provider` with `token`, expecting the credential to verify, and
 *  returns the unmanaged view's rows keyed "<type> <providerId>". */
function connectAndList(provider: string, token: () => string | Promise<string>) {
  const { call } = ownApi(provider);
  const state: { id?: string; rows?: Map<string, any>; status?: number; body?: any; call: typeof call } = { call };
  it(`connects ${provider}: the credential verifies against the mock`, async () => {
    const { status, body } = await call("POST", "/connections", { provider, label: `e2e ${provider} ${RUN}`, token: await token() });
    expect(status, JSON.stringify(body)).toBe(201);
    expect(body).toMatchObject({ status: "valid", lastError: null });
    state.id = body.id;
  });
  it(`reads the ${provider} account into the unmanaged view`, async () => {
    expect(state.id, "the connection was not created").toBeTruthy();
    const { status, body } = await call("GET", `/connections/${state.id}/unmanaged?refresh=1`);
    state.status = status;
    state.body = body;
    if (status === 200) state.rows = new Map(body.resources.map((r: any) => [`${r.type} ${r.providerId}`, r]));
  });
  return state;
}

async function fakeViolations(): Promise<Violation[]> {
  return (await fetch(`${STACK.providerFakes}/_fake/violations`)).json() as Promise<Violation[]>;
}

const keysOf = (rows: Map<string, any> | undefined) => [...(rows?.keys() ?? [])].sort();

describe("DigitalOcean (Prism, digitalocean/openapi)", () => {
  const s = connectAndList("digitalocean", () => "e2e-digitalocean-token");
  it("lists the droplet, app, database, domain and cluster", () => {
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    expect(keysOf(s.rows)).toEqual(
      [
        `digitalocean:app ${DO_SEED.app.id}`,
        `digitalocean:database ${DO_SEED.database.id}`,
        `digitalocean:domain ${DO_SEED.domain.name}`,
        `digitalocean:droplet ${DO_SEED.droplet.id}`,
        `digitalocean:kubernetes ${DO_SEED.cluster.id}`,
      ].sort()
    );
    expect(s.rows!.get(`digitalocean:droplet ${DO_SEED.droplet.id}`)).toMatchObject({ name: DO_SEED.droplet.name, region: "nyc3" });
  });
  it("refuses a second connection with the same label: 409 and a sentence, not a 500", async () => {
    const { status, body } = await s.call("POST", "/connections", { provider: "digitalocean", label: `e2e digitalocean ${RUN}`, token: "e2e-digitalocean-token" });
    expect(status, JSON.stringify(body)).toBe(409);
    expect(body.error).toBe(`You already have a DigitalOcean connection called "e2e digitalocean ${RUN}". Pick another name, or replace that connection's credential instead.`);
  });
  it("finding: no Spaces, because GET /v2/spaces is not in DigitalOcean's API", async () => {
    expect([...s.rows!.keys()].some((k) => k.startsWith("digitalocean:space"))).toBe(false);
    expect((await fetch(`${STACK.mocks.digitalocean}/v2/spaces`, { headers: { authorization: "Bearer h" } })).status).toBe(404);
  });
});

describe("Render (Prism, api-docs.render.com archived)", () => {
  const s = connectAndList("render", () => "e2e-render-token");
  it("lists the service, Postgres, Redis and env group", () => {
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    expect(keysOf(s.rows)).toEqual(
      [
        `render:web_service ${RENDER_SEED.service.id}`,
        `render:postgres ${RENDER_SEED.postgres.id}`,
        `render:redis ${RENDER_SEED.redis.id}`,
        `render:env_group ${RENDER_SEED.envGroup.id}`,
      ].sort()
    );
    expect(s.rows!.get(`render:postgres ${RENDER_SEED.postgres.id}`)).toMatchObject({ name: RENDER_SEED.postgres.name, region: "oregon" });
  });
});

describe("Vercel (Prism, vercel/sdk vercel-spec.json)", () => {
  const s = connectAndList("vercel", () => "e2e-vercel-token");
  // #153 finding 1: the collector listed projects at /v9/projects, which the
  // description does not have, and this test pinned the 502. It now lists
  // them at the documented /v10/projects.
  it("lists the project and the domain", () => {
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    expect(keysOf(s.rows)).toEqual([`vercel:domain ${VERCEL_SEED.domain.id}`, `vercel:project ${VERCEL_SEED.project.id}`].sort());
    expect(s.rows!.get(`vercel:project ${VERCEL_SEED.project.id}`)).toMatchObject({ name: VERCEL_SEED.project.name });
  });
});

describe("Heroku (Prism, heroku/heroku-go schema.json)", () => {
  const s = connectAndList("heroku", () => "e2e-heroku-token");
  it("lists the app, its dyno formation and its add-on", () => {
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    expect(keysOf(s.rows)).toEqual(
      [`heroku:app ${HEROKU_SEED.app.id}`, `heroku:dyno ${HEROKU_SEED.app.id}:${HEROKU_SEED.dyno.type}`, `heroku:addon ${HEROKU_SEED.addon.id}`].sort()
    );
    expect(s.rows!.get(`heroku:app ${HEROKU_SEED.app.id}`)).toMatchObject({ name: HEROKU_SEED.app.name });
  });
});

describe("Netlify (Prism, netlify/open-api swagger.yml)", () => {
  const s = connectAndList("netlify", () => "e2e-netlify-token");
  // #153 finding 3: forms were read at GET /forms, which Netlify does not
  // have, and never listed. They are read per site now.
  it("lists the site, its DNS zone, its build hooks and its form", () => {
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    expect(keysOf(s.rows)).toEqual(
      [
        `netlify:site ${NETLIFY_SEED.site.id}`,
        `netlify:dns_zone ${NETLIFY_SEED.zone.id}`,
        `netlify:build_hook ${NETLIFY_SEED.site.id}:hooks`,
        `netlify:form ${NETLIFY_SEED.form.id}`,
      ].sort()
    );
    expect(s.rows!.get(`netlify:form ${NETLIFY_SEED.form.id}`)).toMatchObject({ name: `${NETLIFY_SEED.site.name}: ${NETLIFY_SEED.form.name}` });
  });
});

describe("Fly.io (provider fake GraphQL, superfly/fly-go; Prism Machines API, superfly/docs)", () => {
  const s = connectAndList("flyio", () => FAKE_CREDENTIALS.flyToken);
  it("lists the app, its machine and its volume", () => {
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    expect(keysOf(s.rows)).toEqual([`flyio:app ${FLY_SEED.app.id}`, `flyio:machine ${FLY_SEED.machine.id}`, `flyio:volume ${FLY_SEED.volume.id}`].sort());
    expect(s.rows!.get(`flyio:machine ${FLY_SEED.machine.id}`)).toMatchObject({ region: "iad" });
  });
  it("sent only GraphQL the schema accepts", async () => {
    expect((await fakeViolations()).filter((v) => v.endpoint === "/fly/graphql")).toEqual([]);
  });
});

describe("Railway (provider fake GraphQL, railwayapp/cli schema.json)", () => {
  const s = connectAndList("railway", () => FAKE_CREDENTIALS.railwayToken);
  it("lists the project, its service and its environment", () => {
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    expect(keysOf(s.rows)).toEqual(
      [`railway:project ${RAILWAY_SEED.project.id}`, `railway:service ${RAILWAY_SEED.service.id}`, `railway:environment ${RAILWAY_SEED.environment.id}`].sort()
    );
  });
  it("finding: the plan query is refused, because Project has no `subscription` field", async () => {
    // The fake holds only the subset the valid queries use, so its message
    // names the first missing field it meets. The vendor's own refusal
    // ('Cannot query field "subscription" on type "Project"') is checked
    // against the full schema by extract.ts (sources.ts rejectedQueries).
    const railway = (await fakeViolations()).filter((v) => v.endpoint === "/railway/graphql");
    expect(railway).toHaveLength(1);
    expect(railway[0].query).toContain("subscription");
    expect(railway[0].errors.join(" ")).toMatch(/^Cannot query field/);
  });
});

describe("Azure (Prism, Azure/azure-rest-api-specs; provider fake Entra token)", () => {
  const s = connectAndList("azure", () => JSON.stringify(FAKE_CREDENTIALS.azure));
  it("lists the subscription, app service, plan, VM, SQL server and database, and storage account", () => {
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    expect(keysOf(s.rows)).toEqual(
      [
        `azure:subscription ${AZURE_SEED.subscriptionId}`,
        `azure:app_service ${AZURE_IDS.site}`,
        `azure:app_service_plan ${AZURE_IDS.plan}`,
        `azure:virtual_machine ${AZURE_IDS.vm}`,
        `azure:sql_server ${AZURE_IDS.sqlServer}`,
        `azure:sql_database ${AZURE_IDS.sqlDatabase}`,
        `azure:storage_account ${AZURE_IDS.storage}`,
      ].sort()
    );
  });
});

/** A service account key for the seeded project, its public half registered
 *  with the token fake so the connector's signed assertion is checked. */
async function googleKey(): Promise<string> {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  await fetch(`${STACK.providerFakes}/_fake/google/keys`, {
    method: "POST",
    body: JSON.stringify({ clientEmail: GOOGLE_SEED.clientEmail, publicKeyPem: publicKey.export({ type: "spki", format: "pem" }) }),
  });
  return JSON.stringify({
    type: "service_account",
    project_id: GOOGLE_SEED.projectId,
    client_email: GOOGLE_SEED.clientEmail,
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
  });
}

describe("Google Cloud (Prism, googleapis discovery documents; provider fake OAuth token)", () => {
  const s = connectAndList("gcp", googleKey);
  it("lists the project, Cloud Run service, VM, Cloud SQL instance, bucket and function", () => {
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    expect(keysOf(s.rows)).toEqual(
      [
        `gcp:project ${GOOGLE_SEED.projectId}`,
        `gcp:cloud_run_service ${GOOGLE_NAMES.runService}`,
        `gcp:gce_instance ${GOOGLE_NAMES.instance.id}`,
        `gcp:cloud_sql ${GOOGLE_NAMES.sqlInstance}`,
        `gcp:gcs_bucket ${GOOGLE_NAMES.bucket}`,
        `gcp:cloud_function ${GOOGLE_NAMES.function}`,
      ].sort()
    );
  });
});

describe("Firebase (Prism, googleapis discovery documents; provider fake OAuth token)", () => {
  const s = connectAndList("firebase", googleKey);
  it("lists the project, hosting site, function and Firestore database", () => {
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    expect(keysOf(s.rows)).toEqual(
      [
        `firebase:project ${GOOGLE_SEED.projectId}`,
        `firebase:hosting_site ${GOOGLE_NAMES.hostingSite}`,
        `firebase:function ${GOOGLE_NAMES.function}`,
        `firebase:firestore_database ${GOOGLE_NAMES.firestore}`,
      ].sort()
    );
  });
});
