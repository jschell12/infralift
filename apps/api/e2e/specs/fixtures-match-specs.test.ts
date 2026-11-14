// ---------------------------------------------------------------------------
// The recorded API responses the unit tests run connectors over, checked
// against the vendor descriptions the e2e stack is built from
// (the *.openapi.json beside this file, written by extract.ts from the pins in
// sources.ts). Runs in the ordinary `pnpm test`, like github-fake/fake.test.ts.
//
// Two checks per fixture, because each catches what the other cannot:
//
//   - schema: the response, with every required field the recording trimmed
//     filled in (fillRequired), validates against the operation's 200
//     schema. A wrong type or a wrong shape fails.
//   - declared: every field the recording carries is one the description
//     declares (undeclaredFields). Most vendor schemas leave
//     additionalProperties open, so an invented field passes validation and
//     only this catches it.
//
// A fixture that fails is not edited to pass: it is replaced with one that
// follows the description, or, where the description is what is wrong, the
// case is listed in KNOWN with the reason.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fillRequired, responseSchema, SpecValidator, undeclaredFields, type OpenApiDocument } from "./openapi.js";

const spec = (name: string): OpenApiDocument => JSON.parse(readFileSync(new URL(`./${name}.openapi.json`, import.meta.url), "utf8"));
/** A recorded fixture, by its path under apps/api/src. */
const fixture = (path: string): any => JSON.parse(readFileSync(new URL(`../../src/${path}`, import.meta.url), "utf8"));

interface Case {
  name: string;
  spec: string;
  path: string;
  body: unknown;
}

const heroku = fixture("connectors/__fixtures__/heroku-api.json");
const cloudflare = fixture("connectors/__fixtures__/cloudflare-api.json");
const cfVerify = fixture("connectors/__fixtures__/cloudflare-token-verify.json");
const gcp = fixture("connectors/__fixtures__/gcp-api.json");
const tfc = (file: string) => fixture(`lib/tf/__fixtures__/tfc/${file}.json`);

const CASES: Case[] = [
  { name: "heroku-api.json /apps", spec: "heroku", path: "/apps", body: heroku["/apps"] },
  ...Object.entries(heroku)
    .filter(([k]) => k.endsWith("/formation"))
    .map(([k, body]) => ({ name: `heroku-api.json ${k}`, spec: "heroku", path: "/apps/{app_id_or_name}/formation", body })),
  ...Object.entries(heroku)
    .filter(([k]) => k.endsWith("/addons"))
    .map(([k, body]) => ({ name: `heroku-api.json ${k}`, spec: "heroku", path: "/apps/{app_id_or_name}/addons", body })),
  { name: "vercel-api.json /v5/domains", spec: "vercel", path: "/v5/domains", body: fixture("connectors/__fixtures__/vercel-api.json")["/v5/domains"] },
  { name: "cloudflare-api.json accounts", spec: "cloudflare", path: "/accounts", body: cloudflare.accounts },
  { name: "cloudflare-api.json zonesPage1", spec: "cloudflare", path: "/zones", body: cloudflare.zonesPage1 },
  { name: "cloudflare-api.json zonesPage2", spec: "cloudflare", path: "/zones", body: cloudflare.zonesPage2 },
  { name: "cloudflare-api.json dnsRecords", spec: "cloudflare", path: "/zones/{zone_id}/dns_records", body: cloudflare.dnsRecords },
  { name: "cloudflare-api.json r2Buckets", spec: "cloudflare", path: "/accounts/{account_id}/r2/buckets", body: cloudflare.r2Buckets },
  { name: "cloudflare-token-verify.json active", spec: "cloudflare", path: "/user/tokens/verify", body: cfVerify.active },
  { name: "cloudflare-token-verify.json noExpiry", spec: "cloudflare", path: "/user/tokens/verify", body: cfVerify.noExpiry },
  { name: "gcp-api.json sqlInstances", spec: "google", path: "/v1/projects/{project}/instances", body: gcp.sqlInstances },
  { name: "gcp-api.json buckets", spec: "google", path: "/storage/v1/b", body: gcp.buckets },
  { name: "tfc oauth-clients.json", spec: "tfc", path: "/organizations/{organization_name}/oauth-clients", body: tfc("oauth-clients") },
  { name: "tfc oauth-tokens.json", spec: "tfc", path: "/oauth-clients/{oauth_client_id}/oauth-tokens", body: tfc("oauth-tokens") },
  { name: "tfc runs-with-plan.json", spec: "tfc", path: "/workspaces/{workspace_id}/runs", body: tfc("runs-with-plan") },
  { name: "tfc workspace-vcs.json", spec: "tfc", path: "/workspaces/{workspace_id}", body: tfc("workspace-vcs") },
  { name: "tfc workspaces-page.json", spec: "tfc", path: "/organizations/{organization_name}/workspaces", body: tfc("workspaces-page") },
];

/** Fixtures that differ from the description for a reason the description
 *  is wrong about, by case name: the fields allowed and why. Empty is the
 *  goal; each entry is a finding against the vendor, not against us. */
const KNOWN: Record<string, { fields: string[]; why: string }> = {
  "cloudflare-api.json accounts": {
    fields: ["$.result_info.total_pages"],
    why: "Cloudflare's API reference example for GET /accounts has total_pages; the schema (iam_result_info) does not. connectors/cloudflare.ts pages on it, so it relies on a field the description does not promise.",
  },
  "tfc oauth-clients.json": {
    fields: ["$.data[0].relationships.oauth-tokens.links"],
    why: "HashiCorp's List OAuth Clients doc sample has a links object on the relationship; go-tfe's OpenAPI does not declare one. infralift does not read it.",
  },
  "tfc workspace-vcs.json": {
    fields: ["$.data.attributes.vcs-repo.repository-http-url", "$.data.attributes.vcs-repo.service-provider"],
    why: "HashiCorp's workspace doc sample has both; go-tfe's OpenAPI vcs-repo object declares neither. lib/tf/tfc-client.ts reads repository-http-url (vcsRepoUrl), so it relies on a field the description does not promise.",
  },
};

const docs = new Map<string, { doc: OpenApiDocument; validator: SpecValidator }>();
function load(name: string) {
  let entry = docs.get(name);
  if (!entry) {
    const doc = spec(name);
    entry = { doc, validator: new SpecValidator(doc) };
    docs.set(name, entry);
  }
  return entry;
}

describe("recorded fixtures follow the vendors' descriptions", () => {
  it.each(CASES)("$name matches $spec GET $path", ({ name, spec: specName, path, body }) => {
    const { doc, validator } = load(specName);
    const schema = responseSchema(doc, { method: "get", path }, 200);
    expect(schema, `${path} has no JSON 200 response in ${specName}`).toBeTruthy();
    expect(validator.check(schema!, fillRequired(doc, schema!, body)), "schema").toBeNull();
    const allowed = new Set(KNOWN[name]?.fields ?? []);
    expect(undeclaredFields(doc, schema!, body).filter((f) => !allowed.has(f)), "fields the description does not declare").toEqual([]);
  });
});
