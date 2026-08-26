# Migrating from Railway

## Prerequisites

- [Railway CLI](https://docs.railway.app/develop/cli) (`brew install railway`)
- `railway login` completed
- `pg_dump` and `pg_restore`

## Database export

```bash
# Link your Railway project
railway link

# Get the database connection string
railway variables --service postgres
# Look for DATABASE_URL, DATABASE_PUBLIC_URL, or PGHOST/PGPORT/PGUSER/PGPASSWORD

# Use the public URL for external access (TCP proxy)
# Format: postgresql://postgres:password@roundhouse.proxy.rlwy.net:12345/railway

pg_dump --format=custom --no-owner --no-privileges \
  --clean --if-exists \
  "$DATABASE_PUBLIC_URL" > railway-export.dump

# Alternatively, use railway run to execute pg_dump inside the project context
railway run pg_dump --format=custom --no-owner --no-privileges \
  --clean --if-exists \
  "$DATABASE_URL" > railway-export.dump
```

## Object storage sync

Railway does not provide built-in object storage. Most apps use S3, R2, or Railway Volumes.

```bash
# If using a Railway Volume, connect via railway shell and copy
railway shell
# Inside the shell: tar -czf /tmp/volume-export.tar.gz /path/to/volume

# If using S3/R2/external storage, export from that provider
rclone sync aws-s3:your-bucket ./storage-export/
```

## Environment variables

```bash
# List all variables for the current service
railway variables

# Export to a file
railway variables --json > railway-env.json

# Or use the Railway CLI to get specific vars
railway variables --service your-service-name
```

Remove Railway-specific variables (`RAILWAY_*`, `PORT`, plugin-generated URLs) before importing.

## DNS records

```bash
# List custom domains
railway domain

# Railway provides a default domain: your-app.up.railway.app
# Custom domains are shown in the Railway dashboard under Settings > Domains
```

## Import to target

```bash
# Restore database to Neon
pg_restore --no-owner --no-privileges \
  --clean --if-exists \
  --dbname="$TARGET_DATABASE_URL" railway-export.dump

# Sync object storage to R2 (Cloudflare target)
rclone sync ./storage-export/ r2:infralift-demo-storage/

# Or sync to a local volume (Hetzner target)
rsync -av ./storage-export/ /opt/app/uploads/
```
