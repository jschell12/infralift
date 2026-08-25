# The assessment report

Once at least one provider connection is `valid`, you can run an assessment from the dashboard. It's free, read-only, and the report is yours to keep whether or not you hire us.

## What's in the report

### 1. Resource inventory

Everything we found, per provider: projects, apps, dynos, functions, hosting sites, databases, buckets, domains, DNS zones, and add-ons, with the metadata that matters for a migration (regions, runtimes, instance sizes, custom domains).

### 2. Cost projection at three prices

For your current stack and each candidate target, we project monthly cost three ways:

| Price | Meaning |
|---|---|
| **List** | What the provider's published pricing says a stack like yours costs. |
| **Year-1 effective** | List minus any startup credits you're eligible for (AWS Activate, Google for Startups, Cloudflare for Startups, etc.), modeled with their real terms: expiry windows, monthly use-it-or-lose-it caps, and the fact that credits don't stack with committed-spend discounts. |
| **Steady state** | List minus the best committed-spend discount your annual spend actually qualifies for (enterprise agreement curves), or a published mechanism like Hetzner's server auction. |

Every discount figure carries a confidence tag (`corroborated` for multiple independent sources, `advisor` for advisory-published curves only, `anecdote`, or `unverified`) with a source date. We don't dress up a single Hacker News comment as market data.

Two honest caveats baked into the model:

- **If you're burning startup credits now, your real bill arrives when they expire.** The report shows the cliff explicitly.
- **Below roughly $1M/year of spend, enterprise discounts are not realistically negotiable.** At that scale, changing architecture is the only discount that exists, which is usually why the migration pays for itself.

### 3. Findings

Ranked observations with severity and category: lock-in risks (e.g. Firestore data model, ISR/edge features), cost drivers, portability notes (which functions move cleanly, which need re-architecture), and security/ops flags.

### 4. Recommendation

Where your app should live, scored against your actual requirements (runtime, required capabilities, budget, ops tolerance, traffic) rather than a generic pitch. Sometimes the answer is Cloudflare, sometimes a VPS, occasionally "stay where you are." If we can't beat your current setup, the report says so.

### 5. Fixed-fee quote

A precise migration fee (from $3,000), the phase plan, and the risk/effort breakdown behind the number. The quote is fixed: the price in the report is the price you pay.

## How long it takes

Minutes for the automated inventory; the full report with cost modeling and the quote is typically ready the same day.
