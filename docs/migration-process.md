# The migration process

Fixed fee, quoted in your assessment report. No hourly billing, no scope creep. If it takes us longer than planned, that's our problem.

## Principles

- **infralift orchestrates, never holds.** Your secrets and your data move directly from your old provider to infrastructure you own. Nothing sensitive transits or rests on our systems.
- **Read-only on your current provider, always.** We build the new environment; we never touch the old one. Cutover actions that require write access are executed by you, or by short-lived credentials you control and revoke.
- **Everything is Terraform.** No console clicking, no snowflake servers. Every resource in the target environment is code in a repo you own, planned and applied through Terraform Cloud.
- **Zero downtime by design.** The target environment is built and verified in parallel while your current stack keeps serving traffic, and the cutover is reversible in seconds.

## Phase 0: DNS moves behind Cloudflare first

Before anything else, your domain fronts through Cloudflare's edge. This is what makes "instant rollback" a real claim instead of a slogan:

- Cutover becomes an **origin swap at the edge**. No TTL propagation, no waiting for resolvers. Seconds.
- Rollback is the same swap in reverse, for as long as the old stack stays warm.
- Webhooks and third-party integrations (Stripe, OAuth callbacks, partners) never need reconfiguring, because your domain never changes.

Your current stack keeps serving through the edge unchanged. Nothing else happens until this is verified.

## How sensitive data moves

**Secrets and environment variables.** The assessment inventories variable names only; values are never read. At migration time, values go from your old provider into stores you own: Terraform Cloud workspace variables (sensitive, write-only) or the target platform's secret store. We reference them from Terraform as sensitive inputs. We never see them at rest.

**Databases and PII.** Dumps and replication run on an ephemeral runner inside the target environment, over TLS, directly from source to target. The runner uses an encrypted disk and is destroyed when the sync completes. Access uses credentials you issue, time-boxed, and revoked at handover.

**Paper.** A DPA is available, target regions are pinned to match your current data residency (EU or US for Neon and Hetzner), and you receive a migration audit log listing exactly what moved and when. That log is written for your auditor, not ours.

## What leaving actually costs in egress

Two different numbers get conflated here:

- **Your monthly egress bill is serving traffic.** It stops at cutover. That's the recurring saving on your assessment report.
- **The one-time exit toll is stored data leaving.** It's usually small: a production Postgres is gigabytes, not the terabytes per month you serve. A 50GB database costs almost nothing to move.

The exceptions are large object stores and Firestore exports. For those: **AWS, Google Cloud, and Azure waive egress fees for customers migrating off** (a support request, formalized after the EU Data Act). We file that request as part of the engagement. Where a waiver doesn't apply, the exit toll is estimated in your assessment report before you approve anything.

## Keeping old and new in sync until cutover

**Code parity.** CI deploys to both environments for the whole parallel window. No feature freeze: old and new are always on the same commit.

**Data parity** depends on what your current provider allows, and we tell you which tier you're in before quoting:

- **Continuous replication** (Render, DigitalOcean, Railway, RDS, most managed Postgres): logical replication into the target keeps the new database seconds behind the old one. Cutover pauses writes, waits for lag zero, and flips. Sub-minute write pause, zero read downtime.
- **Bulk copy plus a short write window** (Heroku, which blocks external logical replication): `pgcopydb` moves the bulk ahead of time, then a scheduled window applies the final delta. Minutes of write pause, not zero. We say this up front rather than let you discover it.
- **Firestore to Postgres**: collections map to a relational schema, security rules port to app-layer authorization, and the redesign is scoped explicitly in the assessment before the quote. Auth users export with password hashes where the provider allows it (Firebase scrypt included), so there are no forced password resets.

**Caches and queues.** Redis is cache: it warms on the new side, it doesn't migrate. Queues drain on the old side before producers flip.

**Objects and assets.** Synced to the target (R2 or equivalent) during the window, re-synced at cutover.

## Verification before anyone flips anything

- Row counts and checksums on every migrated table.
- Sampled production traffic replayed against the new stack.
- A cutover **rehearsal** on a staging domain, timed, with rollback exercised.
- The verification report is a deliverable. You see the evidence before you approve the cutover.

## Cutover and the rollback window

1. Final data delta applies (seconds to minutes, per your tier above).
2. The edge swaps origins. Traffic is on the new stack.
3. The old stack stays warm and paid for during an agreed rollback window (typically 7 to 14 days, priced into the fixed fee). Rollback during that window is the same edge swap in reverse.
4. After the window: teardown checklist for the old provider, what to cancel and when it's safe, plus any exit-fee waiver paperwork closed out.

## Handover and after

- The repo, Terraform state, and runbook are yours. They were in your org the whole time.
- 30 days of post-cutover support for anything that surfaces.
- The dashboard keeps working if you want it ($99/mo, optional, cancel anytime): your inventory, cost tracking, and assessments you can re-run as the stack changes.

Fire us anytime. The code, the state, and the docs stay with you. No lock-in by design.
