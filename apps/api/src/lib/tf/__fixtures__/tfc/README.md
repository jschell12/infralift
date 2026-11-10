Terraform Cloud API responses, copied from the sample responses in HashiCorp's
API docs (read 2026-11-10), trimmed to the fields infralift reads. Not measured
against a live organization.

- `oauth-clients.json`: List OAuth Clients, developer.hashicorp.com/terraform/cloud-docs/api-docs/oauth-clients
- `oauth-tokens.json`: List OAuth Tokens, developer.hashicorp.com/terraform/cloud-docs/api-docs/oauth-tokens
- `runs-with-plan.json`: List Runs in a Workspace with `include=plan`, api-docs/run; the
  included plan's attributes are the Show a Plan sample, api-docs/plans. The run ids,
  workspace id and the second (still planning) run are ours.
- `workspace-vcs.json`: a workspace with a `vcs-repo`, api-docs/workspaces
