# Migrating from Cloudflare (importing existing resources)

When migrating *to* Cloudflare from an existing Cloudflare setup, the goal is to bring unmanaged resources under Terraform control using `terraform import`.

## Prerequisites

- [Terraform](https://developer.hashicorp.com/terraform/install) >= 1.5
- Cloudflare API token with appropriate permissions
- `CLOUDFLARE_API_TOKEN` environment variable set
- The Terraform config from `e2e/migrate/to-cloudflare/` applied or ready to apply

## Database export

If your existing Cloudflare app uses an external Postgres database, export as usual:

```bash
pg_dump --format=custom --no-owner --no-privileges \
  --clean --if-exists \
  "$EXISTING_DATABASE_URL" > cloudflare-export.dump
```

If using D1 (Cloudflare's SQLite-based database):

```bash
# Export D1 database
npx wrangler d1 export your-db-name --output d1-export.sql

# D1 is SQLite, not Postgres. You will need to transform the schema
# and data for Postgres/Neon import.
```

## Object storage sync

```bash
# If R2 buckets already exist, import them into Terraform state
# rather than creating new ones.

# List existing R2 buckets
npx wrangler r2 bucket list

# Import an existing R2 bucket into Terraform
terraform import cloudflare_r2_bucket.storage <account_id>/<bucket_name>
```

## Environment variables

```bash
# List Workers secrets
npx wrangler secret list --name your-worker

# Secrets cannot be read back via the API. You need the original values
# from your deployment config or secrets manager.

# List Workers environment variables (non-secret bindings)
npx wrangler deployments list --name your-worker
# Check wrangler.toml for [vars] section
cat wrangler.toml
```

## DNS records

```bash
# List DNS records via wrangler or API
curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records" \
  | jq '.result[] | {id: .id, type: .type, name: .name, content: .content, ttl: .ttl}'
```

## Import to target (Terraform import commands)

Import existing Cloudflare resources into the Terraform state so they are managed by the migration config:

```bash
# Initialize Terraform
cd e2e/migrate/to-cloudflare
terraform init

# Import existing Workers script
terraform import cloudflare_workers_script.app <account_id>/<script_name>

# Import existing R2 bucket
terraform import cloudflare_r2_bucket.storage <account_id>/<bucket_name>

# Import existing DNS record
terraform import cloudflare_dns_record.app <zone_id>/<record_id>

# After importing, run plan to see what Terraform wants to change
terraform plan

# Resolve any drift between the imported state and your config
# before applying
```

To find resource IDs for import:

```bash
# Get account ID
curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts" \
  | jq '.result[] | {id: .id, name: .name}'

# Get zone ID
curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/zones" \
  | jq '.result[] | {id: .id, name: .name}'

# Get DNS record ID
curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records?name=infralift-demo.example.com" \
  | jq '.result[0].id'
```
