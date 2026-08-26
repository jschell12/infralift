# Migrating from Vercel

## Prerequisites

- [Vercel CLI](https://vercel.com/docs/cli) (`npm i -g vercel`)
- `vercel login` completed
- `psql` and `pg_dump` (if using external Postgres like Neon)
- `rclone` (if migrating blob storage)

## Database export

Vercel does not include a managed Postgres database. If your app uses Neon, Supabase, or another external provider, export from that provider directly.

For Neon (the most common pairing):

```bash
pg_dump --format=custom --no-owner --no-privileges \
  --clean --if-exists \
  "$SOURCE_DATABASE_URL" > vercel-export.dump
```

If using Vercel Postgres (powered by Neon under the hood):

```bash
# Get the connection string from the Vercel dashboard or CLI
vercel env pull .env.local
source .env.local
pg_dump --format=custom --no-owner --no-privileges \
  --clean --if-exists \
  "$POSTGRES_URL" > vercel-export.dump
```

## Object storage sync

Vercel Blob Storage uses an S3-compatible API:

```bash
# List blobs via the Vercel CLI
vercel blob ls

# If using rclone, configure a remote for the blob store
# and sync to the target
rclone sync vercel-blob:my-bucket ./local-export/
```

If your app uses an external object store (R2, S3), export from that provider instead.

## Environment variables

```bash
# List all env vars for the project
vercel env ls

# Pull env vars to a local file
vercel env pull .env.export

# For a specific environment (production, preview, development)
vercel env pull .env.production --environment production
```

Review and remove Vercel-specific variables (`VERCEL_*`, `NEXT_PUBLIC_VERCEL_*`) before importing.

## DNS records

```bash
# List domains linked to the project
vercel domains ls

# List DNS records for a domain
vercel dns ls example.com
```

Save the output. You will need to recreate these records at the target provider.

## Import to target

```bash
# Restore database to Neon
pg_restore --no-owner --no-privileges \
  --clean --if-exists \
  --dbname="$TARGET_DATABASE_URL" vercel-export.dump

# Sync object storage to R2 (Cloudflare target)
rclone sync ./local-export/ r2:infralift-demo-storage/

# Or sync to a local volume (Hetzner target)
rsync -av ./local-export/ /opt/app/uploads/
```
