# Migrating from DigitalOcean

## Prerequisites

- [doctl CLI](https://docs.digitalocean.com/reference/doctl/) (`brew install doctl`)
- `doctl auth init` completed
- `pg_dump` and `pg_restore`
- `rclone` (for Spaces sync)
- `s3cmd` or `aws` CLI (Spaces is S3-compatible)

## Database export

```bash
# List managed databases
doctl databases list --format ID,Name,Engine,Version

# Get connection details
doctl databases connection your-db-id --format Host,Port,User,Password,Database

# Download the CA certificate (required for managed DB connections)
doctl databases ca get your-db-id --output ca-certificate.crt

# Dump the database
pg_dump --format=custom --no-owner --no-privileges \
  --clean --if-exists \
  "postgresql://doadmin:password@your-db-host:25060/defaultdb?sslmode=require" \
  > digitalocean-export.dump
```

## Object storage sync

```bash
# List Spaces
doctl compute cdn list  # if using CDN
# Or check the dashboard for Spaces

# Spaces is S3-compatible. Configure rclone:
# Remote type: s3
# Provider: DigitalOcean Spaces
# Endpoint: nyc3.digitaloceanspaces.com (or your region)

rclone sync do-spaces:your-space ./spaces-export/

# Or use the AWS CLI with Spaces endpoint
aws s3 sync s3://your-space ./spaces-export/ \
  --endpoint-url https://nyc3.digitaloceanspaces.com
```

## Environment variables

```bash
# From App Platform - export the app spec
doctl apps list --format ID,Spec.Name
doctl apps spec get your-app-id > app-spec.yaml

# Env vars are in the spec under services[].envs[]
# Extract them:
doctl apps spec get your-app-id | grep -A 2 'key:'

# From Droplets, env vars are typically in systemd units or .env files
# SSH in and check
ssh root@your-droplet-ip 'cat /app/.env'
```

## DNS records

```bash
# List domains
doctl compute domain list

# List records for a domain
doctl compute domain records list example.com --format ID,Type,Name,Data,TTL \
  > dns-records.txt
```

## Import to target

```bash
# Restore database to Neon
pg_restore --no-owner --no-privileges \
  --clean --if-exists \
  --dbname="$TARGET_DATABASE_URL" digitalocean-export.dump

# Sync Spaces to R2 (Cloudflare target) via rclone
rclone sync do-spaces:your-space r2:infralift-demo-storage/

# Or sync to a local volume (Hetzner target)
rsync -av ./spaces-export/ /opt/app/uploads/
```
