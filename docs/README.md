# infralift documentation

infralift migrates your app off Vercel, Heroku, Firebase, or AWS onto Cloudflare or a VPS for a fixed fee, with every deliverable as Terraform in a repo you own. The assessment is free and read-only.

## How it works, end to end

1. [Grant read-only access](./connect-providers.md): create a read-only token, role, or service account for your current provider and connect it in the dashboard. We can never modify anything.
2. [Get your assessment report](./assessment-report.md): we inventory your stack, project monthly costs (list price *and* effective price after credits and discounts), flag risks, and quote a fixed migration fee.
3. [Review the migration strategy](./migration-process.md): parallel build, zero downtime on your current stack, Terraform in your repo, DNS and data cutover, 30-day support.
4. [Security model](./security.md): how your credentials are scoped, encrypted, and used.

## Quick answers

| Question | Answer |
|---|---|
| Does the assessment cost anything? | No. The report is yours even if you never hire us. |
| Can infralift change my infrastructure? | No. Every credential you grant is read-only. Verification fails if you paste a write-capable token where a read-only one is expected. |
| What do I get from a migration? | A GitHub repo you own containing all Terraform, state in Terraform Cloud, a working target environment, and a cutover. |
| What if we part ways? | You keep the repo, the state, and the docs. No lock-in by design. |
| How is the fee set? | Fixed, quoted in the assessment report. From $3,000. No hourly billing. |
