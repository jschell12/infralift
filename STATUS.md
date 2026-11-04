# infralift status

## 2026-11-04 (projects page)

### Completed
- **Dashboard `/projects`**: pick an app template (app-foundry) and a target (Hetzner; AWS, Google Cloud, DigitalOcean, Azure shown as coming soon), fill in the settings, choose OpenTofu+R2 or Terraform Cloud, preview the files (managed vs yours), and open a pull request. Each project card shows its stack, backend, URL, latest job and PR link; **Settings** re-renders into the open PR or a new one.
  - New-project form derives the resource prefix and the deploy repo from the project name and repo instead of asking twice.
  - API: `PUT /tf/stacks/projects/:id/settings` (complete settings, defaults filled in, org-scoped, new stack job); `/tf/stacks` returns `template` and `target`.
  - Sidebar used `window.location` during render, so every page server-rendered "Dashboard" as active and React kept it; now `usePathname`. This was the hydration error on every page.
  - Verified by driving the page in headless Chrome against a local API + Postgres: create, preview, derived fields stored, TFC without an org refused in plain words, settings save creates a stack job. Jobs stop at commit there because the local DB has no GitHub connection.

### Next
- Day-2 views (step 4): deploy history, logs and previews read from the GH Actions API and the box.
- A first real stack PR against a scratch repo needs a GitHub connection with Contents, Pull requests and Workflows write.
- `/favicon.ico` is a 404 on the dashboard.

## 2026-11-04 (stacks follow-ups)

### Completed
- Stack jobs reuse an open PR only when its branch is exactly `infralift/<project>-<8 chars>`; a prefix match let project `app` push onto `app-staging`'s PR.
- Seed files (`overrides.tf`) are kept if they exist on the default branch **or** on the open PR's branch, so a re-run no longer overwrites a customer's edit made on the PR.
- Checked and rejected: `.dockerignore`'s `*.md` only excludes Markdown at the build-context root (measured with a throwaway `docker build`), so stack `.md` files do reach the image.

## 2026-11-04 (stacks)

### Completed
- **Stacks: whole deploy setups rendered into a customer's app repo as a pull request.** First stack `app-foundry-hetzner`, vendored from app-foundry `5941696`, whose `deploy/` is live at demo.infralift.dev: Hetzner CX23 behind a Cloudflare tunnel, a preview per PR, nightly backups restored to prove them, OpenTofu+R2 (encrypted state) or Terraform Cloud.
  - `apps/api/stacks/<slug>/`: `files/` copied verbatim (executable bits kept), `templates/` for the few files that vary, `stack.json` with the input schema. Files are `managed` (rewritten on every change) or `seed` (`overrides.tf`, written only if missing).
  - New `stack` job kind: render, branch `infralift/<project>-<job>`, one commit, PR against destBranch; never pushes to it. TFC backend also creates a workspace on `deploy/infra`. No-op renders delete the branch instead of opening an empty PR.
  - Routes: `GET /tf/stacks`, `POST /tf/stacks/:slug/preview`, `POST /tf/stacks/:slug/projects`. Migration 0012 adds `TfProject.stackSlug`, `TfJob.prUrl`.
  - Re-running a job while its PR is open pushes to that PR. A failure after creating a branch deletes it. Stored settings have the schema defaults filled in, so a changed default never moves an existing project. The GitHub connection needs Contents, Pull requests and Workflows read/write on the destination repo.
  - CI job `stacks` renders every stack per backend and runs tofu/terraform validate + shellcheck. Golden test: the example inputs reproduce app-foundry's own `main.tf`/`backend.tf` byte for byte. `scripts/sync-stack.sh` re-vendors from app-foundry.

### Next
- Step 3: dashboard "new project" flow (template picker, target, backend) on these routes; a settings-edit route that re-renders into a new PR.
- Files a stack stops shipping are not deleted from the customer repo yet.
- `prisma migrate diff` against a fresh DB shows a pre-existing FK drift on `Workspace.connectionId` from 0011 (not from 0012).

## 2026-10-08 (session 13)

### Completed
- **First live run of workspace adoption and extensions** against HCP Terraform (org `jschell12-sandbox`), API run locally from `d1f30ed` against a throwaway Postgres. Base fixture: a CLI-driven workspace applying only `terraform_data`, with one plain, one sensitive and one env variable.
  - Connect: valid; the token is never echoed. A duplicate label answers 409.
  - Adopt: three outputs recorded with their sensitivity; the sensitive and env values were not stored; reported "no VCS repository" for the template, which is correct for a CLI workspace.
  - Extension takeover refusal against the real, hand-built `hashicat-aws`: 409, and that workspace's `updated-at` did not move.
  - Extension `e2e-ext`: created with the infralift marker and auto-apply off; the base listed it as its only remote-state consumer; an inbound run trigger from `e2e-base`.
  - **The generated `deps.tf` works inside a real TFC run**: `app = "app-in-vpc-e2e-us-west-2"`, the plain output, and the sensitive one (redacted, correct length), all read with the run's own token.
  - Changing the base and applying it queued a run in the extension with source `tfe-run-trigger`.
  - Control: with the remote-state grant removed, the extension's plan fails with `Error retrieving state: forbidden`. The grant infralift sets is what makes the wiring work. Re-adding an existing consumer answers 204, so retries are safe.
- **Fixed a process-killing bug found by that run.** For a CLI-uploaded configuration version, `GET /configuration-versions/:id/ingress-attributes` answers `200` with a body of literally `null`, not the 404 the client expected. The resulting TypeError escaped the async handler, and Express 4 does not catch those, so the whole API exited. In production that is every tenant's API, on any unexpected TFC response. `tfcFailure` now answers 502 for any error and never rethrows, and the client tolerates null bodies.

- **A rejected async handler no longer exits the API.** Review of #91 found the defect was wider than one route: `server.ts` had no error middleware, so any of ~45 async handlers, including `cfAuth`, which writes to the database on every request, could take the process down for every tenant. `catchAsyncErrors` walks the mounted router tree once, after every route is registered, and routes rejections to a final handler that logs and answers a bare 500. App construction moved to `app.ts` so a test can run the real app; with the database refusing connections, `/workspaces`, `/connections` and `/assessments` answer 500 and `/health` keeps answering. Removing the wrapper makes that test fail with an unhandled rejection.

### Not verified
- **Templatizing from a VCS commit.** The sandbox org's GitHub OAuth connection dates from 2021 and can no longer see any repo, public or private. Reconnecting it needs the OAuth flow in a browser. Until then the `?ref=<sha>` module source has only been checked with `terraform validate` on a local stub.

## 2026-10-07 (session 12)

### Completed
- **Workspace adoption and workspace extensions, API only.** A project can now be backed by several workspaces in the customer's own HCP Terraform or Terraform Enterprise org:
  - `POST /workspaces/connections` stores a per-org TFC/TFE connection (hostname, organization, token; provider `tfc`). Until now the only TFC client was infralift's own org from env.
  - `GET /workspaces/remote` lists the customer's workspaces and which are already known.
  - `POST /workspaces/adopt` records an existing workspace (variables, output names, VCS repo, current commit) and templatizes it as an org-private template: a `module` block whose source is their repo pinned to that commit, with their Terraform variables as inputs.
  - `POST /workspaces/projects/:id/extensions` creates a new workspace in their org, adds it as a remote-state consumer of each base, adds a run trigger from each base, and returns the `deps.tf` that reads the wired outputs.
  - `GET /workspaces/projects/:id` returns the graph with apply and destroy order.

### Decisions
- **Adopted means frozen.** Their code and state stay where they are. The template pins `?ref=<sha>`, so a new version only exists when someone adopts again. Nothing upgrades a handcrafted workspace.
- **Sensitive variables never become template inputs.** They render as `variable` declarations passed through, so a secret is never written into a committed file, and their values are dropped before the database whatever the API returns. Env-category variables are left out as workspace settings, and listed in `skipped`.
- **Wiring uses `terraform_remote_state` with the remote backend, not `tfe_outputs`.** Inside an HCP run the remote backend authenticates with the run's own token, gated by the base's remote-state-consumers list, which infralift sets. `tfe_outputs` would need a `TFE_TOKEN` planted in the extension workspace, which would mean copying the customer's API token into their workspaces. It also works unchanged under OpenTofu.
- **Templates gained an `orgId`.** Null is the shared catalog; set is private. Every slug lookup in `tf.ts` now filters on it, and the admin catalog write refuses a private slug. The FK is RESTRICT, because SET NULL on an org delete would publish that org's template to everyone.
- **An extension never takes over an existing workspace.** Found in review: creating an extension reused any same-named workspace in the customer's org, which would have wired state sharing and run triggers into something they built by hand. Infralift now marks workspaces it creates in their description, reuses only one carrying this project's marker (a retry), and otherwise returns 409 and points at adopt.
- **TFE hostnames must be public DNS names**, re-checked against their resolved addresses whenever the connection is used, and the client no longer follows redirects. The API runs on the home network, and a self-serve user choosing the host could otherwise aim it at `10.x`. DNS rebinding is not covered.
- **Re-adopting refreshes a workspace; it cannot move it** to another project, connection or TFC workspace, which would strand the extensions that depend on it. Env variable values are no longer stored at all.
- **The TFC token is not read-only**, unlike assessment connections: creating workspaces, run triggers and state sharing all write. It is kept out of the shared `PROVIDERS` list, and `/connections/:id/verify` and `/assessments/run` now refuse non-assessment connections instead of failing on a missing connector.

### Verification
- 275 API tests (from 205), `tsc --noEmit` clean. New tests fail when the org filter on the connection lookup, the template-visibility filter, or the sensitive-value drop is removed, checked by removing each.
- Generated adopted-template and wiring HCL pass `validate` and `fmt -check` under both `terraform` and `tofu` (module source swapped for a local stub, since `init` would fetch the git source).
- **Known gaps, accepted for now:** non-sensitive Terraform variable values are stored in plain JSON because they become template defaults, so a secret someone forgot to mark sensitive lands in the database. The private-address check misses NAT64, `198.18.0.0/15` and the LAN's own global IPv6 addresses; TLS keeps those to a reachability probe on 443. TFE on a non-443 port is refused.
- **Not exercised against a live TFC org.** The endpoint shapes were checked against HashiCorp's API docs, not a real response.

### Next steps
- Run it once against a real TFC org: adopt a VCS-backed workspace, add an extension, confirm the extension's plan can read the base's outputs.
- Migration `0011_workspace_extensions` has to be applied before deploying.
- Dashboard UI for adopt and extensions. Committing `deps.tf` into the extension's repo through the existing pipeline. Managed (catalog) workspaces and automatic upgrades for them are not built.

## 2026-09-08 (session 11)

### Completed
- **Public cost estimator, live at https://infralift.dev/estimate (PR #88).** Eleven form fields, no account, no provider token, no email, nothing stored. It closes the gap that every other entry point asked for something before it said anything: the signup wants a Google account, the assessment wants a snapshot bundle. Both are fair asks after someone believes there is money on the table and walls before it.
- **schellout PR #295 applied**: a second Cloudflare Access application for `/intake/estimate`, plus an unrelated fix described under Decisions.
- **Three Worker secrets set on `infralift-web`** (`LEAD_INTAKE_URL`, `LEAD_INTAKE_CF_CLIENT_ID`, `LEAD_INTAKE_CF_CLIENT_SECRET`) from the schellout TFC workspace outputs. This also lit up the lead form, which had been built and dark since 31 Aug, though `NEXT_PUBLIC_LEAD_FORM_ENABLED` is still unset so it does not render.
- Hero CTA on the homepage now leads with the estimator, ahead of the signup.

### Decisions
- **The estimator owns no pricing.** It builds a `WorkloadFootprint` and calls the same `planTarget`/`sizeTarget` that drive the options page and the generated HCL, with a test asserting all three agree. A copy of the price list in `apps/web` would have drifted inside a release, and the assessment someone runs afterwards would then contradict the first number they ever saw. Same reasoning as PR #72.
- **It subtracts the operations work, and it can say "stay where you are".** `opsBurden` prices only net-new hours (patching, backup verification, host monitoring), not deploys or on-call, which happen on both sides of a move. $150/hr default, overridable in the form. A 12-dyno shop at $260/mo comes back at -$5,292/yr with `bestSlug: null`. That negative answer is the point: it is what makes the positive rows believable, and it disqualifies a prospect before either side spends a call.
- **Workers is gated on fit, not just price.** `sizeCloudflare` prices it for anything because it counts requests and bandwidth and knows nothing about what serves them. It was recommending Workers at $11,156/yr to an eight-dyno Rails shop. Ineligible targets are still priced and shown with the reason, never ranked first.
- **Two Access applications rather than one widened to `/intake`.** An Access app's `domain` is an exact path prefix. Widening would have pre-authorised every future route under `/intake` before anyone looked at it.
- **Caught a tunnel-drift landmine.** The plan for #295 came back `1 to add, 1 to change`, and the change was not ours: Terraform wanted to drop a live `dashboard.permitguv.com` ingress rule that had been added to the tunnel by hand and never written down. schellout applies on merge, so any terraform PR would have taken that hostname offline. Adopted it into the ingress list first, the same way `admin.permitguv.com` was on 31 Aug. It was still answering 307 after the apply.

### Verification
- 205 API tests (from 187), 29 web tests (from 18). `tsc --noEmit` clean in both apps.
- Exercised against the live public path with no authentication, not just a local 200: three workload shapes return the expected figures, a malformed body gives a readable 400, a bot user-agent is absorbed.
- Useful diagnostic for next time: with the Access app live but the API not yet deployed, `/intake/estimate` answered 401 rather than 404, because an unregistered Express route falls through to `cfAuth`. Access admitting the service token shows as a `CF_Authorization` cookie on the response whose `common_name` is the token; a 403 means it never reached the origin.

### Blockers
- None for the estimator; it is live and verified.
- **STATUS.md has diverged between the remote and the main checkout, and neither side is complete.** The committed file jumps from this entry straight to session 5: sessions 6 through 9 were never pushed. They exist in the main checkout's working copy, which in turn has no session 10 entry, because that one was committed from a worktree built on an older base. On top of that the main checkout sits 20 commits behind `origin/main` with STATUS.md both staged and further modified, so `git pull --ff-only` there fails silently. Reconciling the two by hand is a five-minute job that has been deferred repeatedly; each session avoids it because committing another session's uncommitted work is against the commit-scope rule, so it never lands. Worth doing deliberately.

### Next steps
- **One execution on a friendly, free or at cost.** Twelve fixture and target combinations pass `tofu init`/`validate`, which proves the HCL parses and not that an application boots on Hetzner. Selling a plan whose whole value is being right, having never once been right in production, is thin and the sharper buyers will ask.
- **Rewrite `docs/migration-process.md`.** It still promises a cutover rehearsal, a 7 to 14 day rollback window, and 30 days of post-cutover support. Under a plan-first model those are promises nobody intends to keep.
- Go after the 42 Vercel billing-pain leads. The estimator is the outbound asset for them, and the gate is still payer conversations per week.
- Decide on `NEXT_PUBLIC_LEAD_FORM_ENABLED`. The estimator arguably makes the lead form redundant, since it answers the same objection without asking for an email.

> **Note on the gap below.** Entries for sessions 6 through 9 exist only in the
> local working copy of this file (~268 uncommitted lines) and were never
> committed. They cover PRs #54-#72. Commit them and this history is whole
> again; until then the committed file jumps from session 5 to session 10.

## 2026-08-31 (session 10)

Seven PRs here (#72-#78) and two in schellout (#279, #280). The through-line:
the product could not do several things the site said it did, and there was no
way for anyone who believed the site to get in touch.

### Completed

- **Target codegen now generates from the workload, not source resource types (PR #72).**
  The options page priced a Heroku exit at $422/mo (1x CCX43, 2x CCX13, LB11,
  Neon 2CU, Upstash 5GB) while `target-hetzner.tf` emitted a comment
  recommending a CPX31, zero servers, and a `neon_project` whose provider was
  never declared. `planTarget()` in `sizing.ts` is now the single source both
  the priced estimate and the HCL read, so they cannot drift. All existing
  prices verified byte-identical after the refactor.
  - Fixed four provider-schema bugs found by running `tofu validate` against
    all six demo fixtures: `cloudflare_workers_script` used `name`/`module`
    (v5 wants `script_name`, no `module`); `render_web_service` used `runtime`,
    which is not an argument, and needs `runtime_source` plus `start_command`;
    Render plans emitted as display names not slugs; `vercel_project_domain`
    referenced a `vercel_project` never generated, because Vercel's domains API
    is account-scoped and does not report the owning project.
  - All 12 fixture x target combinations pass `tofu init` + `validate`.
    Hetzner was previously 0/6.

- **Approval flow: assessment to repo to workspace (PR #73).** Generated HCL
  was a dead end; `/tf/codegen` returned JSON to a browser and nothing ever
  committed it. Added `ensureRepo()` and `commitFiles()` (git data API, one
  atomic commit for the whole directory), `POST /tf/approve`, an
  "Approve and build it" drawer, and schema support for codegen-shaped
  projects/jobs.
  - **Security fix:** `POST /tf/jobs` fetched the project with no org check, so
    any authenticated user could launch a job against another org's project and
    make infralift commit into that org's repo with that org's GitHub token.
    Same gap on three other routes.
  - **Migrations were broken:** `0001_initial/migration.sql` had Prisma CLI
    output pasted into it (a deprecation warning and an "update available"
    banner), so applying migrations from scratch failed on the first one.
  - Exit toll computed (`lib/exit-toll.ts`), which docs/migration-process.md
    had promised and no connector produced.

- **Marketing honesty pass (PRs #74, #76, #78).** An audit against the live
  site found it selling several things that did not exist.
  - Removed: "10x scale" projections (four places, zero implementation),
    GitLab support (`git.ts` is hardcoded to api.github.com), drift detection
    (`driftDetected` is written by nothing), IaC standards enforcement (a
    hardcoded array of `status: "pass"`), workspace management (nothing ever
    creates a `Workspace` row). The $99/mo tier now lists what the dashboard
    actually does.
  - Shipped rather than removed: cost projection and recommendation were
    advertised and appeared nowhere; the logic already existed on the options
    page, so `GET /assessments/:id` now derives both from the same
    `buildMigrationOptions` call.
  - Fixed two live defects: every docs page shipped
    `href="http://localhost:3001"` as its CTA, and `/docs/cost-scenarios` was
    publicly serving internal sales strategy ("Marketing angles to extract",
    "Sweat thresholds ... they are the target customers") plus a pricing tier
    that contradicted the pricing page. Edited rather than removed; it is now
    linked in the nav.
  - The read-only credential claim is reconciled with the GitHub write token
    the pipeline requires, which appeared in neither security.md nor
    connect-providers.md.
  - Removed every response-time promise ("same day", "within a working day").

- **Marketing site deploys from CI (PR #75).** `apps/web` had no deploy job;
  every change needed a manual `wrangler deploy`, which is why the localhost
  CTA stayed live. The job carries a guard that fails the build if any
  `localhost:` URL reaches the export. Minted a dedicated Cloudflare token
  (`infralift/CF_DEPLOY_TOKEN`, expires 2027-08-30).

- **Lead capture built (PR #76), gated off.** There was no way to become a
  customer: the CTA pointed at a Cloudflare Access login page and `/health` was
  the only unauthenticated route. Added `InboundLead`, `POST /intake/lead`
  registered above `cfAuth`, a Worker `/a/lead` that forwards, the first client
  component on the marketing site, and an admin page.

- **Test gaps closed (PR #77).** `apps/web/lib/leaving.ts` carries hard-coded
  figures for six public pages with nothing enforcing they match the pricing
  engine; a change to `sizing.ts` would have left them quoting numbers the
  product no longer produces, silently. There is now a guard, mutation-tested.
  The Worker had no tests and CI could not have run them (`pnpm test` only ran
  the api package). Tests 82 to 155.

- **schellout: terraform plan-on-PR, apply-on-merge (#279, #280).** Terraform
  was the last thing deployed by hand. State lives in HCP Terraform with remote
  execution, so CI never holds a Cloudflare token. The first plan caught
  pre-existing drift: state held the duplicate GitHub IdP deleted by hand on
  2026-08-30 and wanted to recreate it. Resolved with a `removed` block.
  Also added the Access service token that unblocks lead intake.

### In progress

- **Lead capture is two steps from live.** The Access service token and
  application are applied. Remaining: set `LEAD_INTAKE_URL` plus the two token
  halves as Worker secrets, and flip `NEXT_PUBLIC_LEAD_FORM_ENABLED=true` in
  the `deploy-web` job. Held deliberately: turning it on starts collecting
  email addresses from strangers, which is a launch decision.

### Blockers

- None technical. The lead form is a decision, not a blocker.

### Next steps

- Turn on the lead form, then go after the 42 Vercel billing-pain leads. The
  landing pages, demo assessments, applyable target IaC and intake path all
  exist now.
- HCP Terraform still sets no VCS relationship and uploads no configuration
  version, so codegen-created workspaces land on `awaiting_configuration`.
  Needs a per-org TFC OAuth token id that nothing obtains.
- No workspace-variables API at the client or adapter layer, so generated infra
  has no way to get cloud credentials into TFC.
- Codegen jobs are fire-and-forget `void runJob()` with no queue, retry,
  timeout or reaper; a restart mid-job strands the row at `pending` and the
  dashboard polls it forever.
- Delete the one-shot `removed` block in schellout's tunnel.tf now that it has
  applied.
- Still open from the codegen findings: source-side Vercel import fidelity, and
  `vercel:postgres` emitting the retired `vercel_postgres_database` (no fixture
  exercises it).
- Move infralift-testenv Terraform state to a remote backend; it is still local
  and gitignored, and was wiped once by `git worktree remove --force`.

### Decisions worth remembering

- **Edit, do not delete, cost-scenarios.** I first recommended removing the
  page based on a subagent's summary without reading it. It was ~210 lines of
  good public content and ~10 lines of internal framing. Scenario 1's
  "not an infralift customer" verdict was kept and sharpened: telling someone
  not to hire you is the most trustworthy thing on the page.
- **`non_identity`, not `bypass`, for the intake path.** The trip-wizard admin
  API can use bypass because the Worker behind it checks a bearer token.
  Nothing sits behind `/intake/lead` except an unauthenticated Express route.
- **The browser posts to the Worker, not the API.** Same-origin, so no CORS
  preflight and no public origin added to a `credentials: true` allowlist that
  every authenticated route also reads.
- **`/a/lead` does not swallow errors, `/a/e` does.** A lost pageview costs a
  row in a chart; a lost lead costs a customer.
- **Auto-apply was acceptable because WireGuard is Ansible-managed.** The
  terraform blast radius includes the Access app in front of SSH and the tunnel
  carrying it, so there had to be a second way into the fleet.

## 2026-08-29 (session 5)

### Completed
- **CI/CD pipeline (`.github/workflows/ci.yml`)** — First GitHub Actions workflow in the repo. `check` job runs on every PR and every push to `main`: install, `db:generate`, build `packages/*`, typecheck all four apps, run the 42 api tests, build all four apps. `deploy` job runs after `check` passes on `main` only, builds the three Docker images and rolls the Nomad allocations. This is what makes merge-from-phone work: approve and merge the PR on mobile, and the deploy runs itself.
- **Admin app responsive on mobile** — `admin.infralift.dev` was a fixed 220px sidebar in a flex row, so a 390px phone left ~90px of content column and every page wrapped one word per line. New `apps/admin/components/nav.tsx` renders a sticky top bar with a hamburger below `md` and the existing sidebar at `md`+, with active-link highlighting on both. Layout is column on phones, row on desktop. Tables now scroll sideways inside their card (`TableScroll`) instead of crushing their columns; the leads table drops to a stacked card per lead below `md`. Stat strips go 2-up (was 1-up) on phones. Verified at 390x844: zero horizontal page overflow on every route, desktop unchanged.
- **Cloudflare Access token handling hardened (`apps/api/src/lib/cf-auth.ts`)** — The scanner page's "Invalid access token" is the API's generic 401 for *any* `jwtVerify` failure, which hid the actual cause. Two changes: (1) all `CF_Authorization` cookie values are now tried, not just the first one the regex finds — a browser holds one cookie per Access application that has issued a session, and only the token whose `aud` matches `CF_ACCESS_AUD` verifies, so cookie order decided whether requests worked; (2) the 401 now carries the jose error code (`ERR_JWT_EXPIRED`, `ERR_JWT_CLAIM_VALIDATION_FAILED`, `ERR_JWKS_NO_MATCHING_KEY`, ...) and the log line records the candidate count and configured AUD. 5 new unit tests for the cookie parser.

### CI/CD

`.github/workflows/ci.yml`, two jobs:

| Job | Runner | Triggers | Does |
|---|---|---|---|
| `check` | `ubuntu-latest` | every PR, every push to `main` | install → `db:generate` → build `packages/*` → `pnpm lint` → `pnpm test` → build `apps/*` |
| `deploy` | `[self-hosted, infralift-framework]` | push to `main`, after `check` passes | `make build` (api, dashboard, admin images) → `nomad job restart -reschedule -yes $NOMAD_JOB` |

`check` needs nothing set up — it runs today. Ordering matters: the api's types come from the generated Prisma client and three apps import `@infralift/shared`, so `db:generate` and the `packages/*` build both have to precede `tsc`.

`deploy` is gated on `vars.DEPLOY_ENABLED == 'true'` and stays skipped until the following are done by hand (a job pointed at a runner that does not exist queues forever, which is why the gate is there rather than the workflow simply being enabled):

1. Register a self-hosted runner on the Framework host (10.0.0.2) with the label `infralift-framework`. It runs on the Nomad client itself because the LAN is not reachable from GitHub-hosted runners — which also means `make deploy-images` (`docker save | ssh docker load`) is not needed, the images are built where they are consumed.
2. The runner's user needs Docker access and a `nomad` binary with `NOMAD_ADDR` set for the cluster.
3. Set repository variable `DEPLOY_ENABLED=true`. Optionally set `NOMAD_JOB` if the job is not named `infralift`.
4. Optionally set `main` as a protected branch requiring `check` to pass, so a red build cannot deploy.

Not covered yet: `apps/web` (marketing site) still deploys separately via Cloudflare, and Prisma migrations are not run by the pipeline — `prisma migrate deploy` is still a manual step on schema changes.

### Why the scanner page said "Invalid access token"

The string is `apps/api/src/lib/cf-auth.ts` returning 401 after `jwtVerify` threw. It is reached only when a token *was* present (no token gives "Missing Cloudflare Access token"), so the cookie arrived through the Next.js `/api` rewrite and failed verification. The candidates, in order of likelihood:

1. **`aud` mismatch** — `CF_ACCESS_AUD` on the api Nomad job does not match the AUD of the Access application that issued the cookie the browser sent. `admin.infralift.dev` was added in session 3, after the wildcard `*.infralift.dev` app; if admin ended up under its own Access app, or the wildcard app was recreated, the AUD changed and the api was never updated.
2. **Wrong cookie picked** — with both a wildcard app and a host-scoped app in play the browser sends two `CF_Authorization` cookies; the old parser took whichever came first. Fixed above.
3. **Expired token** — a long-lived mobile tab holding a stale cookie (`ERR_JWT_EXPIRED`).
4. **JWKS unreachable** — the api container could not fetch `https://$CF_ACCESS_TEAM_DOMAIN/cdn-cgi/access/certs` (`ERR_JWKS_NO_MATCHING_KEY` / a fetch error).

To settle which: `nomad alloc logs <api-alloc>` now prints the candidate count and the configured AUD alongside the jose error, and the browser shows the error code inline. If it reads `ERR_JWT_CLAIM_VALIDATION_FAILED`, compare `CF_ACCESS_AUD` in the Nomad job against the AUD of the Access app covering `admin.infralift.dev` in the Cloudflare dashboard.

### Next steps
- Register the self-hosted runner and flip `DEPLOY_ENABLED` to turn merge-to-deploy on
- Reconcile `CF_ACCESS_AUD` with the Access app actually covering `admin.infralift.dev`
- Give `apps/dashboard` the same responsive treatment (identical fixed-sidebar layout, same problem on mobile)
- Add `prisma migrate deploy` to the deploy job once migrations are trusted to run unattended
- Execute a full migration from Vercel/Heroku to Cloudflare or Hetzner target
- Wire TFC client with real credentials for workspace creation

## 2026-08-27 (session 4)

### Completed
- **E2E pipeline proven** — Reference app deployed to Vercel and Heroku with Neon Postgres (API-provisioned). Real assessments run via infralift connectors. Full pipeline: deploy, connect, assess, get inventory + cost + recommendations.
- **Vercel assessment**: 2 resources (projects), Next.js migration recommendation, usage-based billing finding.
- **Heroku assessment**: 2 resources (app + Basic dyno), $7/mo cost, dyno cost finding.
- **Neon databases created via API** — 2 projects (infralift-e2e-vercel, infralift-e2e-heroku) under hustlehawk org.
- **Lead intelligence report (PR #41)** — Provider pain matrix, top leads, strategic analysis at admin.infralift.dev/report.
- **Removed hardcoded Key insight (PR #43)**.

### Live E2E deployments
- Vercel: reference-40e5m01ib-jschell12s-projects.vercel.app
- Heroku: infralift-e2e-58df521cccc0.herokuapp.com
- Both connected and assessed via dashboard.infralift.dev

### Next steps
- Execute a full migration from Vercel/Heroku to Cloudflare or Hetzner target
- Wire TFC client with real credentials for workspace creation
- Go after Vercel leads (42 billing pain leads) with free assessment offer
- Outreach templates for high-engagement leads

## 2026-08-27 (session 3)

### Completed
- **Lead intelligence report (PR #41)** — GET /leads/report with provider pain matrix (cross-tab), source/status breakdown, top 20 leads. Admin report page at /report with "Where infralift fits" analysis.
- **Providers column + purge (PR #39)** — providers[] tracks mentioned platforms. Purged 184 off-topic leads (290 to 106). All leads now tagged with source providers.
- **Tightened classifier** — Hosting context gate, platform-specific Bright Data keywords, generic terms removed.

### Lead state (106 leads)
- Vercel: 42, AWS: 37, Cloudflare: 24, GCP: 12, Firebase: 12
- 80 billing pain, 13 migration interest, 13 platform complaints

### Next steps
- Sign up for Vercel + Heroku, deploy reference app, run assessments
- Wire TFC client with real credentials
- Outreach templates for high-engagement leads

## 2026-08-27 (session 2)

### Completed
- **Lead actions + scanner status (PR #38)** — PATCH /leads/:id with status (new/contacted/dismissed/converted) + notes. Scanner status page at admin/scanner. Contact/Dismiss buttons on leads table. TFC client with real API calls.
- **Providers column (PR #39)** — CommunityLead.providers[] tracks which source platforms are mentioned (vercel, heroku, firebase, aws, etc.). Classifier extracts providers and gates on hosting context. Admin leads page shows provider badges. Purged 184 off-topic leads total (290 down to 106).
- **Tightened classifier** — Requires hosting/cloud context before scoring. Platform-specific Bright Data keywords. Generic terms like "cloud cost" replaced with "vercel pricing expensive", "heroku migration alternative".

### Lead counts (106 clean leads)
- Vercel: 42, AWS: 37, Cloudflare: 24, Firebase: 12, GCP: 12
- Railway: 6, DigitalOcean: 6, Netlify: 6, Azure: 6, Heroku: 5, Fly.io: 3

### Next steps
- Sign up for Vercel + Heroku (links provided), deploy reference app
- Build more admin features (lead detail view, outreach templates)
- Wire TFC client with real credentials
- Continue scanner improvement based on lead quality feedback

## 2026-08-27

### Completed
- **Bright Data Reddit integration** — Keyword discovery scraper using Bright Data Scraper API ($1.50/1k records, ~$18/mo estimated). 14 search terms, async snapshot polling (10s intervals, 2min timeout), comment collection on top 5 posts. Valid date values: "Past hour", "Past week", "Past month" (not "Past day"). Deployed to infralift-scanner:local Docker image.
- **Bright Data API key** — Stored in scredmgr and Vault (secret/data/infralift). Nomad scanner job updated to pass BRIGHTDATA_API_KEY.
- **First Bright Data scan verified** — 25 Reddit posts discovered, 138 comments fetched, 17 new leads stored. Total leads now: 290 (231 billing pain, 38 migration interest, 21 platform complaint).
- **Scanner running on schedule** — Every 4 hours via Nomad batch job. Reddit via Bright Data, HN/DEV.to/SE/Lobsters via public APIs. RSS fallback when no BD key.

### Lead counts (290 total)
- Hacker News: 201
- DEV.to: 35
- Reddit comments (Bright Data): 31
- Reddit posts (Bright Data): 23

### Next steps
- Sign up for Vercel + Heroku, go after billing_pain leads
- Build admin dashboard features (scanner status, lead actions)
- Focus on Terraform + TF Cloud integration
- Submit Google Safe Browsing review for admin.infralift.dev

## 2026-08-26 (session 3)

### Completed
- **Admin app deployed (PR #35, schellout PR #260)** — New apps/admin Next.js app at admin.infralift.dev. Leads and communities pages moved from customer dashboard. Separate Nomad group on port 30382 with Dockerfile and Makefile target. Tunnel ingress + DNS CNAME created. UFW port opened. All three Nomad groups healthy.
- **Customer dashboard cleaned** — Leads and communities nav links removed, sidebar shows only customer-facing features.
- **Chrome Safe Browsing false positive** — admin.infralift.dev flagged as "Dangerous site" due to new subdomain with no reputation. Will clear automatically. Can request review at safebrowsing.google.com.

### Next steps
- Submit Google Safe Browsing review for admin.infralift.dev
- Integrate Bright Data Reddit scraper for posts + comments
- Sign up for Vercel + Heroku, go after leads
- Focus on Terraform + TF Cloud integration

## 2026-08-26 (session 2)

### Completed
- **Tailwind CSS conversion (PR #33)** — Replaced 330 lines of hand-written CSS with Tailwind v4. All 11 dashboard pages converted to inline utility classes with custom @theme colors.
- **Leads dashboard page** — Stat cards (179 billing pain, 36 migration interest, 21 platform complaints), filters (classification/platform/days), sortable table with 235 leads.
- **Communities dashboard page** — 48 sources with platform/category filtering, member counts, relevance descriptions.
- **Public infralift-scanner repo** — github.com/jschell12/infralift-scanner. Standalone Node.js scanner with Reddit RSS (curl-based), HN Algolia, DEV.to, SE, Lobsters scrapers. Keyword classifier (no LLM cost).
- **Backfill from Jan 1 2026** — 235 leads stored from 3,875 scraped posts via broadened HN queries (27 search terms, pagination) and DEV.to tag pagination.
- **Reddit ticket filed** — API access request submitted via support.reddithelp.com. RSS workaround deployed (curl bypasses Node TLS fingerprinting).
- **Schellout cleanup (PR #258)** — Removed infralift.dev zone import block from tunnel.tf.

### Decisions
- **Separate admin app**: Leads and communities will move to a new admin.infralift.dev app. Customer dashboard stays clean for customer-facing features only.
- **Bright Data for Reddit**: Will use Bright Data's Reddit scraper for posts + comments instead of direct API. Avoids API approval dependency and gets comment-level data.
- **Keyword classifier over LLM**: Zero cost, no API key dependency. Catches ~80% of what an LLM would catch. Can add LLM later for higher precision.
- **Reddit RSS via curl**: Node.js fetch gets TLS-fingerprinted 429 by Reddit. curl subprocess works. 10s spacing between subreddits.

### Next steps
- Build admin.infralift.dev as a separate Next.js app (leads, communities, internal tools)
- Integrate Bright Data Reddit scraper for posts + comments
- Sign up for Vercel and Heroku, go after leads from those platforms
- Focus on Terraform and TF Cloud integration (not OpenTofu yet)

## 2026-08-26

### Completed
- **Community sources table (PR #30)** — 48 communities seeded across Reddit, HN, Stack Exchange, Discord, Slack, forums, blogs, vendor communities. GET /communities endpoint with platform/category filtering. Prisma binaryTargets fix for Docker (debian-openssl-3.0.x).
- **Community scanner + leads pipeline (PR #31)** — 5 platform scrapers (Reddit RSS, HN Algolia, DEV.to, Stack Exchange, Lobsters), keyword classifier (no LLM), CommunityLead model, GET /leads endpoint.
- **Public scanner repo** — github.com/jschell12/infralift-scanner (standalone Node.js, pg direct, curl-based Reddit RSS). Created for Reddit API approval review.
- **Nomad scanner job (schellout PRs #256-#257)** — Periodic batch job every 4 hours on Framework, uses infralift-scanner:local Docker image.
- **Backfill from Jan 1 2026** — 235 leads stored from 3,875 scraped posts (201 HN, 34 DEV.to). Broadened HN Algolia queries (27 search terms, pagination).
- **Reddit API ticket filed** — Submitted via support.reddithelp.com, pending approval. Devvit app "infralift" registered. RSS workaround working via curl (Node fetch gets TLS-fingerprinted 429).
- **API redeployed** — New image with communities + leads routes, schema pushed, migrations resolved.

### Debugging notes
- Reddit blocks Node.js fetch with 429 (TLS fingerprinting) but curl gets 200. Workaround: execSync curl in scraper.
- Reddit RSS needs 10s+ spacing between subreddit fetches to avoid rate limiting.
- Prisma `binaryTargets = ["native", "debian-openssl-3.0.x"]` required for Docker; must `--no-cache` build to regenerate engine.
- Prisma migrations marked as failed if `db push` was used first; fix with `prisma migrate resolve --applied`.

### Next steps
- Wait for Reddit API approval, then switch from RSS to OAuth
- Add leads dashboard page to infralift dashboard
- Sign up for source hosting platforms (Vercel, Heroku, etc.) for E2E testing
- Implement OpenTofu + S3 backend toggle
- Remove import block from schellout tunnel.tf

## 2026-08-25 (session 6)

### Completed
- **E2E migration demo (PR #28)** — 110 files, 6,018 lines. Reference Express app (pg + S3 client) deployable to all 12 source platforms. Deploy configs for 7 Terraform platforms (AWS, Azure, Cloudflare, DO, Fly.io, GCP, Netlify) and 5 CLI platforms (Vercel, Heroku, Render, Railway, Firebase). Migration templates for 2 targets (Cloudflare Workers + R2 + Neon, Hetzner VPS + Docker + Neon). 24 per-source migration runbooks. Cost analysis showing 74-96% savings. 4 orchestration scripts. All TF configs validated.

### Next steps
- Provide API keys for each platform and run `e2e/scripts/deploy-all.sh`
- Run assessments against deployed apps via `e2e/scripts/run-assessments.sh`
- Execute a full migration from one source to each target
- Remove import block from schellout terraform/tunnel.tf (zone now in state)

## 2026-08-25 (session 5)

### Completed
- **Dashboard fully operational** (PRs #25-#26) — Fixed API connectivity. Dashboard proxies /api/* to Express backend via Next.js rewrites (same-origin, no CORS). Removed stale NEXT_PUBLIC_API_URL build arg that was baking localhost:4000 into the image.
- **UFW firewall** — Opened ports 30380/30381 on Framework for LAN + failover subnets. Cloudflared on mac-mini can now reach the services.
- **Terraform applied** — Imported infralift.dev zone, created DNS CNAMEs, Access app, tunnel ingress (all via TFC remote apply).
- **End-to-end verified** — dashboard.infralift.dev loads, authenticates via CF Access OTP, connections page renders with API data.

### Debugging notes (this session)
- Cloudflare Access wildcard `*.infralift.dev` shares auth but cross-origin fetch still fails (browser won't send cookie cross-subdomain). Fix: proxy API through dashboard same-origin.
- `NEXT_PUBLIC_*` vars baked at Docker build time. If Dockerfile has `ARG NEXT_PUBLIC_API_URL=X`, that overrides the code default. Remove the ARG to let code defaults work.
- UFW on Framework has default DROP policy. New Nomad service ports must be explicitly allowed.

## 2026-08-25 (session 4)

### Completed
- **Dashboard + API deployed to homelab** — Both running on Framework (10.0.0.2) as Nomad Docker job. API on port 30380, dashboard on port 30381. Both healthy.
- **Cloudflare tunnel + Access** (schellout PRs #250-#252) — `dashboard.infralift.dev` and `api.infralift.dev` routed through schellout tunnel. Wildcard Access app `*.infralift.dev` gates to jschell12@gmail.com only.
- **Database provisioned** — `infralift` role + database on shared Postgres (:5432). Schema pushed via `prisma db push`. Seeded: 16 hosting providers, 15 discount programs, 3 TF templates, dev-org.
- **Docker build fixes** (infralift PRs #21-#22) — Dockerfiles, Makefile with `--platform linux/amd64` for cross-compile, openssl in API image for Prisma, full workspace copy to preserve pnpm symlinks.
- **Initial Prisma migration** (PR #23) — Baseline migration SQL for future `prisma migrate deploy` on redeploys.
- **Marketing site redeployed** — CTAs now point to `https://dashboard.infralift.dev`.
- **Neon migration script** — `scripts/migrate-to-neon.sh` ready for future cloud move.

### Debugging notes
- Docker images must target `linux/amd64` (Framework is x86, MacBook is ARM)
- Nomad `<<-EOF` heredoc strips tabs but not spaces; env var templates must be left-aligned
- Vault password for DB URL must not contain `/` (breaks URI parsing); use `openssl rand -hex` not `-base64`
- `node:22-slim` needs `apt-get install openssl` for Prisma query engine
- Prisma pnpm monorepo needs full `/app` copy in Dockerfile (cherry-picking breaks symlinks)

### Next steps
- Verify dashboard end-to-end in browser (Access login, connections, assessments)
- Create provider accounts and run real integration tests
- Implement OpenTofu + S3 backend option in TF pipeline
- Update connect-providers docs to cover all 12 source providers
- Remove the `import` block from `tunnel.tf` (zone now in state)

## 2026-08-25 (session 3)

### Completed
- **Marketing copy rewrite (PR #19)** — Rewrote landing page for startup audience. New hero: "Your cloud bill shouldn't scale faster than your revenue." New "Why now" section with Vercel inflection point ($400 vs $80 at 100k MAU), Firebase read amplification ($70k/day), Heroku maintenance mode data. Stat cards: 5-10x savings, $850 vs $80, 12 providers. CTA: "Start at $20/mo. Migrate at $200/mo. Not at $3,000/mo." Step 1 lists all 12 source providers. Assessment card updated to show "current and 10x scale" projections. Meta description updated for SEO.

### Next steps
- Create provider accounts and run real integration tests with TF fixtures
- Implement OpenTofu + S3 backend option in TF pipeline (backend block toggle)
- Add Terraform templates for Hetzner VPS Docker Compose target pattern
- Consider Linode connector; seed missing discount programs (Railway, Fly.io)
- Update connect-providers docs to cover all 12 source providers

## 2026-08-25 (session 2)

### Completed
- **Terraform test fixtures (PR #16)** — Validated configs for AWS, Azure, Cloudflare, DigitalOcean, Fly.io, GCP, Netlify. All pass `terraform validate`. Provider schemas verified against registry docs (Cloudflare v5, Fly v0.0.23, Netlify v0.4).
- **IaC strategy decision** — Default to TFC Free/Essentials now. OpenTofu + encrypted S3 backend planned as "coming soon" alternative. HCL is identical between the two; only the backend block changes.
- **Market research** — Collected 2025-2026 billing shock testimonials (Vercel $96k functions, Firebase $70k/day, GCP $85k surprise) and migration pain points for marketing. Key stat: apps with 100k+ MAU average $400/mo on Vercel vs $80/mo self-hosted.

### Decisions
- **OpenTofu not yet, but soon**: Support HashiCorp products (TFC) for now. OpenTofu + S3 as future option avoids BSL license concerns and aligns with "you own everything" positioning.
- **Marketing angle**: Target small startups on PaaS platforms before they hit the billing inflection (~1TB egress, ~10k MAU). Message: "plan your exit before you need one."
- **Render/Railway**: No Terraform providers exist. Dashboard-only setup for testing. Not a blocker for connector testing.

## 2026-08-25

### Completed
- **7 source connectors (PR #14)** — Netlify (REST), Render (REST), Railway (GraphQL), Fly.io (GraphQL + Machines API), DigitalOcean (REST v2), GCP (service account JWT), Azure (service principal client credentials). Each implements verify() + assess() with read-only API calls, producing inventory items, findings, and cost estimates.
- **Vitest test suite (PR #15)** — 37 tests covering verify() and assess() for all 13 connectors. Mocks global fetch to validate output without hitting real APIs. All passing.
- **Terraform test fixtures (PR #16)** — Minimal free-tier configs for AWS, Azure, Cloudflare, DigitalOcean, Fly.io, GCP, and Netlify. Each provisions the smallest resources for integration testing. All validated with `terraform validate`.
- Updated shared PROVIDERS type (5 to 12 source providers) and dashboard connection UI (scope help text, JSON credential inputs for GCP/Azure).
