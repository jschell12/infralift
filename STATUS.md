# infralift status

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
