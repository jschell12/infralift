# Changelog: network-baseline

Releases of this catalog stack (ADR 0012). A release is immutable: a change to
anything the stack renders is a new release, with an entry here and the same
number in stack.json's `version`. Newest first.

- Major: an existing project's next plan can replace or destroy something, or
  needs a manual step (a `moved` block it cannot write itself, a state move).
- Minor: new settings or resources, off by default or with no effect on an
  existing project's plan.
- Patch: fixes that leave an existing project's plan empty.

## 1.0.0 (2026-11-16)

First numbered release. The stack as it stood on this date: a VPC with public
and private subnets across 2 or 3 zones, NAT (one shared gateway by default),
flow logs to CloudWatch with retention, and the default security group emptied.
Modules `vpc` and `flow-logs`; hashicorp/aws ~> 6.73.0. Projects created before
this release have no recorded release.
