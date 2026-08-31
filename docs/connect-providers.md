# Granting read-only access

The assessment runs entirely against read-only credentials. You create the credential in your provider's console, paste it into the infralift dashboard (**Connections** page), and we verify it works before anything else happens. Credentials are encrypted at rest (AES-256-GCM), never displayed again, and never used to modify your infrastructure. See the [security model](./security.md).

Connect one provider or several. Each connection is assessed independently and combined into one report.

---

## Vercel

1. Go to `vercel.com/account/tokens` and create a token.
2. Scope it to the team you want assessed.
3. Vercel tokens inherit the permissions of your role. For strict read-only, create the token from a member with the **Viewer** role.
4. Paste the token in the dashboard under **Connections**, provider **Vercel**.

**What we read:** projects, domains, environment variable *names* (never values), deployment and usage data.

## Cloudflare

1. Go to `dash.cloudflare.com/profile/api-tokens` and create a custom token.
2. Grant only these permissions:
   - `Account · Workers Scripts · Read`
   - `Account · Cloudflare Pages · Read`
   - `Account · Workers R2 Storage · Read`
   - `Zone · Zone · Read`
   - `Zone · DNS · Read`
3. Paste the token in the dashboard.

**What we read:** Workers, Pages projects, R2 buckets, DNS zones and records.

> Cloudflare is usually our migration *target*, not source. Connecting it lets us inventory what you already run there so the whole estate lands under Terraform.

## Heroku

1. Go to `dashboard.heroku.com/account`, find **API Key**, or run `heroku authorizations:create` for a scoped authorization.
2. Paste the key in the dashboard.

**What we read:** apps, dyno formation, and add-ons. We only call read endpoints.

## AWS

AWS access works via a cross-account IAM role, not a pasted key:

1. Create an IAM role in your account.
2. Attach the AWS-managed **`ReadOnlyAccess`** policy, plus `ce:GetCostAndUsage` (for cost projections from Cost Explorer).
3. Set the trust policy to our AWS account, **with an external ID** (shown in the dashboard when you select AWS) to prevent confused-deputy access.
4. Paste the role ARN (`arn:aws:iam::123456789012:role/infralift-readonly`) in the dashboard, or a JSON object `{"roleArn": "...", "externalId": "..."}`.

**What we read:** resource inventory and Cost Explorer data. `ReadOnlyAccess` cannot create, modify, or delete anything.

## Firebase / Google Cloud

1. Go to `console.cloud.google.com/iam-admin/serviceaccounts` in the project you want assessed.
2. Create a service account with the **Viewer** role, or for tighter scoping: **Firebase Viewer**, **Cloud Functions Viewer**, and **Cloud Datastore Viewer**.
3. Generate a JSON key for the service account.
4. Paste the full JSON key in the dashboard.

**What we read:** Firebase Hosting sites, Cloud Functions, and Firestore databases. Viewer roles carry no write permissions of any kind.

---

## GitHub (destination, not a source)

This is the only connection that can write anything, and it writes only to the
repository you nominate. It is how generated Terraform reaches you.

1. Go to **github.com/settings/tokens** and create a fine-grained personal access token.
2. Grant **Contents: Read and write**.
3. Scope it to the repository that will hold your infrastructure code. If you want infralift to create that repository, the token needs permission to create repositories for the owner instead; otherwise create the repo yourself first and scope the token to it.
4. Paste the token in the dashboard.

**What we write:** generated `.tf` files, on the branch you choose. Nothing else. Your source provider credential remains read-only and the GitHub token has no access to it.

---

## Verification

When you click **Connect & verify**, we make a single read call to confirm the credential works and is scoped as expected. The connection shows as `valid`, `invalid`, or `unverified` in the dashboard. Assessments only run against `valid` connections.

## Revoking access

You can revoke at any time from your provider's console (delete the token, key, role, or service account). Nothing on our side needs to be coordinated; the connection simply turns `invalid` on the next check.
