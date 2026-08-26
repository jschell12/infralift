# Migrating from Google Cloud Platform

## Prerequisites

- [gcloud CLI](https://cloud.google.com/sdk/docs/install) (`brew install google-cloud-sdk`)
- `gcloud auth login` and `gcloud config set project your-project` completed
- `pg_dump` and `pg_restore`
- `rclone` (for GCS sync)
- Cloud SQL Auth Proxy (for private instances)

## Database export

```bash
# List Cloud SQL instances
gcloud sql instances list

# Option 1: Use Cloud SQL export to GCS (no local pg_dump needed)
gcloud sql export sql your-instance gs://your-bucket/export.sql \
  --database=your-db

# Option 2: Connect via Cloud SQL Auth Proxy and pg_dump
cloud-sql-proxy your-project:us-central1:your-instance &
pg_dump --format=custom --no-owner --no-privileges \
  --clean --if-exists \
  "postgresql://username:password@127.0.0.1:5432/dbname" \
  > gcp-export.dump

# Option 3: Use gcloud sql connect (interactive, good for verification)
gcloud sql connect your-instance --user=postgres --database=your-db
```

## Object storage sync

```bash
# List GCS buckets
gsutil ls

# Sync GCS to local
gsutil -m rsync -r gs://your-bucket ./gcs-export/

# Or use rclone for cross-provider sync
rclone sync gcs:your-bucket r2:infralift-demo-storage/

# rclone direct sync (GCS to R2) is faster than downloading locally first
```

## Environment variables

```bash
# From Cloud Run
gcloud run services describe your-service --region us-central1 \
  --format='yaml(spec.template.spec.containers[0].env)'

# From App Engine
gcloud app describe --format='yaml(envVariables)'

# Or from app.yaml
cat app.yaml | grep -A 100 'env_variables:'

# From GKE (Kubernetes)
kubectl get deployment your-deployment -o jsonpath='{.spec.template.spec.containers[0].env}' | jq .
```

## DNS records

```bash
# List Cloud DNS managed zones
gcloud dns managed-zones list

# List records in a zone
gcloud dns record-sets list --zone=your-zone --format=json > dns-records.json
```

## Import to target

```bash
# Restore database to Neon
pg_restore --no-owner --no-privileges \
  --clean --if-exists \
  --dbname="$TARGET_DATABASE_URL" gcp-export.dump

# Sync GCS to R2 (Cloudflare target) via rclone
rclone sync gcs:your-bucket r2:infralift-demo-storage/

# Or sync to a local volume (Hetzner target)
rsync -av ./gcs-export/ /opt/app/uploads/
```
