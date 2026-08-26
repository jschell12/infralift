# Migration Runbook: Hetzner Cloud + Docker + Caddy + Neon

This runbook covers the full migration lifecycle from any source platform to a Hetzner Cloud VM running Docker Compose with Caddy for automatic HTTPS and Neon Postgres for the database.

## Pre-migration checklist

- [ ] Source platform export completed (see `per-source/` for your platform)
- [ ] Database dump file verified (`pg_restore --list export.dump` shows expected tables)
- [ ] Object storage export verified (file counts and sizes match source)
- [ ] Environment variables documented (sensitive values stored securely)
- [ ] Terraform variables configured (`terraform.tfvars` or env vars)
- [ ] Hetzner Cloud API token created
- [ ] Neon API key generated from console.neon.tech
- [ ] SSH key pair generated for VM access
- [ ] Docker image pushed to a registry (Docker Hub, GHCR, etc.)
- [ ] Domain DNS managed by a provider you can update (for Caddy HTTPS)
- [ ] DNS TTL lowered to 60s at least 48 hours before cutover
- [ ] Rollback plan reviewed with the team

## Step 1: Provision infrastructure

```bash
cd e2e/migrate/to-hetzner

# Set required variables
export TF_VAR_hcloud_token="your-hetzner-token"
export TF_VAR_ssh_public_key="$(cat ~/.ssh/id_ed25519.pub)"
export TF_VAR_domain="app.example.com"
export TF_VAR_neon_api_key="your-neon-api-key"

# Initialize and apply
terraform init
terraform plan -out=plan.tfplan
terraform apply plan.tfplan
```

## Step 2: Point DNS to the server

Caddy needs the domain to resolve to the server IP before it can issue a Let's Encrypt certificate.

```bash
SERVER_IP=$(terraform output -raw server_ip)
echo "Point $TF_VAR_domain A record to $SERVER_IP"

# Update your DNS provider (example using Cloudflare API)
# Or do it manually in your DNS dashboard

# Verify DNS propagation
dig +short app.example.com
# Should return the server IP
```

## Step 3: Import database

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

## Step 4: Deploy the application

Cloud-init installs Docker and starts the containers automatically. If you need to update or redeploy manually:

```bash
SERVER_IP=$(terraform output -raw server_ip)

# SSH into the server
ssh root@$SERVER_IP

# Check Docker Compose status
cd /opt/app
docker compose ps
docker compose logs --tail=50

# If the app image needs to be updated
docker compose pull app
docker compose up -d

# Verify Caddy obtained the TLS certificate
docker compose logs caddy | grep "certificate obtained"
```

## Step 5: Sync object storage (if applicable)

For apps with file uploads, sync data to the server's local volume:

```bash
# From your local machine
rsync -avz ./storage-export/ root@$SERVER_IP:/opt/app/uploads/

# Or mount a Hetzner Volume for persistent storage
# (configure in shared.tf if needed)
```

## Step 6: Verify the deployment

```bash
APP_URL=$(terraform output -raw app_url)

# Health check
curl -s "$APP_URL/health" | jq .
# Expected: {"healthy": true}

# API status
curl -s "$APP_URL/api/status" | jq .
# Expected: {"status": "ok", "provider": "hetzner", ...}

# Verify HTTPS certificate
curl -vI "$APP_URL" 2>&1 | grep -E "subject:|issuer:|expire"
# Should show a Let's Encrypt certificate
```

## Step 7: DNS cutover

If the domain was previously pointing to another platform:

```bash
# Update the A record to the Hetzner server IP
# Old: CNAME/A to source-platform
# New: A record to $SERVER_IP

# Verify
dig +short app.example.com
curl -s "$APP_URL/api/status"
```

## Post-migration verification

- [ ] Homepage loads correctly with all data
- [ ] API endpoints return expected responses
- [ ] File uploads work
- [ ] Database queries return correct data
- [ ] HTTPS certificate is valid (issued by Let's Encrypt via Caddy)
- [ ] Custom domain resolves correctly
- [ ] SSH access works for maintenance
- [ ] Docker containers restart automatically after reboot

## Rollback plan

If issues are found after cutover:

1. **Immediate (DNS)**: Revert the A/CNAME record to point back to the source platform. With 60s TTL, propagation takes 1-2 minutes.

2. **Data sync**: If writes occurred on the new platform, export from Neon and import back to the source database.

3. **Terraform destroy** (only after confirming rollback is stable):
   ```bash
   terraform destroy
   ```

## Ongoing maintenance

```bash
# SSH into the server
ssh root@$(terraform output -raw server_ip)

# Update the app
cd /opt/app && docker compose pull && docker compose up -d

# View logs
docker compose logs -f app
docker compose logs -f caddy

# Restart services
docker compose restart

# System updates
apt update && apt upgrade -y
```

## Cleanup

After the migration is verified and stable (recommended: wait 7 days):

1. Raise DNS TTL back to normal (3600s or higher)
2. Decommission the source platform deployment
3. Cancel source platform subscriptions
4. Remove source platform CLI tools and credentials
5. Archive the database dump and storage export files
