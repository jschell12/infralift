# Migrating from Azure

## Prerequisites

- [Azure CLI](https://learn.microsoft.com/en-us/cli/azure/install-azure-cli) (`brew install azure-cli`)
- `az login` completed
- `pg_dump` and `pg_restore`
- `rclone` (for Blob Storage sync)

## Database export

```bash
# List Azure Database for PostgreSQL servers
az postgres flexible-server list --output table

# Get connection details
az postgres flexible-server show --resource-group your-rg --name your-server \
  --query '{host:fullyQualifiedDomainName,admin:administratorLogin}'

# Allow your IP through the firewall (if not already allowed)
az postgres flexible-server firewall-rule create \
  --resource-group your-rg --name your-server \
  --rule-name allow-export --start-ip-address $(curl -s ifconfig.me) \
  --end-ip-address $(curl -s ifconfig.me)

# Dump the database
pg_dump --format=custom --no-owner --no-privileges \
  --clean --if-exists \
  "postgresql://admin@your-server:password@your-server.postgres.database.azure.com:5432/dbname?sslmode=require" \
  > azure-export.dump

# Remove the temporary firewall rule
az postgres flexible-server firewall-rule delete \
  --resource-group your-rg --name your-server --rule-name allow-export --yes
```

## Object storage sync

```bash
# List storage accounts
az storage account list --query '[].name' --output tsv

# List containers in a storage account
az storage container list --account-name your-account --output table

# Sync Blob Storage to local using azcopy (faster for large datasets)
azcopy copy 'https://your-account.blob.core.windows.net/your-container/*' \
  ./blob-export/ --recursive

# Or use rclone for cross-provider sync
rclone sync azure:your-container r2:infralift-demo-storage/
```

## Environment variables

```bash
# From App Service
az webapp config appsettings list \
  --resource-group your-rg --name your-app \
  --output json > azure-env.json

# From Container Apps
az containerapp show --resource-group your-rg --name your-app \
  --query 'properties.template.containers[0].env'

# From Azure Functions
az functionapp config appsettings list \
  --resource-group your-rg --name your-function \
  --output json > azure-functions-env.json
```

## DNS records

```bash
# List DNS zones
az network dns zone list --output table

# List records in a zone
az network dns record-set list --resource-group your-rg --zone-name example.com \
  --output json > dns-records.json
```

## Import to target

```bash
# Restore database to Neon
pg_restore --no-owner --no-privileges \
  --clean --if-exists \
  --dbname="$TARGET_DATABASE_URL" azure-export.dump

# Sync Blob Storage to R2 (Cloudflare target) via rclone
rclone sync azure:your-container r2:infralift-demo-storage/

# Or sync to a local volume (Hetzner target)
rsync -av ./blob-export/ /opt/app/uploads/
```
