# infralift

infralift writes and maintains your infrastructure as code in your own repository, and every change arrives as a pull request you review and merge. Start from an app template, assess a cloud account you already run, or import Terraform you already have, without touching what is running.

What it sells on:

- **Import with no downtime.** Existing Terraform, or resources built by hand in a cloud console, come under infralift only after a read-only plan proves nothing would change.
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
```

`apps/api` needs a Postgres `DATABASE_URL` (see `apps/api/.env.example`). Credentials for local work come from scredmgr, never from files in the repository.

## Deploying

Merging to `main` deploys. CI runs on GitHub-hosted runners; the deploy job runs on the Framework host, builds the images there and restarts the `infralift` Nomad job. The API applies pending migrations as it starts. See [`ARCHITECTURE.md`](ARCHITECTURE.md#running-and-deploying).

## Connections

Assessments use read-only credentials. Supported providers include Vercel, Cloudflare, Heroku, AWS, Google Cloud and Firebase, Azure, DigitalOcean, Netlify, Render, Railway and Fly.io. GitHub and GitLab connections are where infralift opens pull requests; a Terraform Cloud connection is where a project's workspace lives.
