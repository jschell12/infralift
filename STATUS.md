# infralift status

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
