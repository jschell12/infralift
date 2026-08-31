# infralift marketing site

Static Next.js export (`output: "export"`) served by a Cloudflare Worker that
also handles the analytics beacon at `POST /a/e`. Docs pages are generated at
build time from the markdown in the repo-root `docs/` directory, so this app
must be built from a full checkout.

## Deploying

Merging to `main` deploys this site through the `deploy-web` job in
`.github/workflows/ci.yml`. Nothing manual is required.

That job is gated on the `WEB_DEPLOY_ENABLED` repository variable so it stays
dormant until the Cloudflare credentials exist. To turn it on:

1. Mint a Cloudflare API token scoped to this account with **Workers Scripts:
   Edit**, **Workers Analytics Engine: Write** (the Worker binds the
   `marketing_analytics` dataset), **Account Settings: Read**, and
   **Zone: Read** plus **Workers Routes: Edit** on `infralift.dev` for the two
   custom domains.
2. Set the repository secrets `CLOUDFLARE_API_TOKEN` and
   `CLOUDFLARE_ACCOUNT_ID`.
3. Set the repository variable `WEB_DEPLOY_ENABLED` to `true`.

The account-wide `CLOUDFLARE_API_TOKEN` in scredmgr is **not** usable here: it
is not account-owned and fails `/accounts/{id}/tokens/verify` with error 1000.
Mint a dedicated token rather than reusing another project's deploy token.

## Running it locally

```
pnpm dev            # localhost:3000
pnpm build          # static export into ./out
pnpm run deploy:cf  # wrangler deploy — note `pnpm deploy` is a pnpm builtin
```

`NEXT_PUBLIC_DASHBOARD_URL` overrides the dashboard link target. It defaults to
production, and CI fails the build if any `localhost:` URL reaches the export.
