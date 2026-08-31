# Security model

## Least privilege by construction

Every credential we ask for **on the provider you are migrating away from** is read-only:

| Provider | Credential | Why it can't write |
|---|---|---|
| Vercel | Viewer-role token | Token inherits the Viewer role's permissions |
| Cloudflare | Custom API token | Only `· Read` permissions granted |
| Heroku | API key / scoped authorization | We only call read endpoints; you can scope the authorization |
| AWS | Cross-account IAM role | AWS-managed `ReadOnlyAccess` policy; trust policy restricted to our account **with an external ID** |
| Firebase / GCP | Service account JSON key | `Viewer` (or granular `*Viewer`) roles carry no write permissions |
| Netlify, Render, Railway, Fly.io, DigitalOcean, Azure | Provider API token or service principal | We only call read endpoints |

If you accidentally paste an over-privileged credential, replacing it with a correctly scoped one takes a minute, and we'd rather you do that than proceed.

## The one credential that writes: GitHub

Delivering Terraform means committing it somewhere, so the GitHub connection is deliberately not read-only. It is the only one.

| What it is | A fine-grained personal access token with **Contents: Read and write** |
|---|---|
| What it writes | Generated `.tf` files, into the repository you nominate, on the branch you nominate |
| What it never touches | Your current provider. The GitHub token has no access to it, and the provider credential has no write permission |
| Scope you control | Point it at a single repository. If you would rather we not create the repo, create it yourself and scope the token to it |

We call this out rather than filing it under "read-only" because it is a real exception, and you should know which credential can change something before you grant it.

## Credential handling

- **Encrypted at rest** with AES-256-GCM. Ciphertext, IV, and auth tag are stored; the encryption key lives only in the API server's environment, never in the database or repo.
- **Never displayed again.** After you submit a credential, the dashboard shows only provider, label, and verification status.
- **Never used to modify anything, with the single documented exception above.** Connector code paths for source providers only perform reads. Environment variable *values* are never fetched, only names.

## Migration-time writes

Migrations don't change this model. Write actions on your *current* provider (DNS cutover, data export) are executed by you, or by short-lived scoped credentials you create for the cutover window and revoke afterward. The *target* environment is built via Terraform Cloud under your organization, with plan/apply gates you control.

## Revocation

Delete the token, key, role, or service account in your provider's console at any time. Access ends immediately, no coordination with us required.

## Disclosure

Found a security issue? Email security@infralift.dev. We appreciate reports and respond quickly.
