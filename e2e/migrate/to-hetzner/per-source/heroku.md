# Migrating from Heroku

## Prerequisites

- [Heroku CLI](https://devcenter.heroku.com/articles/heroku-cli) (`brew install heroku`)
- `heroku login` completed
- `pg_dump` and `pg_restore`
- `rclone` (if migrating S3-based storage)

## Database export

```bash
# Get the database URL from Heroku config
heroku config:get DATABASE_URL -a your-app-name

# Create a backup and download it
heroku pg:backups:capture -a your-app-name
heroku pg:backups:download -a your-app-name
# This produces latest.dump in the current directory

# Alternatively, dump directly via pg_dump
DATABASE_URL=$(heroku config:get DATABASE_URL -a your-app-name)
pg_dump --format=custom --no-owner --no-privileges \
  --clean --if-exists \
  "$DATABASE_URL" > heroku-export.dump
```

## Object storage sync

Heroku does not provide built-in object storage. Most apps use S3 or Cloudinary via addons.

```bash
# List addons to find storage providers
heroku addons -a your-app-name

# If using S3, configure rclone and sync
rclone sync aws-s3:my-heroku-bucket ./local-export/

# If using Cloudinary, use their CLI or API to export assets
```

## Environment variables

```bash
# List all config vars
heroku config -a your-app-name

# Export to a file
heroku config -a your-app-name --shell > heroku-env.sh

# Or in JSON format
heroku config -a your-app-name --json > heroku-env.json
```

Remove Heroku-specific variables (`HEROKU_*`, `PORT`, `DATABASE_URL`, addon-specific URLs) before importing.

## DNS records

```bash
# List custom domains
heroku domains -a your-app-name
```

Note the DNS target (e.g., `your-app.herokudns.com`) for reference during cutover.

## Import to target

```bash
# Restore database to Neon
pg_restore --no-owner --no-privileges \
  --clean --if-exists \
  --dbname="$TARGET_DATABASE_URL" heroku-export.dump

# Sync object storage to R2 (Cloudflare target)
rclone sync ./local-export/ r2:infralift-demo-storage/

# Or sync to a local volume (Hetzner target)
rsync -av ./local-export/ /opt/app/uploads/
```
