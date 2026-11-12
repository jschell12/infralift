# 0010. A project is one cloud account's infrastructure, not an app

**Status:** accepted, 2026-11-11

## Decision

infralift manages cloud infrastructure. It does not build, host or deploy applications.

**What a project is.** A project is the Terraform for one cloud account in one environment, such as "AWS prod" or "Cloudflare". It has three parts:

- one provider connection (`ProviderConnection`);
- one directory in one repository, which holds the code;
- one state backend (OpenTofu with R2, or a Terraform Cloud workspace).

A project contains modules, in the sense of ADR 0009: a database, a bucket, a network or a DNS zone, each with what exists only to serve it. Infrastructure that spans accounts or providers is several projects, and a stack can tie them together. A project does not reach across connections.

**How a project starts.** `/projects/new` is a page, not a drawer. It offers three starting points, in this order:

1. **Adopt from an account.** This is the primary path. Pick a connection, and infralift lists what is in the account that no Terraform manages. You choose which resources to bring under management. infralift generates the code (ADR 0003), groups it into modules, and opens a pull request that applies by saved plan (ADR 0008).
2. **Start from a stack.** Choose a catalog stack or one of the team's own, for example Postgres with backups, a network baseline, or a bucket behind a CDN.
3. **Bring existing Terraform.** Point at a repository directory (ADR 0002) or at Terraform Cloud workspaces that already manage the account.

**What leaves the product surface.** New projects no longer offer:

- app templates;
- creating a repository from an app template (`TfProject.createRepo`);
- stacks that deliver an application, meaning a Dockerfile, app CI and hosting. `app-foundry-hetzner` is the only one today.

These come out of `/projects/new` and out of the catalog. Existing projects that use them keep working: their rows, renderings and jobs are untouched. The code is removed in a later change, once no project depends on it. Moving off a PaaS stays possible, because a database or bucket created on the PaaS can be adopted like any other resource, but it is not a starting point of its own.

**Connections get the same treatment.** `/connections` is a grid of tiles, one per connection, with the add button at the top. `/connections/new` is a page where you pick a type, then see that type's fields and setup steps. Terraform Cloud is a connection type like any provider (ADR 0004) and is no longer a separate form. Drawers remain for small actions on an existing item, such as replacing a token or viewing runs.

## Why

The product is bringing click-built infrastructure under Terraform and keeping it there. App hosting is a different product with different competitors, and it pulled the project model toward repositories of app code. One account per project matches how credentials, blast radius and state already divide. Without it, the same plan needs two sets of credentials, and drift in one account blocks applies in another.

## Cost

- The catalog has no infrastructure stacks yet. The new-project page starts with adopt and import carrying it until the first catalog stacks land.
- Someone used to one project covering AWS plus Cloudflare DNS now has two projects. Outputs from one feed the other through a stack or remote state, which is more wiring than a single root module.
- The app-hosting code stays in the repository, hidden, until a follow-up removes it. Until then it has to keep passing tests.
