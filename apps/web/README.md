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

## The lead form

`app/assessment-form.tsx` is the only client component on this site. It posts
to `/a/lead` on the Worker, which forwards to the API's public `/intake/lead`
route. Posting to the Worker rather than straight to the API keeps it
same-origin: no CORS preflight, and no need to add a public origin to a CORS
allowlist that every authenticated route also reads.

It renders only when `NEXT_PUBLIC_LEAD_FORM_ENABLED=true` at build time.
Until then the CTA keeps linking to the dashboard, which is a Cloudflare Access
login wall for anyone without an account, but at least it does not silently
drop submissions.

### Turning it on

Three things have to be true, and the third is not in this repo:

1. Build with `NEXT_PUBLIC_LEAD_FORM_ENABLED=true` (add it to the `deploy-web`
   job's env in `.github/workflows/ci.yml`).
2. Set `LEAD_INTAKE_URL` as a Worker secret, pointing at the API, e.g.
   `npx wrangler secret put LEAD_INTAKE_URL`. Without it `/a/lead` answers 503.
3. Make `POST /intake/lead` reachable from the public internet. The route is
   already registered above `cfAuth` in `apps/api/src/server.ts`, but
   `api.infralift.dev` also sits behind a Cloudflare Access application, which
   returns a login redirect before Express is reached. Either:
   - add an Access **bypass** policy for the `/intake/lead` path (configured in
     the `schellout` repo, not here), or
   - create an Access **service token** and set `LEAD_INTAKE_CF_CLIENT_ID` and
     `LEAD_INTAKE_CF_CLIENT_SECRET` as Worker secrets. The Worker already sends
     those headers when both are present.

The service-token route is the tighter of the two: the path stays closed to the
public internet and only the Worker can reach it.
