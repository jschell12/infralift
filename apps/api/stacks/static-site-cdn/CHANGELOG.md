# Changelog: static-site-cdn

Releases of this catalog stack (ADR 0012). A release is immutable: a change to
anything the stack renders is a new release, with an entry here and the same
number in stack.json's `version`. Newest first.

- Major: an existing project's next plan can replace or destroy something, or
  needs a manual step (a `moved` block it cannot write itself, a state move).
- Minor: new settings or resources, off by default or with no effect on an
  existing project's plan.
- Patch: fixes that leave an existing project's plan empty.

## 1.0.0 (2026-11-16)

First numbered release. The stack as it stood on this date: a private S3
bucket served only through CloudFront on the customer's domain, with origin
access control, an ACM certificate validated in their Route 53 zone, HTTPS
only, and index.html for directory paths. Modules `site-bucket` and
`cdn`; hashicorp/aws ~> 6.73.0. Projects created before this release have no
recorded release.
