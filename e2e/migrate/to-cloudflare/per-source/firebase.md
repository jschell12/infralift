# Migrating from Firebase

## Prerequisites

- [Firebase CLI](https://firebase.google.com/docs/cli) (`npm i -g firebase-tools`)
- [gcloud CLI](https://cloud.google.com/sdk/docs/install) (`brew install google-cloud-sdk`)
- `firebase login` and `gcloud auth login` completed
- `gsutil` (included with gcloud CLI)
- `rclone` (for object storage sync)

## Database export

Firebase uses Firestore (NoSQL) rather than Postgres. Data must be exported and transformed.

```bash
# Export all Firestore data to a GCS bucket
gcloud firestore export gs://your-backup-bucket/firestore-export \
  --project=your-project-id

# Download the export locally
gsutil -m cp -r gs://your-backup-bucket/firestore-export ./firestore-export/

# Export Firebase Realtime Database (if used)
firebase database:get / --project your-project-id > rtdb-export.json
```

For Firebase Auth users (includes password hashes):

```bash
# Export auth users with password hashes (scrypt format)
firebase auth:export users.json --format=json --project your-project-id

# The export includes scrypt hash parameters needed for re-importing
# passwords into another auth system
```

Since the target uses Postgres, you will need a transformation script to convert Firestore documents to relational rows. This is application-specific.

## Object storage sync

```bash
# List Cloud Storage buckets
gsutil ls

# Sync Firebase/Cloud Storage to local
gsutil -m rsync -r gs://your-project.appspot.com/ ./storage-export/

# Or use rclone for large transfers
rclone sync gcs:your-project.appspot.com ./storage-export/
```

## Environment variables

```bash
# Firebase config is typically embedded in client code, not env vars.
# Server-side config uses Firebase Functions config:
firebase functions:config:get --project your-project-id > firebase-config.json

# For newer Firebase projects using dotenv:
cat .env
cat .env.your-project-id
```

## DNS records

```bash
# List custom domains for Firebase Hosting
firebase hosting:sites:list --project your-project-id

# DNS records are managed via the Firebase console or your DNS provider.
# Check your DNS provider for current A/CNAME records pointing to Firebase.
```

## Import to target

```bash
# After transforming Firestore data to SQL, load into Neon
psql "$TARGET_DATABASE_URL" < transformed-data.sql

# Sync object storage to R2 (Cloudflare target)
rclone sync ./storage-export/ r2:infralift-demo-storage/

# Or sync to a local volume (Hetzner target)
rsync -av ./storage-export/ /opt/app/uploads/
```
