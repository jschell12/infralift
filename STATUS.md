# infralift status

## 2026-08-25 (session 2)

### Completed
- **Terraform test fixtures (PR #16)** — Validated configs for AWS, Azure, Cloudflare, DigitalOcean, Fly.io, GCP, Netlify. All pass `terraform validate`. Provider schemas verified against registry docs (Cloudflare v5, Fly v0.0.23, Netlify v0.4).
- **IaC strategy decision** — Default to TFC Free/Essentials now. OpenTofu + encrypted S3 backend planned as "coming soon" alternative. HCL is identical between the two; only the backend block changes.
- **Market research** — Collected 2025-2026 billing shock testimonials (Vercel $96k functions, Firebase $70k/day, GCP $85k surprise) and migration pain points for marketing. Key stat: apps with 100k+ MAU average $400/mo on Vercel vs $80/mo self-hosted.

### Decisions
- **OpenTofu not yet, but soon**: Support HashiCorp products (TFC) for now. OpenTofu + S3 as future option avoids BSL license concerns and aligns with "you own everything" positioning.
- **Marketing angle**: Target small startups on PaaS platforms before they hit the billing inflection (~1TB egress, ~10k MAU). Message: "plan your exit before you need one."
- **Render/Railway**: No Terraform providers exist. Dashboard-only setup for testing. Not a blocker for connector testing.

### Next steps
- Create provider accounts and run real integration tests with TF fixtures
- Write startup-focused marketing copy for infralift.dev (billing shock data, "scale smart" messaging)
- Implement OpenTofu + S3 backend option in TF pipeline (backend block toggle)
- Add Terraform templates for Hetzner VPS Docker Compose target pattern
- Consider Linode connector; seed missing discount programs (Railway, Fly.io)

## 2026-08-25

### Completed
- **7 source connectors (PR #14)** — Netlify (REST), Render (REST), Railway (GraphQL), Fly.io (GraphQL + Machines API), DigitalOcean (REST v2), GCP (service account JWT), Azure (service principal client credentials). Each implements verify() + assess() with read-only API calls, producing inventory items, findings, and cost estimates.
- **Vitest test suite (PR #15)** — 37 tests covering verify() and assess() for all 13 connectors. Mocks global fetch to validate output without hitting real APIs. All passing.
- **Terraform test fixtures (PR #16)** — Minimal free-tier configs for AWS, Azure, Cloudflare, DigitalOcean, Fly.io, GCP, and Netlify. Each provisions the smallest resources for integration testing. All validated with `terraform validate`.
- Updated shared PROVIDERS type (5 to 12 source providers) and dashboard connection UI (scope help text, JSON credential inputs for GCP/Azure).
