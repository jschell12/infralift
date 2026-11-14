# infralift

infralift writes and maintains your infrastructure as code in your own repository. Changes to a repository you work in (stacks, imports, adoptions) arrive as pull requests you review and merge. A project is the Terraform for one cloud account in one environment: adopt what an account already runs, start from a stack, or bring Terraform you already have, without touching what is running.

What it sells on:

- **Import that changes nothing running.** Existing Terraform, or resources built by hand in a cloud console, come under infralift only after a read-only plan proves no resource would change, so taking them over does not touch what is running.
- **Cost comparison** of what you run against the alternatives.
- **Security.** Your state and cloud credentials stay with you; checks run in your CI.

## Where to read next

- [`ARCHITECTURE.md`](ARCHITECTURE.md): how the code is organized, the design patterns it uses and where, and how a request and a job flow through it.
- [`docs/adr/`](docs/adr/): the decisions behind it.
- [`docs/`](docs/README.md): customer-facing documentation.
- [`e2e/`](e2e/README.md): end-to-end runbooks.

## Structure

| Package | Purpose |
| --- | --- |
| `apps/web` | Marketing site and the public cost estimator (Next.js on a Cloudflare Worker) |
| `apps/dashboard` | The customer app (Next.js): projects, connections, assessments, imports |
| `apps/admin` | Internal tools (Next.js) |
| `apps/api` | The backend (Express, Prisma, Postgres): routes, services, jobs, connectors, stacks |
| `packages/shared` | Types shared by the API and the apps |
| `packages/collectors` | Snapshot scripts a customer can run instead of granting a token |

## Development

```bash
pnpm install
pnpm db:generate
pnpm dev                              # web :3000, dashboard :3001, api :4000
pnpm --filter @infralift/api test
pnpm --filter @infralift/api validate:stacks
make e2e                              # end to end, no cloud accounts (Docker)
```

`apps/api` needs a Postgres `DATABASE_URL` (see `apps/api/.env.example`). Credentials for local work come from scredmgr, never from files in the repository.

## Testing without cloud accounts

`make e2e` (or `pnpm e2e`) runs the adopt path end to end on your machine with no cloud account, no git host and no spend. It needs Docker. It brings up `docker-compose.e2e.yml`, runs `apps/api/e2e`, and tears the stack down; a run takes a few minutes once the images and providers are cached. `E2E_KEEP=1 make e2e` leaves the stack up. Each checkout gets its own compose project and its own block of 100 ports, derived from its path (`apps/api/e2e/harness/ports.ts`; `scripts/e2e.sh` prints both), so suites in two worktrees can run at once; `E2E_PORT_BASE` and `E2E_PROJECT` override them.

The API runs from source with every provider endpoint pointed at the stack through `INFRALIFT_ENDPOINT_*` variables (`apps/api/src/lib/endpoints.ts`, one per API; the defaults are the real endpoints). A server refuses to start with any of them set unless `NODE_ENV` is exactly `development` or `test` (unset or any other value refuses), because an override sends customer credentials to another host. The suite runs the API with `NODE_ENV=development`.

What is real and what stands in for it:

| Part | In the e2e stack | How far it is trusted |
| --- | --- | --- |
| infralift API, job worker, Postgres | Real, from source, on a throwaway Postgres 16 | The code under test |
| AWS | [moto](https://github.com/getmoto/moto) 5.2.5 server: STS, S3, DynamoDB, SNS, SQS, KMS, EC2 (VPC, subnet, security group), CloudWatch Logs, the Tagging API | An emulator. LocalStack's current images need an account and auth token, and its last free 4.x image lists only some services through the Tagging API, so it is not used |
| GitHub | A stateful fake (`apps/api/e2e/github-fake/`) implementing the 24 REST calls infralift and the harness make | Every request is checked against the operation's schema in GitHub's own OpenAPI description at a pinned commit and refused with 422 if GitHub would refuse it; every response is filled out to and checked against the documented schema. The suite fails on any mismatch. `fake.test.ts` runs the fake under infralift's GitHub client in the ordinary `pnpm test` |
| Cloudflare | [Prism](https://github.com/stoplight/prism) 5.15.10 serving the 7 Cloudflare operations the connector calls, from Cloudflare's own OpenAPI description at a pinned commit, with a seeded account (`apps/api/e2e/specs/cloudflare-seed.ts`) | Requests are validated by Prism (`--errors`); the seed is checked against the response schemas when it is written. Stateless, so OpenTofu is not run against it |
| The customer's CI | The import check and apply workflows infralift commits, their `run:` steps executed verbatim in an OpenTofu 1.12.6 container against moto | `uses:` steps are stood in for (checkout is a mounted directory, setup-opentofu is the container), `${{ }}` expressions are passed as the values they resolve to, and the gitleaks step is not run |
| DigitalOcean | Prism serving 6 operations of [digitalocean/openapi](https://github.com/digitalocean/openapi) (multi-file YAML, bundled) | Mocked: verify and the unmanaged view. The connector also calls `GET /v2/spaces`, which the API does not have, so Spaces are never listed |
| Render | Prism serving 5 operations of Render's description, which Render publishes only at api-docs.render.com; pinned to a Wayback Machine copy by sha256. It carries no licence, so the subset is not committed: `scripts/e2e.sh` (and the CI spec check) writes it from the pin at setup, verified, to a git-ignored path, and stops if the copy cannot be fetched or no longer matches | Mocked: verify and the unmanaged view. Needs network access at setup |
| Vercel | Prism serving 2 operations of the description `vercel/sdk` commits (`vercel-spec.json`, from openapi.vercel.sh) | Mocked: verify. The collector lists projects at `GET /v9/projects`, which the description omits (it has v10 and v11), so the inventory fails under the mock and the test pins that. Production is unverified: `src/connectors/__fixtures__/vercel-api.json` is a v9 response captured live on 2026-08-31, so v9 probably still works; it needs a real-account check |
| Heroku | Prism serving 4 links of the Platform API's JSON Hyper-Schema (`heroku/heroku-go` v6/schema.json), converted to OpenAPI 3.1 | Mocked: verify and the unmanaged view. v6, not v5: the live capture in `src/connectors/__fixtures__/heroku-api.json` fails v5 |
| Netlify | Prism serving 4 operations of [netlify/open-api](https://github.com/netlify/open-api) (Swagger 2.0, converted) | Mocked: verify and the unmanaged view. The connector also calls `GET /forms`, which the API does not have (forms are per site), so forms are never listed |
| Fly.io | Prism serving 2 Machines API operations (`superfly/docs` api/machines/openapi.json); the provider fake executing the connector's GraphQL against the schema `superfly/fly-go` commits | Mocked: verify and the unmanaged view |
| Railway | The provider fake executing the connector's GraphQL against the introspection schema `railwayapp/cli` commits | Mocked: verify and the unmanaged view. The plan query asks for `Project.subscription`, which the schema does not have, so the cost estimate is always $0; `plugins` is deprecated ("Plugins have been removed") |
| Azure | Prism serving 6 ARM operations from [Azure/azure-rest-api-specs](https://github.com/Azure/azure-rest-api-specs) at the API versions the connector sends (Swagger 2.0 split over files with common-types, bundled and converted); the provider fake standing in for the Entra token endpoint | Mocked: verify and the unmanaged view. The token endpoint has no machine-readable description and is hand-written |
| Google Cloud, Firebase | Prism serving 7 methods from the discovery documents `googleapis/google-api-go-client` commits, converted; the provider fake standing in for the OAuth token endpoint and verifying the connector's signed JWT | Mocked: verify and the unmanaged view. Cloud Run's description says `locations/-` is not accepted for services.list, and the connector sends it; Prism does not check that, so it is a finding from the description's text, not a failing test |
| Terraform Cloud | Not served. The 5 recorded fixtures in `src/lib/tf/__fixtures__/tfc` are checked against the description `hashicorp/go-tfe` commits (v2/openapi/spec.json) | Fixtures only. TFC is not a connector and the adopt path does not call it |
| GitLab | Not covered | Real GitLab CE in an opt-in profile is not built yet. The connector only calls `GET /user` |

What the AWS run proves: the connection verifies by assuming a role, the unmanaged view lists the account's tagged resources (one each of nine adoptable kinds, including an SQS queue made through the API with SQS's 1 MiB default message size), adopting the nine reserves them in the ledger (`pending`) and opens one pull request with import blocks, a provider (`hashicorp/aws ~> 6.73.0`), a backend and both workflows, the check generates code, removes the attributes `hashicorp/aws` 6.x rejects in its own output (`bucket_prefix = ""` beside `bucket` and similar; the rule table is `apps/api/src/lib/import/cleanup.ts`), and its first plan imports 9 resources and changes nothing (ADR 0002), the ledger rows become `managed`, merging runs the apply by saved plan into state in an S3 bucket (ADR 0008), and the drift job then reports no drift. No step is edited by hand.

What the provider run proves (`apps/api/e2e/providers.e2e.test.ts`): for each provider above marked mocked, the connection verifies and the unmanaged view lists every seeded resource, against Prism serving the vendor's own description (`--errors`, so a request the description would refuse is refused) or, for GraphQL, the provider fake (`apps/api/e2e/provider-fakes/`) validating each query against the vendor's schema and executing it with that schema's types. The seeds (`apps/api/e2e/specs/seeds/`) are checked at extraction against the response schemas and may only carry fields the description declares. Each provider gets its own API process, because the unmanaged view allows an org ten provider reads per ten minutes. Calls a connector makes that the vendor does not document are recorded in `apps/api/e2e/specs/sources.ts` (`undocumented`, `rejectedQueries`), and extraction fails if a pin bump makes one documented, so the finding gets revisited.

The recorded fixtures the unit tests use are checked against the same subsets by `apps/api/e2e/specs/fixtures-match-specs.test.ts` in the ordinary `pnpm test`: each must validate (with trimmed required fields filled) and may only carry declared fields. Exceptions where the vendor's description, not the fixture, is wrong are listed there with the reason.

Not covered: GitLab, the dashboard, and the fixtures written inline in `apps/api/src/connectors/connectors.test.ts` (only the JSON fixture files are checked).

`pnpm --filter @infralift/api e2e:specs` re-extracts every subset from its pin in `apps/api/e2e/specs/sources.ts` (`--check` fails if the committed files differ; name entries to extract only those). Both need network access. `e2e:specs --check --offline` needs none: it checks that each committed subset names the pin `sources.ts` has, skips Render with a note (it is not committed), and does not re-extract, so it cannot catch a hand-edited subset; CI runs the full `--check`. Each subset carries its upstream copyright and licence notice, and NOTICE lists them. Bumping a pin and re-running shows, as a diff, what changed in the vendor's contract for exactly the calls infralift makes.

## Deploying

Merging to `main` deploys. CI runs on GitHub-hosted runners. The marketing site (`apps/web`) deploys to Cloudflare from CI. The API, dashboard and admin deploy from a private repository, started by CI once it passes on `main` (and checked every 10 minutes as a backstop), builds the images on the production host and restarts the `infralift` Nomad job; the API applies pending migrations as it starts. See [`ARCHITECTURE.md`](ARCHITECTURE.md#running-and-deploying).

## Connections

Assessments use read-only credentials. Supported providers include Vercel, Cloudflare, Heroku, AWS, Google Cloud and Firebase, Azure, DigitalOcean, Netlify, Render, Railway and Fly.io. GitHub and GitLab connections are where infralift opens pull requests; a Terraform Cloud connection is where a project's workspace lives.

## License

[Business Source License 1.1](LICENSE). You can read, modify and run infralift, including in production to manage your own organization's infrastructure. You cannot offer it, or a derivative of it, to others as a hosted or managed service. Each version converts to the Apache License 2.0 four years after it is published.
