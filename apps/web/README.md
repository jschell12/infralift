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

## The three ways in

The hero CTA is the estimator, because it asks for nothing. Under it sits the
signup, and under that the lead form. They are ordered by how much a visitor
has to give up before they see a number.

The primary conversion CTA is a signup. "Start your free assessment" links to
`dashboard.infralift.dev`, which sits behind a Cloudflare Access application
that allows any Google or GitHub sign-in. The API's `cfAuth` middleware reads
the email claim off the Access JWT and provisions a `User` and a fresh `Org` on
first request, so a stranger who clicks the button ends up in their own tenant
with nothing to configure here.

The IdP list is pinned to Google and GitHub in the `schellout` repo
(`terraform/tunnel.tf`, PR #284). It is pinned rather than left at the default
because an Access app with no `allowed_idps` offers every IdP in the account,
including Cloudflare's one-time email PIN, which is not a gate worth putting
self-serve signup behind. Changing which providers appear on that login page is
a terraform change over there, not a change here.

This is why the sign-in CTA is unconditional now. It used to be the `else`
branch of `LEAD_FORM_ENABLED`, back when the Access policy allowed exactly one
email address and the button was a login wall.

## The estimator

`/estimate` is the only page a stranger can get a costed answer out of without
an account, a provider token, or an email address. `app/estimate/calculator.tsx`
posts eleven form fields to `/a/estimate` on the Worker, which forwards to the
API's public `/intake/estimate` route, and renders what comes back. Nothing is
written down: the route is a pure function, so there is no row and no lead.

Two things about it are load-bearing and should survive edits.

**It owns no pricing.** The route builds a `WorkloadFootprint` and calls
`planTarget`/`sizeTarget` in `apps/api/src/lib/sizing.ts`, the same functions
behind the options page and the generated Terraform. A copy of the price list
in this app would drift inside a release, and the assessment a visitor runs
afterwards would then contradict the first number they ever saw. There is a
test asserting the estimator reports exactly what `sizeTarget` reports.

**It subtracts the operations work, and it can tell someone not to move.** A
managed platform's bill includes somebody patching the kernel and a VPS bill
does not, so `opsBurden` prices the net-new hours and takes them off the
saving. When nothing clears that bar the response carries `bestSlug: null` and
the page says so. Workers is also gated on whether the stack could run on it at
all: it is still priced, so the reader can see what they are giving up, but a
Rails app is never recommended onto it.

### Turning it on

Same Worker secrets as the lead form below (`LEAD_INTAKE_URL` and the two
`LEAD_INTAKE_CF_*` halves), and there is no build flag: the page ships either
way and answers 503 until the secrets exist.

It does need **its own Cloudflare Access application** in `schellout`. The
lead-intake app is scoped to `api.infralift.dev/intake/lead` exactly, so it does
not cover `/intake/estimate`; without a second app the path gets an Access login
redirect and the Worker reports "not reachable". The same service token can be
named in both policies.

## The lead form

`app/assessment-form.tsx` is the only client component on this site, and it is
now the secondary path: for visitors who want a number before they hand over a
provider token. It posts to `/a/lead` on the Worker, which forwards to the
API's public `/intake/lead` route. Posting to the Worker rather than straight to
the API keeps it same-origin: no CORS preflight, and no need to add a public
origin to a CORS allowlist that every authenticated route also reads.

It renders under the sign-in CTA only when `NEXT_PUBLIC_LEAD_FORM_ENABLED=true`
at build time. Until then the page shows the sign-in path alone, which is a
working funnel on its own, rather than a submit button that 503s.

### Turning it on

1. Build with `NEXT_PUBLIC_LEAD_FORM_ENABLED=true` (add it to the `deploy-web`
   job's env in `.github/workflows/ci.yml`).
2. Set `LEAD_INTAKE_URL` as a Worker secret, pointing at the API, e.g.
   `npx wrangler secret put LEAD_INTAKE_URL`. Without it `/a/lead` answers 503.
3. Set `LEAD_INTAKE_CF_CLIENT_ID` and `LEAD_INTAKE_CF_CLIENT_SECRET` as Worker
   secrets. `POST /intake/lead` is registered above `cfAuth` in
   `apps/api/src/server.ts`, but `api.infralift.dev` also sits behind Cloudflare
   Access, which returns a login redirect before Express is reached. The path
   has its own Access application whose only policy is `non_identity` against a
   service token, so the Worker can reach it and a browser cannot. Both halves
   of the token are in the `schellout` HCP Terraform workspace outputs
   (`infralift_intake_service_token_client_id` / `_client_secret`). The Worker
   sends the headers when both are present and neither when either is missing.

Step 3 is already applied on the Cloudflare side; the secrets just have to be
put on the Worker.
