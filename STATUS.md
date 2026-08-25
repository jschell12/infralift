# infralift status

## 2026-08-25

### Completed
- **7 source connectors (PR #14)** — Netlify (REST), Render (REST), Railway (GraphQL), Fly.io (GraphQL + Machines API), DigitalOcean (REST v2), GCP (service account JWT), Azure (service principal client credentials). Each implements verify() + assess() with read-only API calls, producing inventory items, findings, and cost estimates.
- **Vitest test suite (PR #15)** — 37 tests covering verify() and assess() for all 13 connectors. Mocks global fetch to validate output without hitting real APIs. All passing.
- **Terraform test fixtures (PR #16)** — Minimal free-tier configs for AWS, Azure, Cloudflare, DigitalOcean, Fly.io, GCP, and Netlify. Each provisions the smallest resources for integration testing. All validated with `terraform validate`.
- Updated shared PROVIDERS type (5 to 12 source providers) and dashboard connection UI (scope help text, JSON credential inputs for GCP/Azure).

### In progress
- None

### Blockers
- None

### Next steps
- Create accounts on providers without existing credentials (Azure, GCP, DigitalOcean, Fly.io, Netlify, Render, Railway)
- Run `terraform apply` per provider and test connectors against real APIs
- Add Terraform templates for new migration target patterns (e.g. Hetzner VPS Docker Compose)
- Consider Linode connector (seeded as hosting provider but no connector yet)
- Seed discount programs for providers missing them (Railway, Fly.io)
