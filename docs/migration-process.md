# The migration process

Fixed fee, quoted in your assessment report. No hourly billing, no scope creep — if it takes us longer than planned, that's our problem.

## Principles

- **Read-only on your current provider, always.** We build the new environment; we never touch the old one. Cutover actions that require write access (DNS flips, data export) are executed by you or by short-lived credentials you control and revoke.
- **Everything is Terraform.** No console clicking, no snowflake servers. Every resource in the target environment is code in a repo you own, planned and applied through Terraform Cloud.
- **Zero downtime by design.** The target environment is built and verified in parallel while your current stack keeps serving traffic.

## Phases

### 1. Kickoff & repo setup

We create (or you create and invite us to) a repository in **your** GitHub or GitLab org. Terraform Cloud workspaces are set up under your organization with remote state, plan-on-PR, and apply gates. From day one, everything we produce lands as pull requests you can read.

### 2. Parallel build

We implement the target environment as Terraform: compute (Workers/Pages or VPS), databases, object storage, queues/cron, DNS records (unrouted), TLS, and CI/CD. Your current stack is untouched and unaware.

### 3. Data migration & verification

- **Databases:** replicated or exported/imported with a verified row-count and checksum pass. For Firestore → Postgres we map collections to a relational schema and port security rules to app-layer authorization.
- **Auth:** user records exported with password hashes where the provider allows it (e.g. Firebase Auth scrypt hashes) — no forced password resets.
- **Objects/assets:** synced (e.g. to R2), then re-synced at cutover.
- The target environment runs against production-shaped data and is verified: smoke tests, load sanity checks, and a staging URL you can hammer.

### 4. Cutover

A scheduled, reversible DNS switch:

1. TTLs lowered ahead of time.
2. Final data delta sync.
3. DNS flipped to the new environment.
4. Old stack kept warm as an instant rollback path until you're satisfied.

You execute the write actions (or grant a scoped, temporary credential for the window and revoke it after).

### 5. Handover & 30-day support

- The repo, Terraform state, and runbook are yours — they were in your org the whole time.
- 30 days of post-cutover support for anything that surfaces.
- Old-provider teardown checklist (what to cancel, when it's safe).

## After the migration

The dashboard keeps working if you want it ($99/mo, optional, cancel anytime):

- **Drift detection** — if someone changes something in a console, you see it.
- **IaC standards enforcement** — modules, naming, tagging, remote state, and review gates checked on every change.
- **Workspace management** and cost tracking.

Fire us anytime. The code, the state, and the docs stay with you — no lock-in by design.
