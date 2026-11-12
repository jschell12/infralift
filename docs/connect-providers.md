# Granting read-only access

The assessment runs entirely against read-only credentials. You create the credential in your provider's console, paste it into the infralift dashboard (**Connections**, then **Add connection** and the provider), and we verify it works before anything else happens. Credentials are encrypted at rest (AES-256-GCM), never displayed again, and never used to modify your infrastructure. See the [security model](./security.md).

Connect one provider or several. Each connection is assessed independently and combined into one report.

---

## Vercel

1. Go to `vercel.com/account/tokens` and create a token.
2. Scope it to the team you want assessed.
3. Vercel tokens inherit the permissions of your role. For strict read-only, create the token from a member with the **Viewer** role.
4. Paste the token in the dashboard under **Connections**, **Add connection**, **Vercel**.

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

AWS access works via a cross-account IAM role, not a pasted key. Choose **AWS** under **Connections**, **Add connection** to see your organization's external ID and the two policies below, already filled in, with copy buttons.

1. Create an IAM role in your account with this **trust policy**. The principal is infralift's AWS account and the condition is your organization's external ID, which stops anyone else from pointing infralift at your role (the confused-deputy problem). Your external ID is generated once, is unique to your organization, and is never shown to another one.

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Principal": { "AWS": "arn:aws:iam::<infralift account>:root" },
         "Action": "sts:AssumeRole",
         "Condition": { "StringEquals": { "sts:ExternalId": "<your external ID>" } }
       }
     ]
   }
   ```

2. Attach this **permissions policy** to the role. These are the only two actions the assessment calls:

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       { "Effect": "Allow", "Action": ["tag:GetResources", "ce:GetCostAndUsage"], "Resource": "*" }
     ]
   }
   ```

3. Paste the role ARN (`arn:aws:iam::123456789012:role/infralift-readonly`) in the dashboard. To scan regions other than the default six (`us-east-1`, `us-east-2`, `us-west-1`, `us-west-2`, `eu-west-1`, `eu-central-1`), paste a JSON object instead: `{"roleArn": "...", "regions": ["ap-southeast-2"]}`, up to 10 regions. You do not paste the external ID: infralift always uses your organization's own, whatever the pasted JSON says.

**How we verify:** infralift assumes the role with your external ID, then calls `sts:GetCallerIdentity` with the role's credentials. The connection is `valid` only if the role assumes and its account matches the account in the ARN. A refusal from AWS means the trust policy does not name infralift's account or does not require your external ID.

**What we read:** the Resource Groups Tagging API (`tag:GetResources`) in each region, which lists resources that carry, or once carried, a tag; untagged resources do not appear. The inventory stops at 1,000 resources and the report says so when it does. From Cost Explorer, last full month's total unblended cost (`ce:GetCostAndUsage`, which AWS bills at $0.01 per request). If the role lacks `ce:GetCostAndUsage`, the report has no monthly spend and says why. Neither action can create, modify, or delete anything.

**Availability:** AWS connections need infralift's own AWS principal configured on the server. Until it is, the AWS step of **Add connection** says AWS isn't available yet and adding an AWS connection is refused.

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
