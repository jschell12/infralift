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

`make e2e` (or `pnpm e2e`) runs the adopt path end to end on your machine with no cloud account, no git host and no spend. It needs Docker. It brings up `docker-compose.e2e.yml`, runs `apps/api/e2e`, and tears the stack down; a run takes about a minute once the images and providers are cached. `E2E_KEEP=1 make e2e` leaves the stack up.

The API runs from source with every provider endpoint pointed at the stack through `INFRALIFT_ENDPOINT_*` variables (`apps/api/src/lib/endpoints.ts`, one per API; the defaults are the real endpoints). A server with `NODE_ENV=production` refuses to start with any of them set, because an override sends customer credentials to another host. The suite runs the API with `NODE_ENV=development`.

What is real and what stands in for it:

| Part | In the e2e stack | How far it is trusted |
| --- | --- | --- |
| infralift API, job worker, Postgres | Real, from source, on a throwaway Postgres 16 | The code under test |
| AWS | [moto](https://github.com/getmoto/moto) 5.2.5 server: STS, S3, DynamoDB, SNS, the Tagging API | An emulator. LocalStack's current images need an account and auth token, and its last free 4.x image lists only some services through the Tagging API, so it is not used |
| GitHub | A stateful fake (`apps/api/e2e/github-fake/`) implementing the 24 REST calls infralift and the harness make | Every request is checked against the operation's schema in GitHub's own OpenAPI description at a pinned commit and refused with 422 if GitHub would refuse it; every response is filled out to and checked against the documented schema. The suite fails on any mismatch. `fake.test.ts` runs the fake under infralift's GitHub client in the ordinary `pnpm test` |
| Cloudflare | [Prism](https://github.com/stoplight/prism) 5.15.10 serving the 7 Cloudflare operations the connector calls, from Cloudflare's own OpenAPI description at a pinned commit, with a seeded account (`apps/api/e2e/specs/cloudflare-seed.ts`) | Requests are validated by Prism (`--errors`); the seed is checked against the response schemas when it is written. Stateless, so OpenTofu is not run against it |
| The customer's CI | The import check and apply workflows infralift commits, their `run:` steps executed verbatim in an OpenTofu 1.12.6 container against moto | `uses:` steps are stood in for (checkout is a mounted directory, setup-opentofu is the container), `${{ }}` expressions are passed as the values they resolve to, and the gitleaks step is not run |

What the AWS run proves: the connection verifies by assuming a role, the unmanaged view lists the account's tagged resources, adopting three reserves them in the ledger (`pending`) and opens one pull request with import blocks, a provider, a backend and both workflows, the check generates code and its plan imports 3 resources and changes nothing (ADR 0002), the ledger rows become `managed`, merging runs the apply by saved plan into state in an S3 bucket (ADR 0008), and the drift job then reports no drift. On the way it records that `hashicorp/aws ~> 5.0` generates attributes it then rejects (`bucket_prefix = ""` beside `bucket` and similar), so the first plan fails until those empty values are deleted, which the suite does as a customer would, from `tofu validate`'s errors.

Not covered: GitLab (GitLab CE runs in Docker but is heavy; nothing in the adopt path calls GitLab yet), Terraform Cloud, the dashboard, and the other providers (Vercel, Netlify, Render, Fly.io, DigitalOcean, Heroku, Railway, Azure, Google Cloud, Firebase), whose connectors are still tested with recorded fixtures in `apps/api/src/connectors/*.test.ts`. Their endpoints can already be overridden.

`pnpm --filter @infralift/api e2e:specs` re-extracts the OpenAPI subsets from the pinned commits (`--check` fails if the committed files differ). Bumping a pin and re-running shows, as a diff, what changed in the vendor's contract for exactly the calls infralift makes.

## Deploying

Merging to `main` deploys. CI runs on GitHub-hosted runners. The marketing site (`apps/web`) deploys to Cloudflare from CI. The API, dashboard and admin deploy from a private repository, started by CI once it passes on `main` (and checked every 10 minutes as a backstop), builds the images on the production host and restarts the `infralift` Nomad job; the API applies pending migrations as it starts. See [`ARCHITECTURE.md`](ARCHITECTURE.md#running-and-deploying).

## Connections

Assessments use read-only credentials. Supported providers include Vercel, Cloudflare, Heroku, AWS, Google Cloud and Firebase, Azure, DigitalOcean, Netlify, Render, Railway and Fly.io. GitHub and GitLab connections are where infralift opens pull requests; a Terraform Cloud connection is where a project's workspace lives.

## License

[Business Source License 1.1](LICENSE). You can read, modify and run infralift, including in production to manage your own organization's infrastructure. You cannot offer it, or a derivative of it, to others as a hosted or managed service. Each version converts to the Apache License 2.0 four years after it is published.
