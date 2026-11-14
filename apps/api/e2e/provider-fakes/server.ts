// ---------------------------------------------------------------------------
// The provider endpoints Prism cannot serve, started on the host by
// global-setup.ts:
//
//   POST /railway/graphql   Railway's GraphQL API
//   POST /fly/graphql       Fly.io's platform GraphQL API (base: /fly)
//   POST /google/token      Google's OAuth 2.0 token endpoint (JWT bearer grant)
//   POST /azure/<tenant>/oauth2/v2.0/token   Microsoft Entra (client credentials)
//
// GraphQL requests are validated against the vendor's own schema subset
// (specs/railway.graphql, specs/flyio.graphql, written by extract.ts from a
// pinned commit) and executed against the seeded root values with that
// schema's types, so an unknown field, a bad argument or a null where the
// vendor promises a value is an error, as it would be from the vendor.
//
// The token endpoints have no machine-readable description from either
// vendor. They are written by hand from the published protocol docs (RFC 7523
// for Google's grant, the Entra client credentials flow) and check only what
// those require: the grant type, the credential, the scope. Google's
// assertion signature is verified against the public key the test registers
// (POST /_fake/google/keys), so a connector that signs wrongly fails here.
//
// GET /_fake/violations lists every refused GraphQL request and every
// execution error, for the tests to assert empty (or not, for the queries a
// finding says the vendor rejects).
// ---------------------------------------------------------------------------

import { createVerify } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSchema, execute, parse, validate, type GraphQLSchema } from "graphql";
import { AZURE_SEED } from "../specs/seeds/azure.js";
import { FLY_GRAPHQL_ROOT } from "../specs/seeds/flyio.js";
import { GOOGLE_SEED } from "../specs/seeds/google.js";
import { RAILWAY_GRAPHQL_ROOT } from "../specs/seeds/railway.js";

const here = dirname(fileURLToPath(import.meta.url));

/** Credentials the fakes accept. Not credentials of anything real. */
export const FAKE_CREDENTIALS = {
  railwayToken: "e2e-railway-token",
  flyToken: "e2e-fly-token",
  azure: { tenantId: AZURE_SEED.tenantId, clientId: "e2e0a0a0-0000-4000-8000-000000000402", clientSecret: "e2e-azure-client-secret", subscriptionId: AZURE_SEED.subscriptionId },
} as const;

export interface Violation {
  endpoint: string;
  query?: string;
  errors: string[];
}

interface GraphqlEndpoint {
  schema: GraphQLSchema;
  root: unknown;
  token: string;
}

function loadSchema(file: string): GraphQLSchema {
  return buildSchema(readFileSync(join(here, "../specs", file), "utf8"));
}

async function body(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function send(res: ServerResponse, status: number, value: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(value));
}

function b64urlJson(part: string): any {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

export class ProviderFakes {
  readonly violations: Violation[] = [];
  private readonly graphql: Record<string, GraphqlEndpoint>;
  /** PEM public keys of service accounts, by client_email. */
  private readonly googleKeys = new Map<string, string>();

  constructor() {
    this.graphql = {
      "/railway/graphql": { schema: loadSchema("railway.graphql"), root: RAILWAY_GRAPHQL_ROOT, token: FAKE_CREDENTIALS.railwayToken },
      "/fly/graphql": { schema: loadSchema("flyio.graphql"), root: FLY_GRAPHQL_ROOT, token: FAKE_CREDENTIALS.flyToken },
    };
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://fake");
    const path = url.pathname;
    if (req.method === "GET" && path === "/_fake/violations") return send(res, 200, this.violations);
    if (req.method === "POST" && path === "/_fake/google/keys") {
      const { clientEmail, publicKeyPem } = JSON.parse(await body(req));
      this.googleKeys.set(clientEmail, publicKeyPem);
      return send(res, 204, null);
    }
    if (req.method !== "POST") return send(res, 404, { error: "not found" });
    const endpoint = this.graphql[path];
    if (endpoint) return this.graphqlRequest(path, endpoint, req, res);
    if (path === "/google/token") return this.googleToken(req, res);
    const azure = path.match(/^\/azure\/([^/]+)\/oauth2\/v2\.0\/token$/);
    if (azure) return this.azureToken(azure[1], req, res);
    return send(res, 404, { error: "not found" });
  }

  private async graphqlRequest(path: string, endpoint: GraphqlEndpoint, req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.headers.authorization !== `Bearer ${endpoint.token}`) return send(res, 401, { errors: [{ message: "Not Authorized" }] });
    const { query, variables } = JSON.parse(await body(req));
    let document;
    try {
      document = parse(query);
    } catch (err) {
      this.violations.push({ endpoint: path, query, errors: [String(err)] });
      return send(res, 400, { errors: [{ message: String(err) }] });
    }
    const invalid = validate(endpoint.schema, document).map((e) => e.message);
    if (invalid.length) {
      this.violations.push({ endpoint: path, query, errors: invalid });
      return send(res, 400, { errors: invalid.map((message) => ({ message })) });
    }
    const result = await execute({ schema: endpoint.schema, document, rootValue: endpoint.root, variableValues: variables });
    if (result.errors?.length) this.violations.push({ endpoint: path, query, errors: result.errors.map((e) => e.message) });
    return send(res, 200, result);
  }

  private async googleToken(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const form = new URLSearchParams(await body(req));
    if (form.get("grant_type") !== "urn:ietf:params:oauth:grant-type:jwt-bearer") return send(res, 400, { error: "unsupported_grant_type" });
    const [header, claims, signature] = (form.get("assertion") ?? "").split(".");
    try {
      const h = b64urlJson(header);
      const c = b64urlJson(claims);
      const key = this.googleKeys.get(c.iss);
      const verifier = createVerify("RSA-SHA256");
      verifier.update(`${header}.${claims}`);
      const signed = h.alg === "RS256" && key && verifier.verify(key, Buffer.from(signature, "base64url"));
      const audience = c.aud === "https://oauth2.googleapis.com/token";
      if (!signed || !audience || typeof c.scope !== "string" || !(c.exp > c.iat)) return send(res, 400, { error: "invalid_grant" });
    } catch {
      return send(res, 400, { error: "invalid_grant" });
    }
    return send(res, 200, { access_token: `ya29.e2e-${GOOGLE_SEED.projectId}`, expires_in: 3599, token_type: "Bearer" });
  }

  private async azureToken(tenant: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const form = new URLSearchParams(await body(req));
    const c = FAKE_CREDENTIALS.azure;
    if (form.get("grant_type") !== "client_credentials") return send(res, 400, { error: "unsupported_grant_type" });
    if (tenant !== c.tenantId || form.get("client_id") !== c.clientId || form.get("client_secret") !== c.clientSecret) return send(res, 401, { error: "invalid_client" });
    if (form.get("scope") !== "https://management.azure.com/.default") return send(res, 400, { error: "invalid_scope" });
    return send(res, 200, { token_type: "Bearer", expires_in: 3599, ext_expires_in: 3599, access_token: "e2e-azure-access-token" });
  }
}

export interface RunningProviderFakes {
  fakes: ProviderFakes;
  server: Server;
  close(): Promise<void>;
}

export async function startProviderFakes(port: number, host = "127.0.0.1"): Promise<RunningProviderFakes> {
  const fakes = new ProviderFakes();
  const server = createServer((req, res) => {
    fakes.handle(req, res).catch((err) => {
      console.error("provider fake:", err);
      send(res, 500, { error: String(err) });
    });
  });
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  return { fakes, server, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}
