# Infralift E2E Demo

End-to-end demonstration of the infralift migration platform. Deploys a reference application across multiple cloud providers, runs infralift assessments against each deployment, and provides Terraform templates for migrating to cost-effective targets.

## Directory Structure

```
e2e/
  reference-app/        # Express.js app with Postgres + S3-compatible storage
  deploy/               # Per-platform deployment configs (source platforms)
    aws/                # App Runner + RDS + S3 (Terraform)
    vercel/             # Vercel serverless (CLI deploy)
    heroku/             # Heroku dyno (Procfile + CLI)
    ...
  migrate/              # Migration target templates
    to-cloudflare/      # Workers + R2 + Neon (Terraform)
      per-source/       # Export guides for each source platform
      MIGRATION.md      # Full migration runbook
    to-hetzner/         # Docker + Caddy + Neon on Hetzner VM (Terraform)
      per-source/       # Export guides for each source platform
      MIGRATION.md      # Full migration runbook
  scripts/              # Orchestration scripts
    deploy-all.sh       # Deploy to multiple platforms
    teardown-all.sh     # Tear down deployments
    run-assessments.sh  # Run infralift assessments
    validate-all-tf.sh  # Validate all Terraform configs
  cost-analysis.md      # Detailed cost comparison across all platforms
  .outputs/             # (gitignored) Deployment outputs and secrets
  .results/             # (gitignored) Assessment results
```

## Prerequisites

- [Terraform](https://developer.hashicorp.com/terraform/install) >= 1.5
- [Node.js](https://nodejs.org/) >= 18
- Platform-specific CLIs (AWS CLI, Vercel CLI, Heroku CLI, etc.)
- Platform API credentials set as environment variables

## Quick Start

### 1. Deploy the reference app

Deploy to one or more source platforms:

```bash
# Deploy to all configured platforms
bash e2e/scripts/deploy-all.sh

# Deploy to specific platforms
bash e2e/scripts/deploy-all.sh --platforms aws,vercel

# Dry run (see what would be deployed)
bash e2e/scripts/deploy-all.sh --dry-run
```

### 2. Run assessments

After deploying, run infralift assessments against each platform:

```bash
bash e2e/scripts/run-assessments.sh

# Or target specific platforms
bash e2e/scripts/run-assessments.sh --platforms aws,vercel
```

Assessment results are saved to `e2e/.results/`.

### 3. Migrate to a target

Choose a target (Cloudflare or Hetzner), follow the per-source export guide, then apply the Terraform template:

```bash
# Example: migrate from AWS to Cloudflare
# 1. Export from AWS (follow e2e/migrate/to-cloudflare/per-source/aws.md)
# 2. Apply the Cloudflare target
cd e2e/migrate/to-cloudflare
terraform init
terraform apply
# 3. Follow MIGRATION.md for database import, DNS cutover, etc.
```

### 4. Tear down

```bash
bash e2e/scripts/teardown-all.sh
bash e2e/scripts/teardown-all.sh --platforms aws,vercel
```

## Validate Terraform

Check all Terraform configurations for syntax and provider errors:

```bash
bash e2e/scripts/validate-all-tf.sh
```

## Cost Analysis

See [cost-analysis.md](cost-analysis.md) for a detailed comparison of all 12 source platforms against both migration targets, with dollar and percentage savings for each path.

## Reference App

The reference app (`reference-app/`) is a minimal Express.js application with:

- PostgreSQL database (via `pg` driver)
- S3-compatible object storage (via AWS SDK)
- HTML homepage rendering items from the database
- JSON API endpoint (`/api/status`)
- File upload endpoint (`/upload`)
- Health check (`/health`)

It is designed to exercise the three core infrastructure components (compute, database, object storage) that infralift assesses.
