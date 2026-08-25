# Security model

## Least privilege by construction

Every credential we ask for is read-only at the provider level:

| Provider | Credential | Why it can't write |
|---|---|---|
| Vercel | Viewer-role token | Token inherits the Viewer role's permissions |
| Cloudflare | Custom API token | Only `· Read` permissions granted |
| Heroku | API key / scoped authorization | We only call read endpoints; you can scope the authorization |
| AWS | Cross-account IAM role | AWS-managed `ReadOnlyAccess` policy; trust policy restricted to our account **with an external ID** |
| Firebase / GCP | Service account JSON key | `Viewer` (or granular `*Viewer`) roles carry no write permissions |

If you accidentally paste an over-privileged credential, replacing it with a correctly scoped one takes a minute, and we'd rather you do that than proceed.

## Credential handling

- **Encrypted at rest** with AES-256-GCM. Ciphertext, IV, and auth tag are stored; the encryption key lives only in the API server's environment, never in the database or repo.
- **Never displayed again.** After you submit a credential, the dashboard shows only provider, label, and verification status.
- **Never used to modify anything.** The connector code paths only perform reads. Environment variable *values* are never fetched, only names.

## Migration-time writes

Migrations don't change this model. Write actions on your *current* provider (DNS cutover, data export) are executed by you, or by short-lived scoped credentials you create for the cutover window and revoke afterward. The *target* environment is built via Terraform Cloud under your organization, with plan/apply gates you control.

## Revocation

Delete the token, key, role, or service account in your provider's console at any time. Access ends immediately, no coordination with us required.

## Disclosure

Found a security issue? Email security@infralift.dev. We appreciate reports and respond quickly.
