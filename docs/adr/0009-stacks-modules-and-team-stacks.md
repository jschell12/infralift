# 0009. Stacks are made of modules, and teams bring their own from git

**Status:** accepted, 2026-11-10

## Decision

**Vocabulary.** A *module* manages one important resource (a database, a server, a bucket) plus what exists only to serve it: its security group, its parameter group, its DNS record. A *stack* is a collection of modules, with the wiring between them, an input schema, and the CI that delivers it. `stack.json` may list its modules (`modules`: name, path, anchor resource type, inputs, outputs); the list is optional and descriptive until module-based composition exists.

**Where stacks come from.** infralift ships catalog stacks on disk (`apps/api/stacks/<slug>`), and an org can register its own from a git repository it already connects: repo, ref, and the stack's directory in the repo. A team stack has the same layout as a catalog one (`stack.json`, `files/`, `deliveries/<d>/files/`, `templates/`); files beside it are not read. There is no zip upload.

**Pinning.** A ref is resolved once, when a version is added, and the version records the commit SHA. Files are read at that SHA, never at the ref, and stored with the version together with a sha256 index. A tag moved afterwards changes nothing that exists; registering the ref again adds a new version. Projects record the version they render from (`TfProject.stackVersionId`); catalog projects keep `stackSlug`.

**Visibility.** A team stack is private to its org. The org can ask to publish one version to every infralift org; it is `pending_public` and invisible to others until an infralift admin approves it in the admin app, after which other orgs see that version only. The owner can withdraw at any time, back to `private`. An admin can revoke a pending or public stack; a revoked stack stays usable by its owner and hidden from everyone else. Another org sees where a published stack comes from (host, repository, directory) and nothing about its review.

**No team Terraform runs on infralift's servers.** `tofu init` downloads whatever providers and modules the code names, and `validate` runs them; that is arbitrary code. Server side, infralift only reads and checks:

- fetches files at the pinned SHA through the org's own git connection (`GitHostClient`);
- refuses symlinks, submodules, absolute paths, `..` segments, more than 300 files, a file over 256 KiB or more than 2 MiB in all, and a truncated listing;
- validates `stack.json` against its JSON Schema (`lib/stacks/manifest-schema.ts`) and checks every rendered template is a file in `templates/` and every output path is relative;
- renders the manifest's `example` with the logic-less `{{var}}` renderer, the same code that renders catalog stacks, through a `StackTree` that reads from disk or from memory.

Real validation (`tofu validate`, plans) runs as CI in the customer's repository, through the delivery CI the stack already carries.

## Why

Teams already keep infrastructure in git, with review and history. Pointing at a ref keeps that as the source of truth; pinning the SHA makes a version immutable, so what was checked, and what an admin approved, is what renders. Storing the files with the version means a project made from someone else's published stack never reads the owner's repository with anyone's credentials, and a force-push cannot break it.

Review before publishing exists because a published stack writes CI workflows into other orgs' repositories. Review by version, not by stack, stops a reviewed stack from changing under its users.

## Cost

Stored file contents take up to 2 MiB per version in Postgres. A stack that only renders correctly with inputs other than its `example` passes registration and fails in the customer's CI instead. Reading files one request each makes registering a large stack slow, up to 300 calls. The visibility column is a string checked in code (`lib/stacks/visibility.ts`), like the other state columns in the schema, rather than a database enum.
