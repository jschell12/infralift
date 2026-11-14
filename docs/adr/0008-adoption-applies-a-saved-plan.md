# 0008. An adoption is applied by a saved plan in the customer's CI

**Status:** accepted, 2026-11-10

## Decision

Adopting resources from a cloud account adds a second workflow beside the import check (`lib/import/apply.ts`). On a push to the branch the adoption merged into, one job in the `production` environment plans with the state lock (`plan -out`) and applies exactly that plan file. The plan file never leaves the runner: no artifact, no second job. That apply is what records the imported resources in state. The import check keeps ADR 0002's rule unchanged: it plans read-only on pull requests and on the schedule, and never applies. A repository import gets no apply workflow, because the customer's own pipeline already applies that module.

Before the check commits `generated.tf` it scans it for values that look like secrets: attributes named like a credential (`password`, `token`, `private_key`, `config_vars` and others in `lib/import/guard.ts`) with a literal value, and gitleaks at a pinned version whose checksum the step verifies. A finding stops the commit and names the line, never the value. Failed plans print Terraform's error diagnostics, not the plan output.

Until the apply has run, the drift job reports the module as not yet applied (`unapplied`), not as having no drift: an import-only plan is a no-op to Terraform, and reading it as "no drift" hid an adoption that never reached state.

## Why

The adoption pull request promised that merging records the resources in state, and nothing ran on merge. The design takes from the stack's `infra.yml` a saved plan, so the apply is what was planned or nothing; an environment, so the customer can require a reviewer; a concurrency group of its own that never cancels a run in progress, so an apply is not stopped halfway; bash with pipefail; a read-only token; and a guard so a fork's copy never runs.

It departs from `infra.yml` in one way. That workflow plans in one job and uploads the plan for an apply job, and a plan file holds prior state and planned values in plaintext, sensitive attributes included (Terraform redacts its rendered output, not the file). As an artifact it is readable by anyone who can read the repository's Actions, which on a public repository is anyone signed in to GitHub. Planning inside `production` also means the state lock is taken with the environment's credentials, so the repository's secrets can stay read-only for the check; a plan job outside the environment would need write access to the lock and fail on read-only secrets.

## Cost

A required reviewer on `production` approves before the run plans, not after seeing its plan. For the first apply, the plan is the one the adoption pull request's check already showed (import only, nothing changes); later pushes come through pull requests whose checks showed theirs. Review-after-plan would need a second approval and an encrypted artifact with a key the customer creates. The apply needs credentials that can write state, which the read-only check does not; the pull request body tells the customer to put those on the `production` environment.

Workflows in a customer's repository change only when infralift renders them again, and the import job renders them only when a project is created. A project adopted before this change has no apply workflow and gets none automatically; there is no "refresh workflow" action yet. Its rendered files are recorded per project (`TfRendering`), so the current version of both workflows can be rendered from the project's `importJson` with `renderImportCheck` and `renderApplyWorkflow` and committed to the customer's repository by hand. Re-running the project's import job without `adoptFiles` would open that pull request, but no route does that yet.

## Upgrading an adopted project from hashicorp/aws 5.x to 6.73

Adoption pins `hashicorp/aws ~> 6.73.0` (`PROVIDER_SOURCES` in `lib/tf/codegen.ts`, since #151). A project adopted earlier keeps the `~> 5.0` its committed `versions.tf` says, and keeps resolving 5.100.0, until it is rendered again (the gap above). What a re-render to 6.73 does, measured on moto on 2026-11-14 with eight kinds adopted and applied on 5.100.0:

- The workflows need no `init -upgrade`. The flow commits no `.terraform.lock.hcl` (the check commits only `generated.tf`), so the runner's `tofu init` resolves 6.73.0. A customer who committed a lock file of their own gets `locked provider ... 5.100.0 does not match configured version constraint`, and has to run `tofu init -upgrade` once and commit the new lock file.
- The committed 5.x `generated.tf` plans "No changes" on 6.73.0 against the state 5.100.0 wrote, with no warnings.
- The first apply on 6.73.0 changes nothing but rewrites state silently: each resource gains the 6.x `region` attribute and the serial goes up by one. Schema versions do not change.
- Rolling back works: 5.100.0 plans "No changes" against the state 6.73.0 wrote.
- If the module directory has other files that constrain `hashicorp/aws` to `~> 5.x`, `tofu init` fails on the conflicting constraints. Move those to 6.x in the same change.

These were measured on moto, not on a real account.

**The check's read-only credentials need `s3:ListTagsForResource` on real AWS.** Under 6.x, `hashicorp/aws` reads an S3 bucket's tags through S3 Control, so generating a bucket's code calls `s3:ListTagsForResource` (the e2e stack needed moto reachable at `<account>.moto` for the same reason). A read-only role without it fails the Generate step loudly; it does not hide a difference. Add the action to the policy on the key the check uses. This is inferred from the provider's calls on moto; the first real-account adoption is what confirms it.
