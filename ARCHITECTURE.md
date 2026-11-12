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

Since [ADR 0010](docs/adr/0010-a-project-is-one-accounts-infrastructure.md) a project is the Terraform for one cloud account in one environment, not an app. The last column says how `/projects/new` starts each kind today. Kinds and stacks it no longer offers keep working for projects that already use them.

| Kind | What it is | Made by | On `/projects/new` |
| --- | --- | --- | --- |
| `imported` | Existing Terraform in a repo, or cloud resources adopted as they run, behind the read-only import check | `services/imports.ts` | "Adopt from an account" (assess the connection, then adopt from the report) and "Bring existing Terraform" (scan a repository) |
| `stack` | Modules rendered from a stack into the customer's repository, as a PR | `services/stacks.ts` | "Start from a stack", minus app stacks: `isAppStack` in `apps/dashboard/lib/stacks.ts` hides `app-foundry-hetzner` and anything with an app template. The catalog has no other stack yet |
| `adopted` | Built around workspaces adopted from the customer's Terraform Cloud | `routes/workspaces.ts` | Not yet: the API exists (`/workspaces/remote`, `/workspaces/adopt`), the dashboard has no entry for it |
| `codegen` | Terraform generated from an assessment of a cloud account, for a migration target | `services/codegen.ts` | No longer offered (ADR 0010); still reachable from an assessment's report and options pages |
| `template` | One file rendered from a template version (legacy `/terraform` page) | `services/templates.ts` | No, it has its own page |

### Dashboard pages

Lists and creation are separate pages; a drawer is only for a small action on an existing item.

| Page | What it is |
| --- | --- |
| `/projects` | The project list, with a "New project" link. A stack project's settings open in a drawer |
| `/projects/new` | Three starting points, in ADR 0010's order; the choice is in the URL (`?start=adopt\|stack\|terraform`). Old `/projects?start=...` and `?assess=` links redirect here (`lib/new-project.ts`) |
| `/connections` | One tile per connection, Terraform Cloud included, with verify, replace (a drawer) and remove. The tile is `components/connection-tile.tsx`; the dashboard home and the adopt step of `/projects/new` show connections with the same tile, never as rows inside one card |
| `/connections/new` | Pick a type, then only that type's fields and setup help (`?type=aws`). Every type is stored through `createConnection()` in `apps/dashboard/lib/connections.ts`, which sends Terraform Cloud to `POST /workspaces/connections` and the rest to `POST /connections` |

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
| **Unique index as the guard** | Migration 0028's partial unique index on `TfJob(projectId) WHERE status IN ('pending','running')`, mapped to 409 in [`lib/jobs/enqueue.ts`](apps/api/src/lib/jobs/enqueue.ts); `User.email` in first-login provisioning (`lib/cf-auth.ts`). P2002/P2025 are named in [`lib/prisma-errors.ts`](apps/api/src/lib/prisma-errors.ts) | A check-then-insert lets two simultaneous requests both through; the database refuses the second one |
| **Ledger as the guard** | `ManagedResource`'s unique key `(providerConnectionId, provider, resourceType, providerId)` ([ADR 0011](docs/adr/0011-one-owner-per-cloud-resource.md)), written in the same transaction as the adoption's project and job ([`services/imports.ts`](apps/api/src/services/imports.ts) `openAdoption`) | One cloud resource has one owning project, even when two adoptions race |
| **Cache-aside with request coalescing** | [`services/unmanaged.ts`](apps/api/src/services/unmanaged.ts) `accountInventory()`: one inventory per connection for 5 minutes, keyed on the credential's `updatedAt`; concurrent misses share one provider read | Paging and reloading the unmanaged view do not call the provider again |
| **Shared contract** | [`lib/import/contract.ts`](apps/api/src/lib/import/contract.ts): the messages the import workflow writes and infralift reads back | Writer and reader cannot drift; a test fails if one changes alone |
| **Clock theme, one source** | [`apps/web/lib/theme.ts`](apps/web/lib/theme.ts) (copied byte for byte into dashboard and admin): `themeForHour()` picks light 07:00 to 19:00 on the viewer's clock, `THEME_BOOT_SCRIPT` sets `<html data-theme>` in each root layout's `<head>` before paint, `ThemeControl` saves an Auto / Light / Dark override in `localStorage`. Each `globals.css` token is `light-dark(light, dark)`, picked by `color-scheme` from `data-theme`, or from the OS with JavaScript off | One palette table per app, no flash, and `apps/web/lib/theme.test.ts` runs the head script against `themeForHour` and fails if a copy drifts |

## Flows

### A request

`routes/*` validates the body with zod (`parseBody`), calls one service function, and sends what it returns. A service that refuses throws a typed error; `handle()` (and, for any route, the app's `errorHandler`) answers with its status and body. Anything else is a 500 and is logged. Every query a service makes is scoped to the caller's org.

A response never carries a provider's or a library's own error text: a 5xx logs it with a request id and sends a sentence. The dashboard shows a failed request as the body's `error` sentence or a message chosen from the status (`errorMessageFor` in `apps/dashboard/lib/api.ts`, tested with `pnpm --filter @infralift/dashboard test`), never `detail`.

### A job

Creating a stack project, importing a module, adopting resources, approving a migration or saving settings each create a `TfJob` row through `enqueueJob()` / `insertJob()` (`lib/jobs/enqueue.ts`) and call `startJob()`. A project has at most one job pending or running: a second one (a double-click, a second tab) is a 409, "a job is already running for this project". Where the same request also changes the project (stack settings, re-approving a migration), the change and the job insert share a transaction, so a refused job leaves the project as it was.

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

There are two ways in, and both go through `openAdoption()` in `services/imports.ts`: from a completed assessment (`POST /tf/imports/from-assessment`, the whole inventory), or from resources picked in the unmanaged view (`POST /connections/:id/adopt`, below). Either one opens a PR with import blocks, a provider and a backend in a bucket the customer owns, and no resource code (`lib/import/adopt.ts`). The check generates the code from what is running (`plan -generate-config-out`), commits it, and holds it to the same zero-change gate. Before committing it scans `generated.tf` for literal secrets (`lib/import/guard.ts`). The same PR adds an apply workflow (`lib/import/apply.ts`): on the push that merges it, one job in the `production` environment plans and applies exactly that plan, so the plan file never leaves the runner, which is what records the resources in state. Until then the drift job reports the project as `unapplied`. Workflows already in a repository change only when re-rendered; see [ADR 0008](docs/adr/0008-adoption-applies-a-saved-plan.md).

### Adopting from an account, and the managed-resource ledger

A project manages one cloud account ([ADR 0010](docs/adr/0010-a-project-is-one-accounts-infrastructure.md)), named by `TfProject.providerConnectionId`, which must be a connection of the project's own org (`ownedConnection` in `services/managed-resources.ts`). The ledger, `ManagedResource`, records which project manages which resource, keyed by the connector's inventory type and the provider's id ([ADR 0011](docs/adr/0011-one-owner-per-cloud-resource.md)).

```
GET /connections/:id/unmanaged          (services/unmanaged.ts listUnmanaged)
  connection, org-scoped (404 otherwise; git hosts and TFC are 400)
  inventory: cache (5 min, per connection) or connector.assess(), the same
             read-only call an assessment makes; provider reads limited to
             10 per 10 minutes per org (429); ?refresh=1 skips the cache
  minus ledger rows for the connection (pending and managed)
  each row: type, provider id, name, region, adoptable + reason (lib/import/adopt.ts adoptionTarget)
  one page, sorted by (type, id); next page's cursor in X-Next-Cursor

POST /connections/:id/adopt             (services/unmanaged.ts adoptSelected)
  same request again: the project it made, 200 replayed
  picked keys looked up in the inventory: missing 400, managed 409, not adoptable 400
  openAdoption (services/imports.ts): render import blocks, refuse existing files,
    then one transaction: project (with providerConnectionId), ledger rows
    as pending (unique violation 409), import job; then start the job
  the job opens the adoption PR (lib/tf/pipeline.ts runImportJob)

GET /tf/imports/:id/check               (services/imports.ts readImportCheck)
  check passed: the project's pending rows become managed
  PR closed unmerged: the project's rows are deleted
```

Only adoption writes ledger rows. A repository import and a stack cannot say which provider ids they manage (one reads HCL, the other's ids appear at the customer's apply), so their resources show as unmanaged. Adding resources to an existing project is refused (409) until the import check can generate code for imports added after its first run. The inventory cache and the limiter are in-process, like every limiter here: a second API replica means a second cache.

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

There is no sign-up form. The first time Cloudflare Access lets an email through, `cfAuth` (`lib/cf-auth.ts`) creates a user and an org named after it ("<name>'s workspace"). Everything after that is scoped to that org. Emails are stored trimmed and lowercased. The first page load sends several requests at once; the org and user are created in one transaction, and the requests that lose the race on `User.email` roll back their org and read the winner's row, so one person gets one org.

## Failure modes

What happens when something infralift depends on is slow, down or restarts.

- **Outbound timeouts.** Every HTTP call to another system goes through `httpFetch()` (`lib/http.ts`), with the deadlines in one table there: 15s by default, 30s for GitHub and GitLab, 60s for the analytics SQL API. AWS SDK clients get a 5s connection and 30s request timeout and at most 3 attempts (`connectors/aws.ts`); the scanner's LLM client gets 60s. A timeout fails the call with an error naming the host. It never marks a connection invalid: only a 401 or 403 from the provider does (`services/connections.ts`). Re-verifying a connection that times out records the reason and keeps its status.
- **Paged lists from customer-supplied hosts.** Terraform Cloud/Enterprise workspace listings stop after `TFC_WORKSPACE_PAGES` (50 pages of 100) or at a `links.next` pointing at another host, and say they were truncated (`Infralift-Truncated` header on `GET /workspaces/remote`). GitLab tree listings stop at `GITLAB_TREE_PAGES`; Cloudflare lists at `MAX_PAGES`.
- **Stuck jobs.** The job worker's sweep (every 15s) fails any claimed job still unfinished 30 minutes after its claim (`failOverdueJobs`, "timed out ... start it again"). If the job was only slow and later finishes, the runner's own write replaces that message.
- **Stuck assessments.** A token assessment runs inside its HTTP request. The same sweep fails assessments still `running` 30 minutes after they started (`failStuckAssessments` in `services/assessments.ts`, "timed out ... run it again"), which covers a request that died with its process.
- **Shutdown.** On SIGTERM or SIGINT, `server.ts` stops accepting connections, stops claiming jobs (`drainJobs`), and waits up to `SHUTDOWN_DRAIN_MS` (default 25s) for in-flight requests and jobs before exiting. The orchestrator's kill timeout must be longer than that, or the process is killed mid-wait. A job cut off is marked "interrupted" by the next process at boot; an assessment cut off is failed by the sweep above.
- **Large lists.** `GET /assessments` returns the newest 50 (`?limit` up to 50; the next page's cursor is in the `X-Next-Cursor` header, used as `?cursor=`), built from a fixed number of queries whatever the page holds (`listAssessmentSummaries`). `GET /connections/:id/unmanaged` pages the same way (100 per page, at most 200), over an inventory held in memory. Other lists are capped rather than paged, far above today's sizes: projects 200 (newest 20 renderings each, metadata only), renderings 50 without bodies, connections 200, migrations 100, workspaces 500, team stacks 200. Leads take `?days` and `?limit` as whole numbers in range, or 400.
- **Template file names.** A template project renders into one file, `<project>.tf`, rewritten by each job. Before 0028 each job wrote `<project>-job-<id>.tf`, so a rerun declared every resource twice. A project that already has a rendering keeps writing its newest file name; older job files already in a repository have to be deleted there.
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
- **Adopt:** bringing resources built by hand under Terraform, with generated code.
- **Managed resource:** a ledger row saying which project manages one cloud resource; **unmanaged** is what an account holds with no such row. (A TFC workspace "adopted" in `routes/workspaces.ts` is the older meaning.)
- **Assessment:** a read-only inventory and cost report of a cloud account.

## How this layout came about

A review in November 2026 asked whether a person could maintain this code without AI help. The answer was "yes, slowly": the core was procedural, rules lived in route handlers, one table held five kinds of project, and generated files were built by joining strings. Eight pull requests (#108 to #115) introduced the patterns above one at a time, each keeping behaviour the same, plus this document.

What is still procedural: `lib/tf/codegen.ts` builds HCL by hand rather than with `lib/hcl/write.ts`, `routes/workspaces.ts` keeps its logic in the route, and the database still stores every project kind in one table.
