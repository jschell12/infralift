# 0008. An adoption is applied by a saved plan in the customer's CI

**Status:** accepted, 2026-11-10

## Decision

Adopting resources from a cloud account adds a second workflow beside the import check (`lib/import/apply.ts`). On a push to the branch the adoption merged into, it plans with the state lock, uploads the plan file and the provider lock file it was made with, and applies exactly that plan in the `production` environment. That apply is what records the imported resources in state. The import check keeps ADR 0002's rule unchanged: it plans read-only on pull requests and on the schedule, and never applies. A repository import gets no apply workflow, because the customer's own pipeline already applies that module.

Before the check commits `generated.tf` it scans it for values that look like secrets: attributes named like a credential (`password`, `token`, `private_key`, `config_vars` and others in `lib/import/guard.ts`) with a literal value, and gitleaks at a pinned version whose checksum the step verifies. A finding stops the commit and names the line, never the value. Failed plans print Terraform's error diagnostics, not the plan output.

Until the apply has run, the drift job reports the module as not yet applied (`unapplied`), not as having no drift: an import-only plan is a no-op to Terraform, and reading it as "no drift" hid an adoption that never reached state.

## Why

The adoption pull request promised that merging records the resources in state, and nothing ran on merge. The design follows the stack's `infra.yml`: a saved plan, so the apply is what was planned or nothing (Terraform refuses a plan once state has moved); an environment, so the customer can require a reviewer; a concurrency group of its own that never cancels a run in progress, so an apply is not stopped halfway; bash with pipefail; a read-only token; and a guard so a fork's copy never runs.

## Cost

The plan file is an Actions artifact for a day and can hold values from state. Anyone who can read the repository's Actions artifacts can download it in that time, which on a public repository is anyone signed in to GitHub. The apply needs credentials that can write state, which the read-only check does not; the pull request body tells the customer to put those on the `production` environment.

Workflows in a customer's repository change only when infralift renders them again, and the import job renders them only when a project is created. A project adopted before this change has no apply workflow and gets none automatically; there is no "refresh workflow" action yet. Its rendered files are recorded per project (`TfRendering`), so the current version of both workflows can be rendered from the project's `importJson` with `renderImportCheck` and `renderApplyWorkflow` and committed to the customer's repository by hand. Re-running the project's import job without `adoptFiles` would open that pull request, but no route does that yet.
