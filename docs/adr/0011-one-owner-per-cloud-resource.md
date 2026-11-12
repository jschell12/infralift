# 0011. Each cloud resource has one owning project, recorded in a ledger

**Status:** accepted, 2026-11-11

## Decision

infralift keeps a ledger of the cloud resources its projects manage (`ManagedResource`). A row names the project, the connection the resource is in, and the resource by the connector's own identity: the inventory type (`aws:ec2:instance`, `cloudflare:zone`) and the provider's id for it (an ARN, a zone id). The Terraform address is stored beside it but is not part of the key.

The key is unique per connection: `(providerConnectionId, provider, resourceType, providerId)`. One cloud resource has at most one owning project. Adopting a resource another project manages, or has reserved, is a 409, whether the second request comes later or at the same moment; the database's unique index decides the race, not a read before the insert.

The "Adopt from an account" view (ADR 0010) is the account's live inventory minus the ledger. A project names its account in `TfProject.providerConnectionId`, which must be a connection of the project's own org.

Rows are written when an adoption pull request opens, as `pending`, and become `managed` when its import check passes (the plan imports and changes nothing). If the pull request is closed without merging, the project's rows are deleted and the resources show as unmanaged again. Only adoption writes rows. A repository import and a stack do not know provider ids: the import scan reads HCL, not state, and a stack's resources get their ids from the customer's apply. infralift never reads state (ADR 0001), so neither writes a row rather than guessing one.

## Why

Two projects importing the same resource means two states that each believe they own it, and the next apply of either one can change or destroy what the other manages. Opening the second pull request is already the mistake, so the refusal has to come before any pull request opens. The unmanaged view also needs one place to subtract from, or every page load would read every project's repository.

Keying on the connector's identity rather than on the Terraform import id is what makes the subtraction possible: the inventory has a type and an external id for every item, and only some items have an import id. The two cannot drift, because an adoption's rows are written from the same inventory items its import blocks are generated from (`planAdoption` carries the external id through).

## Cost

- Pending rows are reservations taken before anything is imported. A pull request left open and never merged keeps its resources out of the view until it is closed.
- Rows move only when infralift reads the check: `GET /tf/imports/:id/check`, which the project page polls. A check that passes while nobody looks leaves the rows `pending`, which is still enough to refuse a second owner.
- `managed` means the import plan passed, not that the apply has recorded the resources in state. The drift job's `unapplied` state (ADR 0008) is what says the apply has not run yet.
- Projects made before the ledger, repository imports and stacks have no rows, so the view lists their resources as unmanaged. Adopting one of those would import it into a second state. This is the view's largest gap, and the page that shows it has to say so beside the list.
- Adding resources to an existing adoption project is refused for now: the import check generates resource code once, into `generated.tf`, and never generates over it, so a later import block would have no code. Generating each batch into its own file would lift this.
