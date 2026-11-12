# Architecture decision records

One page per decision that shaped infralift: what was decided, why, and what it costs. New decisions get the next number. A decision that is replaced is marked superseded, not deleted.

| # | Decision | Date |
| --- | --- | --- |
| [0001](0001-customer-owned-state.md) | State and credentials stay with the customer | 2026-11-07 |
| [0002](0002-zero-change-import-gate.md) | Imports pass a read-only plan that changes nothing | 2026-11-07 |
| [0003](0003-generated-not-guessed-code.md) | Adopted resources get generated code, not guessed code | 2026-11-08 |
| [0004](0004-terraform-cloud-as-connection.md) | Terraform Cloud is a connection the customer brings | 2026-11-08 |
| [0005](0005-services-and-typed-errors.md) | Rules live in services; failures are typed errors | 2026-11-08 |
| [0006](0006-job-queue-no-auto-retry.md) | Jobs are a queue in Postgres, and interrupted jobs are not retried | 2026-11-08 |
| [0007](0007-public-repo-private-deploy.md) | The repository is public; deploys are pulled by a private repository | 2026-11-09 |
| [0008](0008-adoption-applies-a-saved-plan.md) | An adoption is applied by a saved plan in the customer's CI | 2026-11-10 |
| [0009](0009-stacks-modules-and-team-stacks.md) | Stacks are made of modules, and teams bring their own from git | 2026-11-10 |
| [0010](0010-a-project-is-one-accounts-infrastructure.md) | A project is one cloud account's infrastructure, not an app | 2026-11-11 |
