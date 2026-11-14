// ---------------------------------------------------------------------------
// The spec manifest: every vendor description the e2e stack serves or checks
// against, pinned to a commit (or, where the vendor publishes it only at a
// URL, to an archived copy and its sha256), with the calls infralift makes.
//
// extract.ts reads this and writes one subset per entry; `--check` fails when
// a fresh extraction differs from what is committed. Each entry also records
// the calls a connector makes that the vendor's description does NOT have
// (`undocumented`, `rejectedQueries`). Those are findings, not configuration:
// extract.ts fails if one of them turns up in the description after a pin
// bump, so the finding is revisited rather than silently going stale.
//
// Where no machine-readable description exists at all (Google's and
// Microsoft's OAuth token endpoints), there is no entry: the provider fake
// stands in for them by hand, and README says so.
// ---------------------------------------------------------------------------

import type { DiscoveryOperation, HyperSchemaOperation } from "./convert.js";
import type { OperationRef } from "./openapi.js";

/** A file at a commit in a public GitHub repository. Never a branch. */
export interface GithubPin {
  repo: string;
  commit: string;
  path: string;
}

/** A description published only at a URL that changes. `url` is an immutable
 *  archived copy of it (the Wayback Machine's raw `id_` form), `published` the
 *  vendor's own URL it was taken from, and `sha256` the body's digest. */
export interface UrlPin {
  url: string;
  published: string;
  sha256: string;
}

/** A call a connector makes that the vendor's description does not have. */
export interface Undocumented extends OperationRef {
  /** Who calls it and what happens instead, for the reader of a failed check. */
  note: string;
}

/** The licence the vendor's description is published under, carried into
 *  the subset (info.license and x-infralift-notice, or a comment header in
 *  SDL) and listed in the repository's NOTICE. */
export interface SpecLicense {
  spdx: "MIT" | "Apache-2.0" | "BSD-3-Clause" | "MPL-2.0";
  /** The copyright line of the upstream LICENSE, or the owner where it has none. */
  holder: string;
  /** The upstream LICENSE at the pinned commit. */
  url: string;
}

interface Base {
  name: string;
  /** The file written beside this one. */
  out: string;
  undocumented?: Undocumented[];
  /** null: the description carries no licence that permits redistribution.
   *  Its subset is never committed: extract.ts writes it at setup (scripts/
   *  e2e.sh, CI) from the pin, verified, to a git-ignored path. */
  license: SpecLicense | null;
}

/** One OpenAPI 3 file: the operations and the components they reference,
 *  refs kept (extract.ts subset()). */
export interface OpenApiSource extends Base {
  format: "openapi";
  pin: GithubPin | UrlPin;
  operations: OperationRef[];
}

/** OpenAPI 3 or Swagger 2.0 spread over files, or Swagger 2.0 in one:
 *  bundled into one file with local refs (bundle.ts), then Swagger converted
 *  to OpenAPI 3 (convert.ts). */
export interface BundledSource extends Base {
  format: "bundle";
  repo: string;
  commit: string;
  roots: { path: string; operations: OperationRef[] }[];
}

/** Google API discovery documents, converted (convert.ts). */
export interface DiscoverySource extends Base {
  format: "discovery";
  repo: string;
  commit: string;
  documents: { path: string; operations: DiscoveryOperation[] }[];
}

/** A JSON Hyper-Schema (Heroku), converted (convert.ts). */
export interface HyperSchemaSource extends Base {
  format: "hyper-schema";
  pin: GithubPin;
  operations: HyperSchemaOperation[];
}

/** A GraphQL schema as SDL or as introspection JSON; the subset is SDL
 *  (graphql-subset.ts). */
export interface GraphqlSource extends Base {
  format: "graphql";
  pin: GithubPin;
  schema: "sdl" | "introspection";
  /** The queries the connector sends, copied from it. */
  queries: string[];
  /** Queries the connector sends that the schema rejects, with the error. */
  rejectedQueries?: { query: string; note: string }[];
}

export type SpecSource = OpenApiSource | BundledSource | DiscoverySource | HyperSchemaSource | GraphqlSource;

const get = (path: string): OperationRef => ({ method: "get", path });

// -- GitHub and Cloudflare (PR #149) ---------------------------------------------

/** Every GitHub REST call the adopt path makes (lib/git/github.ts,
 *  lib/git/hosts.ts, connectors/github.ts), plus the ones the e2e harness
 *  makes as the customer and their CI would: creating the repository,
 *  posting the check run, merging or closing the pull request. */
const GITHUB_OPERATIONS: OperationRef[] = [
  { method: "get", path: "/user" },
  { method: "post", path: "/user/repos" },
  { method: "post", path: "/orgs/{org}/repos" },
  { method: "get", path: "/repos/{owner}/{repo}" },
  { method: "get", path: "/repos/{owner}/{repo}/contents/{path}" },
  { method: "get", path: "/repos/{owner}/{repo}/git/ref/{ref}" },
  { method: "post", path: "/repos/{owner}/{repo}/git/refs" },
  { method: "patch", path: "/repos/{owner}/{repo}/git/refs/{ref}" },
  { method: "delete", path: "/repos/{owner}/{repo}/git/refs/{ref}" },
  { method: "post", path: "/repos/{owner}/{repo}/git/blobs" },
  { method: "post", path: "/repos/{owner}/{repo}/git/trees" },
  { method: "get", path: "/repos/{owner}/{repo}/git/trees/{tree_sha}" },
  { method: "post", path: "/repos/{owner}/{repo}/git/commits" },
  { method: "get", path: "/repos/{owner}/{repo}/git/commits/{commit_sha}" },
  { method: "get", path: "/repos/{owner}/{repo}/commits" },
  { method: "get", path: "/repos/{owner}/{repo}/commits/{ref}" },
  { method: "get", path: "/repos/{owner}/{repo}/commits/{ref}/check-runs" },
  { method: "post", path: "/repos/{owner}/{repo}/check-runs" },
  { method: "get", path: "/repos/{owner}/{repo}/check-runs/{check_run_id}/annotations" },
  { method: "get", path: "/repos/{owner}/{repo}/pulls" },
  { method: "post", path: "/repos/{owner}/{repo}/pulls" },
  { method: "get", path: "/repos/{owner}/{repo}/pulls/{pull_number}" },
  { method: "patch", path: "/repos/{owner}/{repo}/pulls/{pull_number}" },
  { method: "put", path: "/repos/{owner}/{repo}/pulls/{pull_number}/merge" },
];

// -- the connectors' queries, copied from src/connectors ---------------------------

/** connectors/flyio.ts, verify and assess. */
export const FLY_QUERIES = [
  "{ viewer { id } }",
  `{
            apps {
              nodes {
                id
                name
                status
                organization { slug }
                regions { code name }
              }
            }
          }`,
];

/** connectors/railway.ts, verify and the inventory query. */
export const RAILWAY_QUERIES = [
  "{ me { id } }",
  `{
        projects {
          edges {
            node {
              id
              name
              description
              environments {
                edges {
                  node {
                    id
                    name
                  }
                }
              }
              services {
                edges {
                  node {
                    id
                    name
                    icon
                  }
                }
              }
              plugins {
                edges {
                  node {
                    id
                    name
                    friendlyName
                  }
                }
              }
            }
          }
        }
      }`,
];

/** connectors/railway.ts, the plan query for the cost estimate. */
export const RAILWAY_PLAN_QUERY = `{
          me {
            id
            projects {
              edges {
                node {
                  id
                  name
                  subscription {
                    plan
                  }
                }
              }
            }
          }
        }`;

// -- the manifest -------------------------------------------------------------------

export const SOURCES: SpecSource[] = [
  {
    name: "github",
    license: { spdx: "MIT", holder: "Copyright (c) 2020 GitHub", url: "https://github.com/github/rest-api-description/blob/53fd7d2ea1380eabdcfcc9ab9a043a56ef444fd6/LICENSE.md" },
    format: "openapi",
    out: "github.openapi.json",
    pin: { repo: "github/rest-api-description", commit: "53fd7d2ea1380eabdcfcc9ab9a043a56ef444fd6", path: "descriptions/api.github.com/api.github.com.json" },
    operations: GITHUB_OPERATIONS,
  },
  {
    name: "cloudflare",
    license: { spdx: "BSD-3-Clause", holder: "Copyright (c) 2022, Cloudflare", url: "https://github.com/cloudflare/api-schemas/blob/8b1a451819bc546d410e41cca71a86bcc2779808/LICENSE" },
    format: "openapi",
    out: "cloudflare.openapi.json",
    pin: { repo: "cloudflare/api-schemas", commit: "8b1a451819bc546d410e41cca71a86bcc2779808", path: "openapi.json" },
    // Every Cloudflare call connectors/cloudflare.ts makes (cloudflare-seed.ts).
    operations: [
      "/user/tokens/verify",
      "/accounts",
      "/accounts/{account_id}/workers/scripts",
      "/accounts/{account_id}/pages/projects",
      "/accounts/{account_id}/r2/buckets",
      "/zones",
      "/zones/{zone_id}/dns_records",
    ].map(get),
  },
  {
    name: "digitalocean",
    license: { spdx: "Apache-2.0", holder: "DigitalOcean, LLC (repository owner; the LICENSE file has no copyright line)", url: "https://github.com/digitalocean/openapi/blob/998192821fe95ee79e41f577933601d009179dcf/LICENSE" },
    format: "bundle",
    out: "digitalocean.openapi.json",
    repo: "digitalocean/openapi",
    commit: "998192821fe95ee79e41f577933601d009179dcf",
    roots: [
      {
        path: "specification/DigitalOcean-public.v2.yaml",
        operations: ["/v2/account", "/v2/droplets", "/v2/apps", "/v2/databases", "/v2/domains", "/v2/kubernetes/clusters"].map(get),
      },
    ],
    undocumented: [
      {
        ...get("/v2/spaces"),
        note: "connectors/digitalocean.ts lists Spaces here; the API has no such path (Spaces is S3-compatible, listed with S3 ListBuckets at <region>.digitaloceanspaces.com), so the call always fails and the connector skips Spaces",
      },
    ],
  },
  {
    name: "render",
    // No licence: api-docs.render.com states none, the file has no
    // info.license, and Render's public repositories do not commit it. So the
    // subset is fetched and checked at setup, never committed.
    license: null,
    format: "openapi",
    out: "render.openapi.json",
    pin: {
      url: "http://web.archive.org/web/20261111030124id_/https://api-docs.render.com/openapi/render-public-api-1.json",
      published: "https://api-docs.render.com/openapi/render-public-api-1.json",
      sha256: "296bf09dc8a0241b6dfc56162805de2468be8d769d6210de5a286cfa0f03fbec",
    },
    operations: ["/owners", "/services", "/postgres", "/redis", "/env-groups"].map(get),
  },
  {
    name: "vercel",
    license: { spdx: "Apache-2.0", holder: "Vercel, Inc. (repository owner; the LICENSE file has no copyright line)", url: "https://github.com/vercel/sdk/blob/fe01b47433aa130b15c68a738a8773d9dd38b190/LICENSE" },
    format: "openapi",
    out: "vercel.openapi.json",
    // Vercel's SDK repository commits the description it is generated from
    // (https://openapi.vercel.sh/, the published one).
    pin: { repo: "vercel/sdk", commit: "fe01b47433aa130b15c68a738a8773d9dd38b190", path: "vercel-spec.json" },
    operations: ["/v2/user", "/v5/domains"].map(get),
    undocumented: [
      {
        ...get("/v9/projects"),
        note: "packages/collectors/vercel.mjs lists projects here; the description has /v10/projects and /v11/projects only, so the mock refuses it and the inventory fails under the mock. Production is unverified: src/connectors/__fixtures__/vercel-api.json is a /v9/projects response captured live on 2026-08-31 (commit 5c6eccb), so v9 still answered then; a real-account check is needed",
      },
    ],
  },
  {
    name: "heroku",
    license: { spdx: "MIT", holder: "Copyright (c) 2014-2016 Timothée Peignier", url: "https://github.com/heroku/heroku-go/blob/eb24213a9cbb17f6af5003d23a92923949f3b48a/LICENSE" },
    format: "hyper-schema",
    out: "heroku.openapi.json",
    // heroku-go is generated from the Platform API's JSON Hyper-Schema
    // (https://api.heroku.com/schema) and commits it. v6, not v5: the live
    // capture in src/connectors/__fixtures__/heroku-api.json fails v5 (no
    // app.generation, no formation.dyno_size, a web_url pattern too short for
    // today's hostnames) and passes v6.
    pin: { repo: "heroku/heroku-go", commit: "eb24213a9cbb17f6af5003d23a92923949f3b48a", path: "v6/schema.json" },
    operations: [
      { resource: "account", link: "Info", path: "/account" },
      { resource: "app", link: "List", path: "/apps" },
      { resource: "formation", link: "List", path: "/apps/{app_id_or_name}/formation" },
      { resource: "add-on", link: "List By App", path: "/apps/{app_id_or_name}/addons" },
    ],
  },
  {
    name: "netlify",
    license: { spdx: "MIT", holder: "Copyright (c) 2016 Netlify", url: "https://github.com/netlify/open-api/blob/96b688490fa406c71e4453e041ec5a0587d35f0b/LICENSE" },
    format: "bundle",
    out: "netlify.openapi.json",
    repo: "netlify/open-api",
    commit: "96b688490fa406c71e4453e041ec5a0587d35f0b",
    roots: [{ path: "swagger.yml", operations: ["/user", "/sites", "/dns_zones", "/sites/{site_id}/build_hooks"].map(get) }],
    undocumented: [
      {
        ...get("/forms"),
        note: "connectors/netlify.ts lists forms here; the API lists them per site (/sites/{site_id}/forms), so the call fails and the connector reports no forms",
      },
    ],
  },
  {
    name: "flyio-machines",
    license: { spdx: "Apache-2.0", holder: "Fly.io, Inc. (repository owner; the LICENSE file has no copyright line)", url: "https://github.com/superfly/docs/blob/040858621eea858652b156a71ffe6472e3af724b/LICENSE" },
    format: "openapi",
    out: "flyio-machines.openapi.json",
    pin: { repo: "superfly/docs", commit: "040858621eea858652b156a71ffe6472e3af724b", path: "api/machines/openapi.json" },
    operations: ["/v1/apps/{app_name}/machines", "/v1/apps/{app_name}/volumes"].map(get),
  },
  {
    name: "flyio",
    license: { spdx: "Apache-2.0", holder: "Fly.io, Inc. (repository owner; the LICENSE file has no copyright line)", url: "https://github.com/superfly/fly-go/blob/84b82d65ccb067218680ddb4b6a5c10d3e05078d/LICENSE" },
    format: "graphql",
    out: "flyio.graphql",
    // fly-go is Fly.io's Go client for api.fly.io/graphql and commits the schema.
    pin: { repo: "superfly/fly-go", commit: "84b82d65ccb067218680ddb4b6a5c10d3e05078d", path: "schema.graphql" },
    schema: "sdl",
    queries: FLY_QUERIES,
  },
  {
    name: "railway",
    license: { spdx: "MIT", holder: "Copyright (c) 2023 Railway Corp.", url: "https://github.com/railwayapp/cli/blob/7da7f0d4dd6061656ed0b001c193945887ee645a/LICENSE" },
    format: "graphql",
    out: "railway.graphql",
    // Railway's CLI commits the introspection result of backboard.railway.com/graphql/v2.
    pin: { repo: "railwayapp/cli", commit: "7da7f0d4dd6061656ed0b001c193945887ee645a", path: "src/gql/schema.json" },
    schema: "introspection",
    queries: RAILWAY_QUERIES,
    rejectedQueries: [
      {
        query: RAILWAY_PLAN_QUERY,
        note: "connectors/railway.ts asks for Project.subscription { plan }, which the schema does not have (it has subscriptionType), so the plan query always fails and the cost estimate is always $0",
      },
    ],
  },
  {
    name: "azure",
    license: { spdx: "MIT", holder: "Copyright (c) 2017 Microsoft", url: "https://github.com/Azure/azure-rest-api-specs/blob/6a42ee6dd4a2c09f9f03eba31cc13ab20e434353/LICENSE" },
    format: "bundle",
    out: "azure.openapi.json",
    repo: "Azure/azure-rest-api-specs",
    commit: "6a42ee6dd4a2c09f9f03eba31cc13ab20e434353",
    // The API versions connectors/azure.ts sends.
    roots: [
      {
        path: "specification/web/resource-manager/Microsoft.Web/AppService/stable/2024-04-01/WebApps.json",
        operations: [get("/subscriptions/{subscriptionId}/providers/Microsoft.Web/sites")],
      },
      {
        path: "specification/web/resource-manager/Microsoft.Web/AppService/stable/2024-04-01/AppServicePlans.json",
        operations: [get("/subscriptions/{subscriptionId}/providers/Microsoft.Web/serverfarms")],
      },
      {
        path: "specification/compute/resource-manager/Microsoft.Compute/Compute/stable/2024-07-01/virtualMachine.json",
        operations: [get("/subscriptions/{subscriptionId}/providers/Microsoft.Compute/virtualMachines")],
      },
      {
        path: "specification/sql/resource-manager/Microsoft.Sql/SQL/preview/2023-08-01-preview/Servers.json",
        operations: [get("/subscriptions/{subscriptionId}/providers/Microsoft.Sql/servers")],
      },
      {
        path: "specification/sql/resource-manager/Microsoft.Sql/SQL/preview/2023-08-01-preview/Databases.json",
        operations: [get("/subscriptions/{subscriptionId}/resourceGroups/{resourceGroupName}/providers/Microsoft.Sql/servers/{serverName}/databases")],
      },
      {
        path: "specification/storage/resource-manager/Microsoft.Storage/Storage/stable/2023-05-01/storage.json",
        operations: [get("/subscriptions/{subscriptionId}/providers/Microsoft.Storage/storageAccounts")],
      },
    ],
  },
  {
    name: "google",
    license: { spdx: "BSD-3-Clause", holder: "Copyright (c) 2011 Google Inc. All rights reserved.", url: "https://github.com/googleapis/google-api-go-client/blob/2a50de2f986c6287e7c29d3bdfbf0e6defe9923c/LICENSE" },
    format: "discovery",
    out: "google.openapi.json",
    // google-api-go-client commits each API's discovery document.
    repo: "googleapis/google-api-go-client",
    commit: "2a50de2f986c6287e7c29d3bdfbf0e6defe9923c",
    documents: [
      { path: "run/v2/run-api.json", operations: [{ id: "run.projects.locations.services.list", path: "/v2/projects/{project}/locations/{location}/services" }] },
      { path: "compute/v1/compute-api.json", operations: [{ id: "compute.instances.aggregatedList", path: "/compute/v1/projects/{project}/aggregated/instances" }] },
      { path: "sqladmin/v1/sqladmin-api.json", operations: [{ id: "sql.instances.list", path: "/v1/projects/{project}/instances" }] },
      { path: "storage/v1/storage-api.json", operations: [{ id: "storage.buckets.list", path: "/storage/v1/b" }] },
      {
        path: "cloudfunctions/v2/cloudfunctions-api.json",
        operations: [{ id: "cloudfunctions.projects.locations.functions.list", path: "/v2/projects/{project}/locations/{location}/functions" }],
      },
      { path: "firebasehosting/v1beta1/firebasehosting-api.json", operations: [{ id: "firebasehosting.projects.sites.list", path: "/v1beta1/projects/{project}/sites" }] },
      { path: "firestore/v1/firestore-api.json", operations: [{ id: "firestore.projects.databases.list", path: "/v1/projects/{project}/databases" }] },
    ],
  },
  {
    name: "tfc",
    license: { spdx: "MPL-2.0", holder: "Copyright (c) 2018 HashiCorp, Inc.", url: "https://github.com/hashicorp/go-tfe/blob/55fa43504b980ba9a50d73a3e69772d1d6819239/LICENSE" },
    format: "openapi",
    out: "tfc.openapi.json",
    // HashiCorp's go-tfe commits the HCP Terraform API description. Not
    // served: TFC is not a connector (no verify, no inventory), and the
    // adopt path the e2e suite runs does not call it. The recorded fixtures
    // in lib/tf/__fixtures__/tfc are checked against it instead
    // (apps/api/e2e/specs/fixtures-match-specs.test.ts).
    pin: { repo: "hashicorp/go-tfe", commit: "55fa43504b980ba9a50d73a3e69772d1d6819239", path: "v2/openapi/spec.json" },
    operations: [
      "/organizations/{organization_name}/workspaces",
      "/workspaces/{workspace_id}",
      "/organizations/{organization_name}/oauth-clients",
      "/oauth-clients/{oauth_client_id}/oauth-tokens",
      "/workspaces/{workspace_id}/runs",
    ].map(get),
  },
];
