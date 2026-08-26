# Migrating from Render

## Prerequisites

- [Render Dashboard](https://dashboard.render.com/) access
- `pg_dump` and `pg_restore`
- `curl` and `jq` (for API calls)
- Render API key (from Account Settings)

## Database export

```bash
# Get the external connection string from the Render dashboard
# (Database > Info > External Database URL)

# Or via the API
RENDER_API_KEY="your-render-api-key"
curl -s -H "Authorization: Bearer $RENDER_API_KEY" \
  https://api.render.com/v1/postgres \
  | jq '.[] | {id: .postgres.id, name: .postgres.name}'

# Dump the database using the external connection string
pg_dump --format=custom --no-owner --no-privileges \
  --clean --if-exists \
  "postgresql://user:password@dpg-xxx.oregon-postgres.render.com:5432/dbname" \
  > render-export.dump
```

## Object storage sync

Render does not provide built-in object storage. Most apps use S3, R2, or a mounted persistent disk.

```bash
# If using a persistent disk, SSH into the service and copy data
# (Render Shell access via dashboard)

# If using S3/R2/GCS, export from that provider directly
rclone sync aws-s3:your-render-bucket ./storage-export/
```

## Environment variables

```bash
# Via the API - list environment groups
curl -s -H "Authorization: Bearer $RENDER_API_KEY" \
  https://api.render.com/v1/env-groups \
  | jq '.[] | {id: .envGroup.id, name: .envGroup.name}'

# Get env vars for a specific env group
curl -s -H "Authorization: Bearer $RENDER_API_KEY" \
  https://api.render.com/v1/env-groups/evg-xxx \
  | jq '.envGroup.envVars'

# Get env vars for a specific service
curl -s -H "Authorization: Bearer $RENDER_API_KEY" \
  https://api.render.com/v1/services/srv-xxx/env-vars \
  | jq '.'
```

## DNS records

```bash
# List custom domains for a service via API
curl -s -H "Authorization: Bearer $RENDER_API_KEY" \
  https://api.render.com/v1/services/srv-xxx/custom-domains \
  | jq '.[] | {name: .customDomain.name}'

# DNS records are managed at your DNS provider. Check for:
# - CNAME records pointing to *.onrender.com
# - A records if using Render's DNS
```

## Import to target

```bash
# Restore database to Neon
pg_restore --no-owner --no-privileges \
  --clean --if-exists \
  --dbname="$TARGET_DATABASE_URL" render-export.dump

# Sync object storage to R2 (Cloudflare target)
rclone sync ./storage-export/ r2:infralift-demo-storage/

# Or sync to a local volume (Hetzner target)
rsync -av ./storage-export/ /opt/app/uploads/
```
