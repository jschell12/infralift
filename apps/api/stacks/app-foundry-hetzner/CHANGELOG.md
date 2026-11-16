# Changelog: app-foundry-hetzner

Releases of this catalog stack (ADR 0012). A release is immutable: a change to
anything the stack renders is a new release, with an entry here and the same
number in stack.json's `version`. Newest first.

- Major: an existing project's next plan can replace or destroy something, or
  needs a manual step (a `moved` block it cannot write itself, a state move).
- Minor: new settings or resources, off by default or with no effect on an
  existing project's plan.
- Patch: fixes that leave an existing project's plan empty.

## 1.0.0 (2026-11-16)

First numbered release. The stack as it stood on this date: the app-foundry
template on one Hetzner server behind a Cloudflare tunnel, a preview per pull
request, nightly backups that are restored to prove them, SSH only through
Cloudflare Access, and GitHub Actions or GitLab CI delivery. Providers:
hetznercloud/hcloud ~> 1.70, cloudflare/cloudflare ~> 5.28,
integrations/github ~> 6.13 or gitlabhq/gitlab ~> 18.11, hashicorp/tls ~> 4.0.
Projects created before this release have no recorded release.
