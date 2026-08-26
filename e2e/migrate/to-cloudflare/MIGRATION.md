# Migration Runbook: Cloudflare Workers + R2 + Neon

This runbook covers the full migration lifecycle from any source platform to the Cloudflare Workers + R2 + Neon Postgres stack.

## Pre-migration checklist

- [ ] Source platform export completed (see `per-source/` for your platform)
- [ ] Database dump file verified (`pg_restore --list export.dump` shows expected tables)
- [ ] Object storage export verified (file counts and sizes match source)
- [ ] Environment variables documented (sensitive values stored securely)
- [ ] Terraform variables configured (`terraform.tfvars` or env vars)
- [ ] Cloudflare API token created with Workers, R2, and DNS permissions
- [ ] Neon API key generated from console.neon.tech
- [ ] DNS TTL lowered to 60s at least 48 hours before cutover
- [ ] Monitoring and alerting set up for the new deployment
- [ ] Rollback plan reviewed with the team

## Step 1: Provision infrastructure

```bash
cd e2e/migrate/to-cloudflare

# Set required variables
export TF_VAR_cloudflare_account_id="your-account-id"
export TF_VAR_cloudflare_zone_id="your-zone-id"
export TF_VAR_domain="example.com"
export TF_VAR_neon_api_key="your-neon-api-key"

# Initialize and apply
terraform init
terraform plan -out=plan.tfplan
terraform apply plan.tfplan
```

## Step 2: Import database

```bash
# Get the Neon connection string from Terraform output
NEON_URL=$(terraform output -raw neon_database_url)

# Restore the database dump
pg_restore --no-owner --no-privileges \
  --clean --if-exists \
  --dbname="$NEON_URL" your-export.dump

# Verify row counts
psql "$NEON_URL" -c "SELECT schemaname, relname, n_live_tup
  FROM pg_stat_user_tables ORDER BY n_live_tup DESC;"
```

## Step 3: Sync object storage

```bash
# Configure rclone for R2
# [r2]
# type = s3
# provider = Cloudflare
# access_key_id = <R2 access key>
# secret_access_key = <R2 secret key>
# endpoint = https://<account_id>.r2.cloudflarestorage.com

rclone sync ./storage-export/ r2:infralift-demo-storage/

# Verify file count
rclone size r2:infralift-demo-storage/
```

## Step 4: Deploy the Worker

The Worker is deployed by Terraform. Verify it is running:

```bash
WORKER_URL=$(terraform output -raw worker_url)
curl -s "$WORKER_URL/health" | jq .
# Expected: {"healthy": true}

curl -s "$WORKER_URL/api/status" | jq .
# Expected: {"status": "ok", "provider": "cloudflare", ...}
```

## Step 5: DNS cutover

```bash
# 1. Verify the new deployment works at the Workers URL
curl -s "https://infralift-demo.example.com/api/status"

# 2. The Terraform config already created a CNAME record.
#    If you need to update an existing record instead:
#    - Update the DNS record to point to the Workers route
#    - Old: CNAME to source-platform-domain
#    - New: CNAME to infralift-demo.example.com.workers.dev (proxied)

# 3. Monitor DNS propagation
dig +short infralift-demo.example.com

# 4. Verify traffic is flowing to the new deployment
curl -v "https://infralift-demo.example.com/" 2>&1 | grep -i "cf-ray"
# The cf-ray header confirms traffic is going through Cloudflare
```

## Step 6: Post-migration verification

- [ ] Homepage loads correctly with all data
- [ ] API endpoints return expected responses
- [ ] File uploads work (object storage connectivity)
- [ ] Database queries return correct data
- [ ] SSL certificate is valid and auto-renewing
- [ ] Custom domain resolves correctly
- [ ] Error rates are within acceptable thresholds
- [ ] Response times are comparable to or better than the source

## Rollback plan

If issues are found after cutover:

1. **Immediate (DNS)**: Revert the DNS record to point back to the source platform. If TTL was lowered to 60s, propagation takes 1-2 minutes.

2. **Data sync**: If writes occurred on the new platform, export them and import back to the source database.

3. **Terraform destroy** (only after confirming rollback is stable):
   ```bash
   terraform destroy
   ```

## Cleanup

After the migration is verified and stable (recommended: wait 7 days):

1. Raise DNS TTL back to normal (3600s or higher)
2. Decommission the source platform deployment
3. Cancel source platform subscriptions
4. Remove source platform CLI tools and credentials
5. Archive the database dump and storage export files
