# 0002. Imports pass a read-only plan that changes nothing

**Status:** accepted, 2026-11-07

## Decision

An existing Terraform module, or a set of resources built by hand, comes under infralift only after a read-only plan (`plan -lock=false`, no apply) reports that no resource would change. Importing into state is allowed; changing or destroying is not. The check is a GitHub Actions workflow infralift adds to the customer's repository (`lib/import/check.ts`).

## Why

Importing without changing what is running is a selling point, and the only honest way to promise it is to prove the code already describes what is running before anything is applied. `-lock=false` keeps the check from blocking the customer's own pipeline.

## Cost

A module whose code has drifted from reality cannot be imported until someone fixes the drift. The check's wording is a contract with the code that reads it back, kept in `lib/import/contract.ts`.
