# Cost scenarios: Vercel and Heroku migrations

Eight realistic stacks, what each one costs today, and what the same workload
costs after migrating. Numbers use published 2026 pricing (Vercel Pro $20/seat,
Fast Data Transfer $0.15/GB, edge requests $2/M; Heroku Standard-1X $25,
Standard-2X $50, Performance-M $250, Postgres Standard-0 $50) and our own
reference deployments.

Two of these eight are not worth migrating on cost alone. They are here
because the honest answer matters more than the pitch.

Payback is computed against infralift's fixed migration fee (from $3,000).

---

## Scenario 1: Solo dev, side project on Vercel

**Profile:** One person, Next.js app, ~5k monthly visitors, hobby-turned-paid.

| Item | Current (Vercel) | Target (Cloudflare Workers + Neon) |
|---|---|---|
| Hosting | Pro $20/mo | Workers Paid $5/mo |
| Database | Vercel Postgres/Neon ~$19/mo | Neon Launch $19/mo (or free tier $0) |
| Bandwidth | Included | R2 egress $0 |
| **Total** | **~$39/mo** | **~$5–24/mo** |

**Savings:** $15–34/mo ($180–408/yr, up to 87%).

**Verdict:** Don't hire us for this. The savings are real in percentage
terms and irrelevant in dollars — a fixed migration fee would take years to
pay back. This is where platform pricing still feels fine. The pain starts at
the next tier.

---

## Scenario 2: 5-person funded startup on Vercel

**Profile:** Seed-stage SaaS, 5 engineers, Next.js + API routes, ~50k MAU,
~500GB/mo data transfer, preview deploys for every PR.

| Item | Current (Vercel) | Target (CF Workers + R2 + Neon) |
|---|---|---|
| Pro seats | 5 × $20 = $100/mo | Workers Paid $5/mo (no per-seat) |
| Fast Data Transfer overage | ~$45/mo | R2 egress $0 |
| Edge requests + functions | ~$35/mo | ~$10/mo requests |
| Vercel Postgres | ~$17/mo | Neon Launch $19/mo |
| **Total** | **~$197/mo** | **~$34/mo** |

**Savings:** ~$163/mo (~$1,960/yr, 83%).

**Payback on $3,000 fee:** ~18 months. Borderline alone — but seat count
grows with headcount, so the gap widens every hire. At 8 engineers the
Vercel bill is ~$260/mo and payback drops under 14 months.

---

## Scenario 3: Scaling SaaS on Vercel (the sweat zone)

**Profile:** Series A, 10 engineers, ~200k MAU, 2TB/mo transfer, image-heavy
product, ISR + edge middleware.

| Item | Current (Vercel) | Target (CF Workers + R2 + Neon) |
|---|---|---|
| Pro seats | 10 × $20 = $200/mo | Workers Paid $5/mo |
| Fast Data Transfer (1TB over) | ~$150/mo | R2 egress $0 |
| Edge requests (30M) | ~$56/mo | ~$15/mo |
| Functions + ISR + image opt | ~$180/mo | ~$25/mo (Workers CPU + Images) |
| Managed Postgres | ~$69/mo | Neon Scale $69/mo |
| Observability add-on | ~$100/mo | Included / Grafana Cloud free |
| **Total** | **~$755/mo** | **~$114/mo** |

**Savings:** ~$641/mo (~$7,690/yr, 85%).

**Payback on $3,000 fee:** under 5 months.

This is the shape most of our customers arrive in: the bill crossed
$500/mo, finance started asking about it, and the team already knows egress
pricing is the culprit — but nobody has two free weeks to move it.

---

## Scenario 4: High-traffic content/commerce site on Vercel

**Profile:** 1.5M monthly visitors, 10TB/mo transfer, marketing site +
storefront, 6 engineers.

| Item | Current (Vercel) | Target (CF Workers + R2 + Neon) |
|---|---|---|
| Pro seats | 6 × $20 = $120/mo | Workers Paid $5/mo |
| Fast Data Transfer (9TB over) | ~$1,350/mo | R2 + CF CDN egress $0 |
| Edge requests (100M) | ~$190/mo | ~$50/mo |
| Functions/compute | ~$300/mo | ~$40/mo |
| Image optimization | ~$50/mo | CF Images ~$15/mo |
| Database | ~$69/mo | Neon Scale $69/mo |
| Enterprise pressure | Sales calls begin | n/a |
| **Total** | **~$3,080/mo** | **~$180/mo** |

**Savings:** ~$2,900/mo (~$34,800/yr, 94%).

**Payback on $3,000 fee:** ~5 weeks.

At this traffic level Vercel pushes Enterprise (custom pricing, typically
$20k+/yr minimum). Egress is the whole story: Cloudflare charges $0 for
what Vercel bills $0.15/GB.

---

## Scenario 5: Bootstrapped API business on Heroku

**Profile:** 2 founders, REST API doing 10M requests/mo, worker dyno for
background jobs, Postgres.

| Item | Current (Heroku) | Target (Hetzner + Docker + Neon) |
|---|---|---|
| Web dyno | Standard-2X $50/mo | Hetzner CPX21 ~$8/mo |
| Worker dyno | Standard-1X $25/mo | Same VPS (Docker Compose) $0 |
| Postgres | Standard-0 $50/mo | Neon Launch $19/mo |
| Redis | Mini $15/mo | Same VPS $0 |
| Logging add-on | ~$10/mo | Included (Loki/journald) |
| **Total** | **~$150/mo** | **~$27/mo** |

**Savings:** ~$123/mo (~$1,480/yr, 82%).

**Payback on $3,000 fee:** ~24 months at this size, which is a hard sell on
cost alone. Worth doing if you are close to the next tier — this stack is one
growth spurt away from Scenario 6.

---

## Scenario 6: Production SaaS on Heroku (the step function)

**Profile:** 8-person team, B2B SaaS, traffic outgrew Standard dynos —
response times forced the jump to Performance.

| Item | Current (Heroku) | Target (Hetzner + Docker + Neon) |
|---|---|---|
| Web dynos | 2 × Performance-M $500/mo | Hetzner CCX23 dedicated ~$25/mo |
| Worker dynos | 2 × Standard-2X $100/mo | Same host / second CPX31 ~$14/mo |
| Postgres | Standard-2 $200/mo | Neon Scale $69/mo |
| Redis | Premium-0 $60/mo | Managed or self-host ~$10/mo |
| Add-ons (logs, metrics, scheduler) | ~$50/mo | ~$0–10/mo |
| **Total** | **~$910/mo** | **~$128/mo** |

**Savings:** ~$782/mo (~$9,380/yr, 86%).

**Payback on $3,000 fee:** under 4 months.

Heroku's pricing is a step function: the jump from Standard-2X ($50) to
Performance-M ($250) is 5x for roughly 2.5x the compute. Teams hit this
wall and pay it because migrating feels riskier than the bill. Taking that
risk off your plate for a fixed fee is the whole reason infralift exists.

---

## Scenario 7: Heroku shop moving to Cloudflare (API + static front)

**Profile:** 4 engineers, Rails/Node API on Heroku + separate static SPA,
moderate traffic, wants zero server management (not interested in a VPS).

| Item | Current (Heroku) | Target (CF Workers + Pages + Neon) |
|---|---|---|
| Web dyno | Standard-2X $50/mo | Workers Paid $5/mo |
| SPA hosting | Standard-1X $25/mo | CF Pages $0 |
| Postgres | Standard-0 $50/mo | Neon Launch $19/mo |
| SSL/domains add-ons | ~$5/mo | Included |
| **Total** | **~$130/mo** | **~$24/mo** |

**Savings:** ~$106/mo (~$1,270/yr, 82%).

**Payback on $3,000 fee:** ~28 months, so cost alone does not justify it. The
stronger reason here is platform risk: Heroku is in maintenance mode under
Salesforce, while the target stack is actively developed.

---

## Scenario 8: Vercel + Heroku split stack (frontend/backend divorce)

**Profile:** Common pattern — Next.js frontend on Vercel, API + jobs on
Heroku, two bills, two dashboards, 6 engineers.

| Item | Current | Target (unified: CF + Neon) |
|---|---|---|
| Vercel Pro seats | 6 × $20 = $120/mo | Workers Paid $5/mo |
| Vercel bandwidth/functions | ~$80/mo | ~$15/mo |
| Heroku dynos | $75/mo | Workers (API) $0 extra |
| Heroku Postgres | $50/mo | Neon Launch $19/mo |
| **Total** | **~$325/mo** | **~$39/mo** |

**Savings:** ~$286/mo (~$3,430/yr, 88%).

**Payback on $3,000 fee:** ~11 months, plus one platform instead of two.

---

## All eight, side by side

| Scenario | Current | After | Monthly savings | Annual savings | Payback ($3k fee) |
|---|---|---|---|---|---|
| 1. Solo dev (Vercel) | $39 | $5–24 | $15–34 | $180–408 | n/a |
| 2. 5-person startup (Vercel) | $197 | $34 | $163 | $1,960 | 18 mo |
| 3. Scaling SaaS (Vercel) | $755 | $114 | $641 | $7,690 | 4.7 mo |
| 4. High-traffic (Vercel) | $3,080 | $180 | $2,900 | $34,800 | 5 wk |
| 5. Bootstrapped API (Heroku) | $150 | $27 | $123 | $1,480 | 24 mo |
| 6. Production SaaS (Heroku) | $910 | $128 | $782 | $9,380 | 3.8 mo |
| 7. Heroku to Cloudflare | $130 | $24 | $106 | $1,270 | 28 mo |
| 8. Split stack (both) | $325 | $39 | $286 | $3,430 | 10.5 mo |

## What the numbers have in common

- **Egress is the villain (Vercel):** $0.15/GB vs $0 on Cloudflare. Every
  image-heavy or content site overpays by construction.
- **Per-seat pricing scales with headcount, not usage (Vercel):** hiring an
  engineer costs $20/mo in hosting before they ship anything.
- **The Performance dyno wall (Heroku):** 5x price jump for 2.5x compute;
  teams pay it because migration feels risky.
- **Maintenance-mode platform (Heroku):** paying premium prices for a
  product Salesforce stopped investing in.
- **Fixed fee vs open-ended DIY:** every scenario's alternative is "an
  engineer spends 2–4 weeks migrating" — at loaded cost that's $10k–30k of
  payroll plus risk. From-$3,000 fixed undercuts DIY even before savings.
