# Infralift E2E Cost Analysis

## Methodology

All estimates are based on a standard application profile:

- **Compute**: Express.js (Node.js) web server, single instance, moderate CPU usage
- **Database**: PostgreSQL, 1 GB storage, moderate query load
- **Object storage**: 10 GB stored, 1,000 writes/month, 10,000 reads/month
- **Bandwidth**: 500 GB egress/month
- **Traffic**: ~50,000 visitors/month, ~200,000 requests/month

Prices reflect published rates as of mid-2026. Free tier and startup credit assumptions are called out in Notes.

## Source Platform Costs

| Platform | Compute | Database | Storage | Bandwidth | Total/mo |
|---|---|---|---|---|---|
| **Vercel** | $20 (Pro plan) | $19 (Neon Scale) | $0 (external) | $40 (100GB included, $0.15/GB after) | **$79** |
| **Heroku** | $25 (Basic dyno) | $50 (Essential-0) | $0 (external S3) | Included | **$75** |
| **Firebase** | $0 (Spark, limited) | $0.18/GB Firestore | $0.026/GB Cloud Storage | $0.12/GB | **$63** |
| **AWS** | $5 (App Runner, min) | $15 (RDS db.t4g.micro) | $0.25 (S3) | $45 (first 10TB at $0.09/GB) | **$65** |
| **GCP** | $17 (Cloud Run, min 1 instance) | $10 (Cloud SQL db-f1-micro) | $0.26 (GCS) | $60 ($0.12/GB) | **$87** |
| **Azure** | $13 (App Service B1) | $15 (Flexible Server Burstable B1ms) | $0.20 (Blob Storage) | $44 ($0.087/GB) | **$72** |
| **Render** | $7 (Starter) | $7 (Starter Postgres) | $0 (external) | Included (100GB) | **$14** |
| **Railway** | $5 (Pro base) + usage | $5 (base) + usage | $0 (external) | Included | **$20** |
| **Fly.io** | $5 (shared-cpu-1x) | $0 (Fly Postgres is free compute) | $0.15/GB (Tigris) | Included (100GB) | **$7** |
| **DigitalOcean** | $12 (App Platform Basic) | $15 (Managed DB, basic) | $5 (Spaces 250GB) | Included (1TB) | **$32** |
| **Netlify** | $19 (Pro plan) | $0 (external) | $0 (external) | $20 (100GB included, $55/100GB after) | **$39** |
| **Cloudflare** | $5 (Workers Paid) | $19 (Neon Scale) | $0.015/GB (R2) | $0 (R2 egress free) | **$24** |

## Target Platform Costs

### Cloudflare Workers + R2 + Neon

| Component | Service | Monthly Cost |
|---|---|---|
| Compute | Workers Paid plan | $5 |
| Database | Neon Free tier (0.5 GiB, 190 compute hrs) | $0 |
| Object storage | R2 (10 GB stored) | $0.15 |
| Bandwidth | R2 egress (free), Workers response | $0 |
| **Total** | | **$5.15** |

With Neon Scale (for production workloads): **$24.15/mo**

### Hetzner Cloud + Docker + Neon

| Component | Service | Monthly Cost |
|---|---|---|
| Compute | cx22 (2 vCPU, 4 GB RAM) | $4.50 (EUR 3.99) |
| Database | Neon Free tier | $0 |
| Object storage | Local disk (included with VM) | $0 |
| Bandwidth | 20 TB included | $0 |
| TLS | Caddy + Let's Encrypt | $0 |
| **Total** | | **$4.50** |

With Neon Scale (for production workloads): **$23.50/mo**

## Savings Matrix

Savings when migrating from each source platform to each target. Percentages are based on source total vs. target total using Neon Free tier.

| Source Platform | Source $/mo | To Cloudflare $/mo | Savings $ | Savings % | To Hetzner $/mo | Savings $ | Savings % |
|---|---|---|---|---|---|---|---|
| **Vercel** | $79 | $5.15 | $73.85 | 93% | $4.50 | $74.50 | 94% |
| **Heroku** | $75 | $5.15 | $69.85 | 93% | $4.50 | $70.50 | 94% |
| **Firebase** | $63 | $5.15 | $57.85 | 92% | $4.50 | $58.50 | 93% |
| **AWS** | $65 | $5.15 | $59.85 | 92% | $4.50 | $60.50 | 93% |
| **GCP** | $87 | $5.15 | $81.85 | 94% | $4.50 | $82.50 | 95% |
| **Azure** | $72 | $5.15 | $66.85 | 93% | $4.50 | $67.50 | 94% |
| **Render** | $14 | $5.15 | $8.85 | 63% | $4.50 | $9.50 | 68% |
| **Railway** | $20 | $5.15 | $14.85 | 74% | $4.50 | $15.50 | 78% |
| **Fly.io** | $7 | $5.15 | $1.85 | 26% | $4.50 | $2.50 | 36% |
| **DigitalOcean** | $32 | $5.15 | $26.85 | 84% | $4.50 | $27.50 | 86% |
| **Netlify** | $39 | $5.15 | $33.85 | 87% | $4.50 | $34.50 | 88% |
| **Cloudflare** | $24 | $5.15 | $18.85 | 79% | $4.50 | $19.50 | 81% |

Average savings: **~$45/mo (82%)** to Cloudflare, **~$46/mo (84%)** to Hetzner.

## Notes

**Free tiers and credits**
- AWS, GCP, and Azure offer 12-month free tiers for new accounts that significantly reduce first-year costs. The estimates above assume post-free-tier pricing.
- Neon Free tier provides 0.5 GiB storage and 190 compute hours/month, sufficient for most demo and light-production workloads. Neon Scale ($19/mo) is recommended for production.
- Cloudflare Workers Free tier (100k requests/day) may be sufficient for low-traffic apps, reducing the Workers cost to $0.
- Render and Railway offer generous hobby tiers. Their paid plans start lower than hyperscalers but scale up with usage.

**Startup credits**
- AWS Activate: up to $100k in credits for startups
- GCP for Startups: up to $100k in credits
- Azure for Startups: up to $150k in credits
- These credits can make hyperscaler costs effectively $0 for 1-2 years but create vendor lock-in and a cost cliff when credits expire.

**Pricing volatility**
- Cloud provider pricing changes frequently. Verify current rates before making migration decisions.
- Bandwidth pricing varies the most between providers. Cloudflare's zero-egress-cost model for R2 and Hetzner's 20TB included bandwidth are significant differentiators at scale.
- Database pricing depends heavily on workload: IOPS, connections, storage, and compute hours.

**What the estimates do not include**
- CI/CD costs (GitHub Actions, etc.)
- Monitoring and logging (Datadog, Sentry, etc.)
- Domain registration and email
- Developer time for the migration itself
- Multi-region replication or high-availability configurations
