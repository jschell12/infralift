# 0012. Catalog stacks are released by version, and upgrades arrive as pull requests

**Status:** accepted, 2026-11-16

## Context

A catalog stack (`apps/api/stacks/<slug>`) is copied into the customer's repository when a project is created, and the project records only `TfProject.stackSlug`. Nothing records which state of the stack it was copied from, so nothing can say what changed since. Team stacks are pinned per commit (ADR 0009, `StackVersion`), but a project made from one has no way to move to a newer version either. Provider pins are scattered: the AWS pin lives in `lib/tf/codegen.ts`, the stacks repeat it by hand, and the Cloudflare and Hetzner pins in codegen and in the stacks had already drifted apart. Nothing tells a team its stack or its providers are behind, and teams that do not care about infrastructure skip upgrades until one is forced on them by a deprecated API or a security fix, which is the worst time to take three majors at once.

## Decision

**1. Catalog stacks have releases.** Each catalog stack carries a semver `version` in `stack.json` (`MAJOR.MINOR.PATCH`, digits only) and a `CHANGELOG.md` beside it, newest first. A release is immutable: any change to what the stack renders is a new release with a changelog entry. Major means an existing project's next plan can replace or destroy something, or needs a manual step; minor adds settings or resources without changing an existing project's plan; patch leaves that plan empty. A project records the slug and the release it was created from (`TfProject.stackRelease`). Projects made before releases existed keep null, which means unknown, not 1.0.0.

**2. One version baseline.** `lib/tf/baseline.ts` holds the `required_version` floors and the provider version constraints, and is the single source for catalog stacks, codegen, adoption and extension workspaces. Code that writes HCL reads it; static stack files on disk are held to it by a test that fails on any disagreement, so moving a pin is one change in one place plus whatever the test then names. Floors are a small named table rather than one value, because a floor follows the features a file uses: generated code stays at `>= 1.5` so Terraform 1.5.7 (the last MPL release) keeps working, an R2 backend needs `>= 1.8` for its encryption block, and adoption needs `>= 1.10` for `use_lockfile`. Generated repositories commit `.terraform.lock.hcl`, so what CI planned with is what the next run installs, and an upgrade is a visible diff to the lock file rather than whatever `init` resolved that day.

**3. Thin roots, modules by version, from the customer's own registry.** The customer's repository holds a thin root module: provider configuration, backend, module calls with their inputs, and outputs. Modules are referenced by version, not copied.

For Terraform, modules are stored in and referenced from the customer's Terraform Cloud private module registry: `source = "app.terraform.io/<org>/<name>/<provider>"` with an exact `version` pin (`version = "1.4.0"`, never a range). A catalog module is published under its stack's release number, so one number names the whole set of modules a release is made of. infralift publishes catalog module releases into the customer's organization through the API-driven (non-VCS) registry: create the module once, then for each release create a version and upload its tarball. That needs the project's Terraform Cloud connection (ADR 0004) to hold a token with permission to manage modules in that organization. If it does not, infralift does not publish and does not fall back to another source: the project keeps the release it has, the fleet view shows the upgrade as blocked on "this connection cannot publish modules", and the connection's verify reports the missing permission so the fix is a token change, not a support ticket. A team stack's own modules go through the same registry, published from the commit its `StackVersion` pins.

Git-tag sources (`git::https://...?ref=v1.4.0`) were considered for the Terraform path and rejected by the owner. The registry gives version constraints, a module page per release and a single place inside the customer's own organization for everything their roots reference, and keeps infralift's repository (or any third-party host) out of the customer's `init`. Git sources would also need a credential for a private repository on every runner that inits.

The OpenTofu path (projects on the R2 backend of ADR 0010, the catalog stacks' default) is deferred to a later ADR, which decides where those modules are published and how they are referenced. Until it exists, OpenTofu projects keep their modules in the repository, as today, and get provider and lock-file upgrades only.

A customer may eject: copy the modules into their repository and own them. infralift stops publishing module releases for an ejected project, and it gets provider and lock-file upgrades only.

**4. Upgrades are pull requests into the customer's repository.** One upgrade pull request bumps the module pins, the provider constraints and the lock file together, so the plan in it is the plan of the whole change. The plan runs in the customer's own CI through the delivery the stack already carries; infralift never runs customer Terraform (ADR 0001, ADR 0009). infralift reads the plan's result back and puts its classification in the pull request with the changelog entries between the two releases: no changes, in-place updates only, or replace/destroy. Auto-merge of a no-change upgrade is opt-in per project. An upgrade whose plan replaces or destroys anything always waits for a human, whatever the project's setting.

**5. Every release is tested as an upgrade.** CI applies release N of a stack against the existing moto fake, renders N+1 over it, and plans: the plan must be empty, or match what the changelog entry says it changes. A release whose upgrade plan cannot be explained by its changelog does not ship.

**6. A fleet view, and a lag policy.** One view lists every project's stack and release, provider versions, how far each is behind, and any open upgrade pull request. An org sets a lag policy (for example: at most 2 minor releases behind, majors taken within 90 days of release), and a project outside it escalates to the org's platform owner. Adopted projects, both cloud-account adoptions (ADR 0008) and adopted Terraform Cloud workspaces, get provider and lock-file upgrade pull requests only, and only as pull requests: infralift does not upgrade an adopted workspace's code (`lib/tf/extensions.ts` keeps those templates frozen) and never pushes an upgrade to one.

## Phasing

1. Releases, the baseline, the project records its release, and a read-only fleet view.
2. Provider and lock-file upgrade pull requests, with the plan classification read back from the customer's CI.
3. Registry publishing, thin roots, and the upgrade-path test in CI.
4. Auto-merge of no-change upgrades, the lag policy and escalation.

## Why

An upgrade nobody is told about does not happen, and one that arrives as a three-major jump under a deadline is the riskiest change a team makes to its infrastructure. Small, regular pull requests that say what they will do, with the plan already run, are cheap to accept and easy to refuse. Recording the release a project came from is what makes "what changed since" answerable at all; without it every upgrade is a diff against an unknown.

Putting the classification in the pull request moves the judgement to where the reviewer already is, and the replace/destroy rule keeps auto-merge from ever being the thing that deletes a database. Keeping plans in the customer's CI keeps their credentials and state where ADR 0001 put them.

One baseline exists because three hand-kept copies of the AWS pin already needed a test to stop them drifting, and the Cloudflare and Hetzner pins had drifted with nothing to catch them.

## Cost

- Publishing into the customer's registry needs a Terraform Cloud token that can manage modules, which is more than workspace creation needs. Customers whose connection lacks it get no module upgrades until they change the token, and the fleet view has to say so beside the project.
- A thin root changes the layout of every catalog stack, and moving an existing project from vendored modules to registry modules is itself an upgrade whose plan must be empty. Changing a module call's `source` keeps its resource addresses when the call's name stays the same, so a project whose vendored modules match a published release moves cleanly; one whose modules were edited in place does not, and stays vendored, treated as ejected.
- Until the OpenTofu ADR, the catalog stacks' default backend gets provider and lock upgrades only, which is most of today's projects.
- Projects created before migration 0031 have no recorded release. An upgrade for one has to establish its starting release first, by comparing its files with each release, or treat it as ejected.
- Changing the baseline changes generated output for every new project at once. Raising the Cloudflare pin to `~> 5.28` and the Hetzner pin to `~> 1.70` for codegen, adoption and migration targets came with this decision, to match what the stacks were tested on.
- The upgrade-path test can only exercise what moto implements. Resources moto does not model (CloudFront function publishing, RDS parameter group parameters) need a changelog-declared expectation instead of an empty plan, and those expectations are only as good as whoever writes them.
