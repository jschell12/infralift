# Migrating from Fly.io

## Prerequisites

- [flyctl CLI](https://fly.io/docs/flyctl/install/) (`brew install flyctl`)
- `fly auth login` completed
- `pg_dump` and `pg_restore`

## Database export

```bash
# List Fly Postgres clusters
fly postgres list

# Get connection details
fly postgres config show -a your-pg-app

# Option 1: Proxy the database locally and dump
fly proxy 15432:5432 -a your-pg-app &
pg_dump --format=custom --no-owner --no-privileges \
  --clean --if-exists \
  "postgresql://postgres:password@localhost:15432/your-db" \
  > flyio-export.dump
kill %1  # stop the proxy

# Option 2: Connect to the Fly Postgres app directly
fly ssh console -a your-pg-app -C "pg_dump --format=custom --no-owner \
  --no-privileges --clean --if-exists your-db" > flyio-export.dump
```

## Object storage sync

Fly.io uses Volumes (persistent block storage) and Tigris (S3-compatible object storage).

```bash
# List volumes
fly volumes list -a your-app

# Export volume data via SSH
fly ssh console -a your-app -C "tar -czf /tmp/data.tar.gz /data"
fly ssh sftp get /tmp/data.tar.gz ./volume-export.tar.gz -a your-app

# If using Tigris object storage
# Configure rclone with Tigris S3-compatible credentials
rclone sync tigris:your-bucket ./storage-export/

# Get Tigris credentials from Fly secrets
fly secrets list -a your-app | grep TIGRIS
```

## Environment variables

```bash
# List all secrets (names only, values are hidden)
fly secrets list -a your-app

# To get actual values, check your fly.toml for [env] section
cat fly.toml

# Export non-secret env vars from fly.toml
grep -A 100 '^\[env\]' fly.toml | grep -B 100 '^\[' | head -n -1

# For secret values, you need to re-export them from your original source
# (Fly does not expose secret values after they are set)
```

## DNS records

```bash
# List certificates and custom domains
fly certs list -a your-app

# Show details for a specific certificate
fly certs show example.com -a your-app

# Fly.io provides a default domain: your-app.fly.dev
# Custom domain DNS records are managed at your DNS provider
```

## Import to target

```bash
# Restore database to Neon
pg_restore --no-owner --no-privileges \
  --clean --if-exists \
  --dbname="$TARGET_DATABASE_URL" flyio-export.dump

# Sync object storage to R2 (Cloudflare target)
rclone sync ./storage-export/ r2:infralift-demo-storage/

# Or extract volume data to local (Hetzner target)
tar -xzf volume-export.tar.gz -C /opt/app/uploads/
```
