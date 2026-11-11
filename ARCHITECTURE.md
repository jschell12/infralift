# Architecture

How infralift is put together, written so someone can find their way around the code without help. Start with the shape of the system, then the patterns it uses (each with the file that shows it), then the flows a request goes through.

Decisions that shaped it are recorded in [`docs/adr/`](docs/adr/). The design-pattern review that produced most of this layout is summarized at the end.

## What infralift does

infralift writes and maintains a customer's infrastructure as code in the customer's own repository. Stack, import and adoption jobs write to a repository the customer works in, so they arrive as pull requests the customer reviews and merges. Codegen and template jobs commit directly to the branch they target (`TfProject.destBranch`, `main` by default), usually in a repository infralift created for that purpose. It sells on three things:

- **Import that changes nothing running.** Existing Terraform, or resources built by hand in a cloud console, come under infralift only after a read-only plan proves no resource would change, so taking them over does not touch what is running.
- **Cost comparison.** What the infrastructure costs now against the alternatives (planned).
- **Security.** Customer-owned state, read-only checks, no stored cloud keys where OIDC is possible.

## The parts

```
apps/
  web/         marketing site and public cost estimator (Next.js, Cloudflare Worker)
  dashboard/   the customer app (Next.js)
  admin/       internal tools (Next.js), separate from the customer app
  api/         everything else (Express, Prisma, Postgres)
packages/
  shared/      types shared by the API and the apps
  collectors/  scripts a customer runs to snapshot a provider (Vercel, Heroku)
docs/          customer-facing documentation, and docs/adr/ decision records
e2e/           end-to-end runbooks and a reference app
```

The API is where the logic is. Inside `apps/api/src` (the schema is beside it, in `apps/api/prisma`):

| Layer | Directory | Responsibility | Talks to |
| --- | --- | --- | --- |
| Routes | `routes/` | HTTP only: validate the body, call one service function, send the result | services |
| Services | `services/` | The rules: what is allowed, in what order, for which org | lib, prisma |
| Domain modules | `lib/` | Self-contained pieces: job state, delivery to git hosts, import scanning, stack rendering, HCL writing | each other, external APIs |
| Connectors | `connectors/` | One adapter per cloud provider, turning its API into one inventory shape | provider APIs |
| Data | `apps/api/prisma/` | Schema and migrations; `schema.prisma` is the source of truth for the domain | Postgres |

A rule belongs in a service. If you are looking for "why was this refused", start in `services/`.

### Project kinds

Everything a customer manages is a **project**, and a project is one of five kinds. In code it is a discriminated union, `Project` in [`packages/shared/src/projects.ts`](packages/shared/src/projects.ts); in the database it is one `TfProject` table, mapped to its kind in [`lib/projects/view.ts`](apps/api/src/lib/projects/view.ts).

| Kind | What it is | Made by |
| --- | --- | --- |
| `stack` | A whole deploy setup (infrastructure, server scripts, CI) rendered from a stack template into the app repository, as a PR | `services/stacks.ts` |
| `imported` | Existing Terraform in a repo, or cloud resources adopted as they run, behind the read-only import check | `services/imports.ts` |
| `codegen` | Terraform generated from an assessment of a cloud account, for a migration target | `services/codegen.ts` |
| `adopted` | Built around workspaces adopted from the customer's Terraform Cloud | `routes/workspaces.ts` |
| `template` | One file rendered from a template version (legacy `/terraform` page) | `services/templates.ts` |

## Patterns, and where to see them

Each is a well-known pattern, used under its usual name.

| Pattern | Where | What it buys |
| --- | --- | --- |
| **Adapter** | [`lib/git/hosts.ts`](apps/api/src/lib/git/hosts.ts) (`GitHostClient` over GitHub and GitLab); [`lib/tf/workspace.ts`](apps/api/src/lib/tf/workspace.ts) (Terraform Cloud) | Jobs never call GitHub, GitLab or TFC directly |
| **Strategy + registry** | [`connectors/`](apps/api/src/connectors/) (`verify`/`assess` per provider, registered in `connectors/index.ts`) | Adding a provider is one file |
| **Anti-corruption layer** | Connectors map every provider's API to `ResourceInventoryItem` | Provider quirks stop at the edge |
| **Discriminated union** | `Project` kinds (above) | Each kind carries only its own fields |
| **State machine** | [`lib/jobs/state.ts`](apps/api/src/lib/jobs/state.ts): `transition()` over `start` / `fail` / `succeed` | A job's stages can only move forward and end once |
| **Template method** | [`lib/git/deliver.ts`](apps/api/src/lib/git/deliver.ts): `deliverChangeRequest()` | Every job that opens a PR follows the same steps, written once |
| **Command + queue** | [`lib/jobs/queue.ts`](apps/api/src/lib/jobs/queue.ts): a `TfJob` row is claimed by one process, swept if left pending, marked interrupted if its process died, failed if still running past its time limit | Jobs survive restarts and never run twice, as long as one API process runs at a time (see below) |
| **Builder + serializer** | [`lib/import/check.ts`](apps/api/src/lib/import/check.ts) (a typed workflow object, written by the `yaml` library); [`lib/hcl/write.ts`](apps/api/src/lib/hcl/write.ts) (HCL blocks and attributes, printed as `terraform fmt` would) | Generated files are data; quoting and escaping happen in one place |
| **Specification** | Stack rules as JSON Schema in each `apps/api/stacks/<slug>/stack.json`; import readiness in `lib/import/scan.ts` | Rules are data, not branches |
| **Typed errors** | [`lib/errors.ts`](apps/api/src/lib/errors.ts): `InvalidInput` and `InvalidBody` 400, `Unauthorized` 401, `NotFound` 404, `Conflict` 409, `Unprocessable` 422, `TooManyRequests` 429, `Upstream` 502, `ServiceUnavailable` 503 | Services throw; one place turns errors into responses |
| **Compare-and-set** | The queue's claim (`lib/jobs/queue.ts`), the drift claim (`services/drift.ts`), the stuck-work sweeps: an `updateMany` whose `WHERE` is the expected state, and the row count says who won | Two processes, or a sweep and a runner, cannot both act on one row |
| **Sliding-window rate limiter** | [`lib/rate-limit.ts`](apps/api/src/lib/rate-limit.ts) `createRateLimiter()`, used by `/intake/lead`, `/intake/estimate` and codegen (`services/codegen.ts`) | One implementation of the window, the sweep and the per-caller bucket |
| **Bulkhead (worker pool)** | [`lib/stacks/team.ts`](apps/api/src/lib/stacks/team.ts): `acquireRenderSlot()` caps concurrent team-stack trial renders and the queue behind them | A burst of stack checks cannot take every core |
| **Shared contract** | [`lib/import/contract.ts`](apps/api/src/lib/import/contract.ts): the messages the import workflow writes and infralift reads back | Writer and reader cannot drift; a test fails if one changes alone |

## Flows

### A request

`routes/*` validates the body with zod (`parseBody`), calls one service function, and sends what it returns. A service that refuses throws a typed error; `handle()` (and, for any route, the app's `errorHandler`) answers with its status and body. Anything else is a 500 and is logged. Every query a service makes is scoped to the caller's org.

A response never carries a provider's or a library's own error text: a 5xx logs it with a request id and sends a sentence. The dashboard shows a failed request as the body's `error` sentence or a message chosen from the status (`errorMessageFor` in `apps/dashboard/lib/api.ts`, tested with `pnpm --filter @infralift/dashboard test`), never `detail`.

### A job

Creating a stack project, importing a module, adopting resources, approving a migration or saving settings each create a `TfJob` row and call `startJob()`:

1. The queue claims the row for this process (`lib/jobs/queue.ts`).
2. The pipeline runs it (`lib/tf/pipeline.ts`), one runner per job kind: `stack`, `import`, `codegen`, `template`.
3. Each runner reports progress as state machine events through a `JobRun`; the dashboard polls the row.
4. Runners that write to a customer's app repository (stack, import) deliver through `deliverChangeRequest()`: reuse this project's open PR or branch, commit once, open the PR. They never push to the default branch. Codegen and template runners commit directly to the project's `destBranch`.

If the process dies mid-job, the next one to start marks the job `errored` with an "interrupted" message. Jobs are not retried automatically, because they write to customers' repositories.

**One API process at a time.** Recovery treats every job claimed by another process as abandoned. That is true today: the Nomad job runs one copy and a deploy restarts it in place. Running two copies at once would make each one mark the other's live jobs as interrupted; it needs a heartbeat on claimed jobs first.

### Importing existing Terraform

1. `POST /tf/imports/scan` reads the repository's Terraform files (not its state) and lists root modules with their backend, providers, resource count and the credentials a plan needs (`lib/import/scan.ts`, `lib/import/hcl.ts`).
2. `POST /tf/imports` creates an `imported` project and a job that opens a PR adding one workflow (`lib/import/check.ts`).
3. The workflow runs a read-only `plan -lock=false` in the customer's CI with their secrets, or with OIDC, and passes only when no resource would change.
4. `GET /tf/imports/:id/check` reads the result back from the check run (`lib/import/result.ts`).

### Adopting resources built by hand

From a completed assessment, `POST /tf/imports/from-assessment` opens a PR with import blocks, a provider and a backend in a bucket the customer owns, and no resource code (`lib/import/adopt.ts`). The check generates the code from what is running (`plan -generate-config-out`), commits it, and holds it to the same zero-change gate. Before committing it scans `generated.tf` for literal secrets (`lib/import/guard.ts`). The same PR adds an apply workflow (`lib/import/apply.ts`): on the push that merges it, one job in the `production` environment plans and applies exactly that plan, so the plan file never leaves the runner, which is what records the resources in state. Until then the drift job reports the project as `unapplied`. Workflows already in a repository change only when re-rendered; see [ADR 0008](docs/adr/0008-adoption-applies-a-saved-plan.md).

### Terraform Cloud

A project with a Terraform Cloud backend names one of the org's TFC connections (`TfProject.tfcConnectionId`). The workspace is created in that connection's organization, and the generated `cloud {}` block names the same organization (`lib/tf/tfc-connection.ts`). infralift's own TFC organization is never used for a customer project.

Each template, codegen and stack job records the workspace it created as a `managed` `Workspace` row, keyed on org and TFC workspace id, so it shows under Workspaces and in the runs drawer (`lib/tf/workspace-record.ts`). A workspace of that name that was already there is recorded as `adopted`, and infralift then leaves its settings alone, because nothing distinguishes one an earlier run made from one the customer made. Workspaces jobs created before these rows existed appear on the job's next run, as `adopted`, or by adopting them under Workspaces.

### Background work in the API process

Besides the job worker, the API process runs two timers, both started in `server.ts` after `listen()`:

- **Drift sweep** (`services/drift.ts`, every 15 minutes): for each project with a GitHub repository, reads the newest `infra drift` check run the customer's CI produced and records it on the project and its workspaces. infralift plans nothing itself. A 401/403 from GitHub marks the connection invalid.
- **Analytics rollup** (`analytics/rollup.ts`, hourly): rolls complete UTC days of marketing-site page views from Workers Analytics Engine into `AnalyticsDaily`. Off unless `CF_ACCOUNT_ID` and `CF_ANALYTICS_TOKEN` are set.

The **community scanner** (`scanner/`) is a separate script, not part of the server: it scrapes Reddit, Hacker News, dev.to, Stack Exchange and Lobsters for posts about hosting costs, and classifies each with a small Claude model (`scanner/classify.ts`, Anthropic SDK, `ANTHROPIC_API_KEY`). Results feed the admin-only `/communities` pages.

### Public routes

Two routes sit above `cfAuth` in `app.ts`, so they have no tenant and no session: `POST /intake/lead` (the marketing site's lead form, with a honeypot field) and `POST /intake/estimate` (the public cost estimator). Each has its own sliding-window limiter keyed on the client IP (`CF-Connecting-IP` behind the tunnel), 5 and 20 per hour. The limiter is in-process, so a second replica would mean a second bucket.

### First login

There is no sign-up form. The first time Cloudflare Access lets an email through, `cfAuth` (`lib/cf-auth.ts`) creates a user and an org named after it ("<name>'s workspace"). Everything after that is scoped to that org.

## Failure modes

What happens when something infralift depends on is slow, down or restarts.

- **Outbound timeouts.** Every HTTP call to another system goes through `httpFetch()` (`lib/http.ts`), with the deadlines in one table there: 15s by default, 30s for GitHub and GitLab, 60s for the analytics SQL API. AWS SDK clients get a 5s connection and 30s request timeout and at most 3 attempts (`connectors/aws.ts`); the scanner's LLM client gets 60s. A timeout fails the call with an error naming the host. It never marks a connection invalid: only a 401 or 403 from the provider does (`services/connections.ts`). Re-verifying a connection that times out records the reason and keeps its status.
- **Paged lists from customer-supplied hosts.** Terraform Cloud/Enterprise workspace listings stop after `TFC_WORKSPACE_PAGES` (50 pages of 100) or at a `links.next` pointing at another host, and say they were truncated (`Infralift-Truncated` header on `GET /workspaces/remote`). GitLab tree listings stop at `GITLAB_TREE_PAGES`; Cloudflare lists at `MAX_PAGES`.
- **Stuck jobs.** The job worker's sweep (every 15s) fails any claimed job still unfinished 30 minutes after its claim (`failOverdueJobs`, "timed out ... start it again"). If the job was only slow and later finishes, the runner's own write replaces that message.
- **Stuck assessments.** A token assessment runs inside its HTTP request. The same sweep fails assessments still `running` 30 minutes after they started (`failStuckAssessments` in `services/assessments.ts`, "timed out ... run it again"), which covers a request that died with its process.
- **Shutdown.** On SIGTERM or SIGINT, `server.ts` stops accepting connections, stops claiming jobs (`drainJobs`), and waits up to `SHUTDOWN_DRAIN_MS` (default 25s) for in-flight requests and jobs before exiting. The orchestrator's kill timeout must be longer than that, or the process is killed mid-wait. A job cut off is marked "interrupted" by the next process at boot; an assessment cut off is failed by the sweep above.
- **Not retried automatically:** jobs (they write to customers' repositories, so a person decides), assessments (the customer runs them again), timed-out HTTP calls inside jobs and assessments. The drift sweep and the analytics rollup simply try again on their next tick.

## Security model

- This repository is public. Nothing in it can reach the production host: CI runs on GitHub-hosted runners, and deploys are pulled by a private repository ([ADR 0007](docs/adr/0007-public-repo-private-deploy.md)). Pull requests from forks never run on infrastructure we own.

- Customer credentials are stored encrypted (`lib/crypto.ts`) and scoped to their org. A query that forgets the org is a bug; route tests check isolation.
- infralift never reads a customer's Terraform state and never holds the cloud credentials an import check uses. Those run in the customer's CI.
- Strings that reach generated YAML, HCL or shell are validated or escaped in one place: `isSafePath` and `isSafeEnvName` (`lib/import/check.ts`), and `quote()` (`lib/hcl/write.ts`). Values reach shell scripts only through environment variables.
- The dashboard and API sit behind Cloudflare Access; the API also verifies the Access token itself (`lib/cf-auth.ts`). There is no other sign-in path.

## Running and deploying

```bash
pnpm install
pnpm db:generate
pnpm dev            # web :3000, dashboard :3001, api :4000
pnpm --filter @infralift/api test
```

The API needs `DATABASE_URL` (see `apps/api/.env.example`).

A merge to `main` runs CI on GitHub-hosted runners. The marketing site (`apps/web`) deploys to Cloudflare from that CI run. The API, dashboard and admin are not deployed from this repository: it is public, and a public repository must not have a self-hosted runner. A workflow in a private repository deploys `main`: it confirms this repository's CI passed on the commit, builds the `infralift-{api,dashboard,admin}:local` images on the production host and restarts the `infralift` Nomad job ([ADR 0007](docs/adr/0007-public-repo-private-deploy.md)). This repository's CI starts it as soon as CI passes on `main` (the `trigger-deploy` job, with a token scoped to that repository's Actions; ADR 0007 lists what it can do); the private workflow also checks every 10 minutes in case a trigger is missed. The API applies pending Prisma migrations when it starts (`prisma migrate deploy` in its Dockerfile), then starts the job worker.

## Adding things

- **A stack:** a directory under `apps/api/stacks/<slug>/` with `stack.json` and templates. `pnpm --filter @infralift/api validate:stacks` renders every combination and runs `tofu validate`.
- **A provider connector:** add the provider to `PROVIDERS` (and its label) in `packages/shared/src/index.ts`, then a file in `connectors/` implementing `verify` and `assess`, registered in `connectors/index.ts`.
- **A job kind:** a runner in `lib/tf/pipeline.ts` that reports through a `JobRun`, delivering through `deliverChangeRequest()` if it writes to a customer repository.
- **An error a route can return:** throw the matching class from `lib/errors.ts`; add a class only for a new status.

## Glossary

- **Stack:** a collection of modules plus wiring, an input schema and a delivery, rendered into a repository. From the catalog on disk, or a team's own repository pinned to a commit ([ADR 0009](docs/adr/0009-stacks-modules-and-team-stacks.md)).
- **Module:** what manages one important resource, such as a database, plus what exists only to serve it.
- **Delivery:** the CI system that deploys a stack (GitHub Actions, GitLab CI).
- **Import:** bringing existing Terraform under infralift, behind the zero-change check.
- **Adopt:** bringing resources built by hand under Terraform, with generated code. (A TFC workspace "adopted" in `routes/workspaces.ts` is the older meaning.)
- **Assessment:** a read-only inventory and cost report of a cloud account.

## How this layout came about

A review in November 2026 asked whether a person could maintain this code without AI help. The answer was "yes, slowly": the core was procedural, rules lived in route handlers, one table held five kinds of project, and generated files were built by joining strings. Eight pull requests (#108 to #115) introduced the patterns above one at a time, each keeping behaviour the same, plus this document.

What is still procedural: `lib/tf/codegen.ts` builds HCL by hand rather than with `lib/hcl/write.ts`, `routes/workspaces.ts` keeps its logic in the route, and the database still stores every project kind in one table.
