# Migrating from Netlify

## Prerequisites

- [Netlify CLI](https://docs.netlify.com/cli/get-started/) (`npm i -g netlify-cli`)
- `netlify login` completed
- `curl` and `jq` (for API calls)
- Netlify personal access token (from User Settings > Applications)

## Database export

Netlify does not provide a managed database. If your app uses an external database (Supabase, Neon, PlanetScale, etc.), export from that provider directly.

```bash
# If using Supabase (common pairing)
pg_dump --format=custom --no-owner --no-privileges \
  --clean --if-exists \
  "$DATABASE_URL" > netlify-db-export.dump

# Check Netlify environment variables for DATABASE_URL
netlify env:list | grep DATABASE
```

## Object storage sync

Netlify does not provide general-purpose object storage. Static assets are part of the deploy, and Netlify Blobs is a key-value store.

```bash
# Export Netlify Blobs (if used)
# Blobs are accessed via the Netlify SDK or API; there is no CLI export command.
# Use the Netlify Blobs API to list and download:
NETLIFY_TOKEN="your-token"
SITE_ID="your-site-id"

curl -s -H "Authorization: Bearer $NETLIFY_TOKEN" \
  "https://api.netlify.com/api/v1/blobs/$SITE_ID/deploy:production" \
  | jq '.blobs[].key'

# For static assets, they are in your git repo (no migration needed)
```

## Environment variables

```bash
# List all env vars
netlify env:list

# Export via API for a complete dump
NETLIFY_TOKEN="your-token"
SITE_ID="your-site-id"

curl -s -H "Authorization: Bearer $NETLIFY_TOKEN" \
  "https://api.netlify.com/api/v1/sites/$SITE_ID" \
  | jq '.build_settings.env' > netlify-env.json

# Or use the CLI
netlify env:list --json > netlify-env.json
```

Remove Netlify-specific variables (`NETLIFY_*`, `URL`, `DEPLOY_URL`, `CONTEXT`) before importing.

## DNS records

```bash
# List DNS zones
curl -s -H "Authorization: Bearer $NETLIFY_TOKEN" \
  "https://api.netlify.com/api/v1/dns_zones" \
  | jq '.[] | {id: .id, name: .name}'

# List records in a zone
curl -s -H "Authorization: Bearer $NETLIFY_TOKEN" \
  "https://api.netlify.com/api/v1/dns_zones/ZONE_ID/dns_records" \
  | jq '.[] | {type: .type, hostname: .hostname, value: .value, ttl: .ttl}' \
  > dns-records.json

# Export form submissions (if using Netlify Forms)
curl -s -H "Authorization: Bearer $NETLIFY_TOKEN" \
  "https://api.netlify.com/api/v1/sites/$SITE_ID/forms" \
  | jq '.[] | {id: .id, name: .name, submission_count: .submission_count}'

# Download submissions for each form
FORM_ID="your-form-id"
curl -s -H "Authorization: Bearer $NETLIFY_TOKEN" \
  "https://api.netlify.com/api/v1/forms/$FORM_ID/submissions" \
  > form-submissions.json
```

## Import to target

```bash
# Restore database to Neon (if applicable)
pg_restore --no-owner --no-privileges \
  --clean --if-exists \
  --dbname="$TARGET_DATABASE_URL" netlify-db-export.dump

# Static assets are deployed from your git repo to the target platform.
# No object storage migration is typically needed for Netlify sites.

# If Blobs data was exported, upload to R2 (Cloudflare target)
rclone sync ./blobs-export/ r2:infralift-demo-storage/
```
