# 0001. State and credentials stay with the customer

**Status:** accepted, 2026-11-07

## Decision

infralift does not read a customer's Terraform state and does not hold the cloud credentials that a plan needs. State lives in a backend the customer owns (S3, R2, GCS, Azure Storage, or their own Terraform Cloud organization). Plans that need cloud access run in the customer's CI, with their secrets or with OIDC.

## Why

Security is one of the three things infralift sells. State files hold secrets and the full shape of a customer's infrastructure; cloud credentials can change it. Not holding either removes a whole class of breach, and it means a customer can leave with everything.

## Cost

infralift cannot show a plan's result until the customer's CI has run it, and every check needs the customer to add secrets or set up OIDC first. Results are read back from the check run (`lib/import/result.ts`) instead of being computed directly.
