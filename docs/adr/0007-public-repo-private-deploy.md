# 0007. The repository is public; deploys are pulled by a private repository

**Status:** accepted, 2026-11-09

## Decision

This repository is public, under the Business Source License 1.1. It has no self-hosted runner and no credential that reaches production. Its CI runs on GitHub-hosted runners. A workflow in a private repository deploys `main`: it deploys a commit only after this repository's CI has passed on it, builds the images on the production host and restarts the Nomad job.

**Amended 2026-11-09:** this repository's CI starts that workflow as soon as CI passes on `main`, with a fine-grained token that can only start and cancel workflows in the private repository (Actions: write). The secret is available only to pushes to `main` here, never to pull requests or forks. The private workflow still checks every 10 minutes as a backstop.

## Why

On a public repository, a pull request from a fork runs the workflow as the fork wrote it. A self-hosted runner attached to the repository would run that code on the production host, where the runner can use Docker (root-equivalent) and holds a Nomad token. GitHub only asks for approval the first time a contributor opens a pull request, so approval is not a boundary. Polling from a private repository keeps every credential out of this one; a trigger from here would need a token here.

## Cost

The trigger token is the one credential this repository holds. If it leaked, someone could start or cancel the private repository's workflows, but not change what they run or read or push its code. It expires and must be rotated. The deploy workflow is not in this repository, so changes to how deploys run are made where this repository's contributors cannot see them; ARCHITECTURE.md describes what it does. Internal details that were committed before the repository went public (a private host address, a session log) remain in its history; none of them grants access.
