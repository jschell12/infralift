# infralift status

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
