# 0004. Terraform Cloud is a connection the customer brings

**Status:** accepted, 2026-11-08

## Decision

A project that keeps state in Terraform Cloud names one of its org's Terraform Cloud connections. The workspace is created in that connection's organization, and the generated `cloud {}` block names the same organization. With no connection, no workspace is created. infralift's own Terraform Cloud organization is not used for customer projects; the operator's own projects use a connection like anyone else's.

## Why

Before this, the generated code named an organization the user typed while the workspace was created in infralift's organization, so the two could disagree, and codegen created workspaces in infralift's organization on every run. It also contradicted [0001](0001-customer-owned-state.md).

## Cost

Codegen and template projects have no way to pick a connection yet, so they create no workspace. The organization name is stored in the project's settings and does not follow a later change to the connection.
