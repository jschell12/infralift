# infralift

Fixed-fee infrastructure migrations delivered as Terraform — assess, migrate, and keep the platform.

**The offer:** connect a read-only token for your current provider (Vercel, Heroku, AWS, Cloudflare). We assess your stack, produce a migration report with cost projections, then execute a fixed-fee migration onto Cloudflare or a VPS. Every deliverable is Terraform in a repo you own, with state in Terraform Cloud. After the migration, the dashboard keeps working: IaC standards enforcement, drift visibility, and workspace management.

## Structure

| Package | Purpose |
|---|---|
| `apps/web` | Marketing site (Next.js) — offer, pricing, assessment CTA |
| `apps/dashboard` | Customer dashboard (Next.js) — token intake, assessment reports, migration status, workspaces |
| `apps/api` | Backend (Express + Prisma + Postgres) — auth, assessment engine, provider connectors |
| `packages/shared` | Shared TypeScript types |

## Development

```bash
pnpm install
pnpm db:generate
pnpm dev        # runs web (:3000), dashboard (:3001), api (:4000)
pnpm build
```

`apps/api` needs a Postgres `DATABASE_URL` (see `apps/api/.env.example`).

## Provider connectors

Assessments run against read-only credentials only:

- **Vercel** — API token (read-only scope): projects, domains, env var names, usage
- **Cloudflare** — API token: Workers, Pages, R2, DNS zones
- **Heroku** — API key: apps, dynos, add-ons
- **AWS** — `ReadOnlyAccess` IAM role: Cost Explorer + resource inventory
- **Firebase / GCP** — Viewer service account JSON key: Hosting sites, Cloud Functions, Firestore databases
