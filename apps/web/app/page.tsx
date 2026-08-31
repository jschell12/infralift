import { DASHBOARD_URL, LEAD_FORM_ENABLED } from "../lib/links";
import { AssessmentForm } from "./assessment-form";

const CONTAINER = "max-w-[1080px] mx-auto px-6";
const CARD = "bg-surface border border-border rounded-xl p-6";
const SECTION = "py-18 border-t border-border";
const H2 = "text-[32px] font-bold tracking-[-0.02em] mb-3";
const LEAD = "text-muted text-[17px] max-w-[640px] mb-10";
const BTN =
  "inline-block px-7 py-3 rounded-lg text-base font-semibold cursor-pointer border border-transparent";

const NAV_LINKS = [
  { href: "#why", label: "Why now" },
  { href: "#scenarios", label: "Scenarios" },
  { href: "#how", label: "How it works" },
  { href: "#pricing", label: "Pricing" },
  { href: "#standards", label: "IaC standards" },
  { href: "/docs", label: "Docs" },
];

const WHY = [
  {
    title: "The Vercel inflection point",
    body: "A solo dev pays $20/mo. At 100k monthly users, that climbs to ~$400/mo on Vercel. The same workload self-hosted runs about $80/mo. Fast Data Transfer at $0.15/GB and edge requests at $2/M account for most of the difference.",
  },
  {
    title: "Firebase at scale",
    body: "Firestore charges per document read and write. A \u201clive\u201d dashboard with listeners, plus an AI feature reading the same data, causes read amplification that turns a $50/mo bill into thousands overnight. One team saw $70,000 in a single day.",
  },
  {
    title: "Heroku in maintenance mode",
    body: "Salesforce moved Heroku to sustaining engineering in early 2026. Same 30-second timeout, same two regions since 2011. You\u2019re still paying $25/dyno/mo. No new features or Enterprise contracts are coming.",
  },
];

type ScenarioTag = "vercel" | "heroku" | "both";

const TAG_STYLE: Record<ScenarioTag, string> = {
  vercel: "bg-info-dim text-info",
  heroku: "bg-tag-heroku-dim text-tag-heroku",
  both: "bg-tag-both-dim text-tag-both",
};

const TAG_LABEL: Record<ScenarioTag, string> = {
  vercel: "Vercel",
  heroku: "Heroku",
  both: "Both",
};

const SCENARIOS: {
  tag: ScenarioTag;
  title: string;
  body: string;
  beforeLabel: string;
  before: string;
  beforeDetail: string;
  after: string;
  afterDetail: string;
  savings: string;
  extra?: string;
}[] = [
  {
    tag: "vercel",
    title: "5-person funded startup",
    body: "Seed-stage SaaS, Next.js + API routes, 50k MAU, 500GB/mo transfer, preview deploys on every PR.",
    beforeLabel: "Vercel today",
    before: "$197",
    beforeDetail: "5 seats, bandwidth, functions, Postgres",
    after: "$34",
    afterDetail: "CF Workers + R2 + Neon",
    savings: "$1,960/yr",
    extra: "(83%)",
  },
  {
    tag: "vercel",
    title: "Scaling SaaS (the sweat zone)",
    body: "Series A, 10 engineers, 200k MAU, 2TB/mo transfer, image-heavy product with ISR + edge middleware.",
    beforeLabel: "Vercel today",
    before: "$755",
    beforeDetail: "10 seats, egress, functions, observability",
    after: "$114",
    afterDetail: "CF Workers + R2 + Neon",
    savings: "$7,690/yr",
    extra: "(85%) \u00b7 Payback under 5 months",
  },
  {
    tag: "vercel",
    title: "High-traffic content site",
    body: "1.5M monthly visitors, 10TB/mo transfer, marketing site + storefront, 6 engineers. Vercel starts calling about Enterprise.",
    beforeLabel: "Vercel today",
    before: "$3,080",
    beforeDetail: "Egress alone: $1,350/mo at $0.15/GB",
    after: "$180",
    afterDetail: "CF Workers + R2 (egress: $0)",
    savings: "$34,800/yr",
    extra: "(94%) \u00b7 Payback in 5 weeks",
  },
  {
    tag: "heroku",
    title: "Bootstrapped API business",
    body: "2 founders, REST API at 10M requests/mo, worker dyno for background jobs, Postgres + Redis.",
    beforeLabel: "Heroku today",
    before: "$150",
    beforeDetail: "2 dynos, Postgres, Redis, logging",
    after: "$27",
    afterDetail: "Hetzner VPS + Neon",
    savings: "$1,480/yr",
    extra: "(82%)",
  },
  {
    tag: "heroku",
    title: "Production SaaS (the step function)",
    body: "8-person team, B2B SaaS. Traffic outgrew Standard dynos, so they jumped to Performance-M: 5x the price for 2.5x the compute.",
    beforeLabel: "Heroku today",
    before: "$910",
    beforeDetail: "Performance dynos, Postgres, Redis, add-ons",
    after: "$128",
    afterDetail: "Hetzner dedicated + Neon",
    savings: "$9,380/yr",
    extra: "(86%) \u00b7 Payback under 4 months",
  },
  {
    tag: "both",
    title: "Split stack (Vercel + Heroku)",
    body: "Common pattern: Next.js frontend on Vercel, API + jobs on Heroku. Two bills, two dashboards, 6 engineers.",
    beforeLabel: "Combined today",
    before: "$325",
    beforeDetail: "Vercel seats + bandwidth + Heroku dynos",
    after: "$39",
    afterDetail: "Unified: CF Workers + Neon",
    savings: "$3,430/yr",
    extra: "(88%) \u00b7 One platform instead of two",
  },
];

const STEPS = [
  {
    title: "Connect read-only",
    body: "Create a read-only token for Vercel, Heroku, Netlify, Render, Railway, Fly.io, DigitalOcean, or Cloudflare. Or connect an AWS/GCP/Azure service account. Credentials are encrypted at rest, and the provider credential is never used to change anything.",
  },
  {
    title: "Assessment report",
    body: "We inventory your projects, services, databases, functions, domains, and storage. You get a migration plan with cost projections at three prices (list, year-1 after credits, steady state), a ranked recommendation, and risk notes.",
  },
  {
    title: "Fixed-fee migration",
    body: "We build the target environment in parallel, with zero downtime on your current stack, as Terraform in a new GitHub repo, with state in Terraform Cloud.",
  },
  {
    title: "Keep the platform",
    body: "After cutover the dashboard keeps working: your inventory, cost tracking, and assessments you can re-run as the stack changes. You own the repo and state either way.",
  },
];

const PLANS = [
  {
    name: "Assessment",
    price: "Free",
    unit: "",
    sub: "Read-only inventory + migration report",
    lines: [
      "Full resource inventory",
      "Cost projection at three prices",
      "Ranked target recommendation",
      "Risk & effort breakdown",
      "A fixed-fee quote, same day",
    ],
  },
  {
    name: "Migration",
    price: "from $3,000",
    unit: " fixed",
    sub: "Quoted from your assessment, before you commit",
    lines: [
      "Terraform repo you own",
      "Terraform Cloud workspaces",
      "Parallel build, zero downtime",
      "DNS + data cutover",
      "30-day post-cutover support",
    ],
  },
  {
    name: "Platform",
    price: "$99",
    unit: "/mo, optional",
    sub: "Keep the dashboard after migration",
    lines: [
      "Unlimited users",
      "Re-runnable assessments",
      "Migration options & IaC generation",
      "Cost tracking",
    ],
  },
];

export default function Home() {
  return (
    <>
      <header className={CONTAINER}>
        <nav className="flex items-center justify-between py-5">
          <div className="font-bold text-xl tracking-[-0.02em] text-text">
            infra<span className="text-accent">lift</span>
          </div>
          <div className="flex gap-6 items-center">
            {NAV_LINKS.map((l) => (
              <a
                key={l.href}
                href={l.href}
                className="text-muted text-[15px] hover:text-text"
              >
                {l.label}
              </a>
            ))}
          </div>
        </nav>
      </header>

      <main className={CONTAINER}>
        <section className="pt-24 pb-16 text-center">
          <div className="inline-block px-2.5 py-0.5 rounded-full bg-accent-dim text-accent text-[13px] font-semibold mb-4">
            Fixed fee. No hourly billing. Ever.
          </div>
          <h1 className="text-5xl font-bold leading-[1.15] tracking-[-0.03em] max-w-[800px] mx-auto mb-5">
            Your cloud bill shouldn&apos;t scale
            <br />
            faster than your revenue.
          </h1>
          <p className="text-xl text-muted max-w-[640px] mx-auto mb-9">
            Vercel, Heroku, and Firebase got you to launch. Now usage-based
            pricing is compounding. We assess what your stack costs today,
            show you what it would cost elsewhere, and migrate you to
            infrastructure you own for a fixed fee.
          </p>
          <div className="flex gap-3 justify-center">
            <a
              className={`${BTN} bg-accent text-bg`}
              href={LEAD_FORM_ENABLED ? "#assessment" : DASHBOARD_URL}
            >
              Get your free assessment
            </a>
            <a
              className={`${BTN} bg-transparent text-text border-border`}
              href="#why"
            >
              See why teams are moving
            </a>
          </div>
        </section>

        <section className={SECTION} id="why">
          <h2 className={H2}>Plan your exit before you need one</h2>
          <p className={LEAD}>
            Every platform starts cheap. The bill comes when your product works.
          </p>
          <div className="grid gap-5 grid-cols-1 md:grid-cols-3">
            {WHY.map((c) => (
              <div key={c.title} className={CARD}>
                <h3 className="text-lg font-semibold mb-2">{c.title}</h3>
                <p className="text-muted text-[15px]">{c.body}</p>
              </div>
            ))}
          </div>
          <div className="grid gap-5 grid-cols-1 md:grid-cols-2 mt-5">
            <div className={`${CARD} text-center`}>
              <div className="text-4xl font-bold text-accent tracking-[-0.02em] mb-2">
                $850 vs $80
              </div>
              <p className="text-muted text-[15px]">
                Monthly cost for a 10M req/mo API on Vercel Pro vs a comparable
                VPS. Per-seat pricing and Fast Data Transfer ($0.15/GB) are most
                of the gap.
              </p>
            </div>
            <div className={`${CARD} text-center`}>
              <div className="text-4xl font-bold text-accent tracking-[-0.02em] mb-2">
                12 providers
              </div>
              <p className="text-muted text-[15px]">
                Vercel, Heroku, Firebase, AWS, GCP, Azure, Netlify, Render,
                Railway, Fly.io, DigitalOcean, Cloudflare. We assess all of them.
              </p>
            </div>
          </div>
        </section>

        <section className={SECTION} id="scenarios">
          <h2 className={H2}>What teams actually pay</h2>
          <p className={LEAD}>
            Published 2026 pricing from Vercel and Heroku, compared against
            Cloudflare Workers + Neon or Hetzner + Docker + Neon.
          </p>

          <div className="grid gap-5 grid-cols-1 md:grid-cols-2">
            {SCENARIOS.map((s) => (
              <div key={s.title} className={`${CARD} flex flex-col gap-3`}>
                <span
                  className={`inline-block w-fit px-2.5 py-0.5 rounded-full text-xs font-semibold tracking-[0.02em] uppercase ${TAG_STYLE[s.tag]}`}
                >
                  {TAG_LABEL[s.tag]}
                </span>
                <h3 className="text-lg font-semibold">{s.title}</h3>
                <p className="text-muted text-[15px]">{s.body}</p>
                <div className="grid grid-cols-2 gap-3 mt-1">
                  <div className="flex flex-col gap-1 p-3.5 rounded-lg bg-danger/5 border border-danger/15">
                    <span className="text-xs font-semibold uppercase tracking-[0.04em] text-muted">
                      {s.beforeLabel}
                    </span>
                    <span className="text-[28px] font-bold leading-[1.1] text-danger-bright [font-variant-numeric:tabular-nums]">
                      {s.before}
                      <small className="text-sm font-normal text-muted">
                        /mo
                      </small>
                    </span>
                    <span className="text-[13px] text-muted leading-[1.3]">
                      {s.beforeDetail}
                    </span>
                  </div>
                  <div className="flex flex-col gap-1 p-3.5 rounded-lg bg-accent/5 border border-accent/15">
                    <span className="text-xs font-semibold uppercase tracking-[0.04em] text-muted">
                      After migration
                    </span>
                    <span className="text-[28px] font-bold leading-[1.1] text-accent [font-variant-numeric:tabular-nums]">
                      {s.after}
                      <small className="text-sm font-normal text-muted">
                        /mo
                      </small>
                    </span>
                    <span className="text-[13px] text-muted leading-[1.3]">
                      {s.afterDetail}
                    </span>
                  </div>
                </div>
                <div className="text-[15px] text-muted pt-1 border-t border-border mt-auto">
                  Save <strong className="text-accent font-bold">{s.savings}</strong>{" "}
                  {s.extra}
                </div>
              </div>
            ))}
          </div>

          <div className="mt-8 text-center">
            <p className="text-muted text-base max-w-[640px] mx-auto">
              The alternative in each case: an engineer spends 2-4 weeks on the
              migration. At loaded cost that&apos;s $10k-30k in payroll, plus
              the risk of getting it wrong. A fixed fee starting at $3,000 is
              cheaper than DIY before you count the monthly savings.
            </p>
            <p className="text-muted text-sm mt-6">
              Itemized cost breakdowns:{" "}
              <a href="/leaving/vercel">leaving Vercel</a> &middot;{" "}
              <a href="/leaving/heroku">Heroku</a> &middot;{" "}
              <a href="/leaving/render">Render</a> &middot;{" "}
              <a href="/leaving/railway">Railway</a> &middot;{" "}
              <a href="/leaving/digitalocean">DigitalOcean</a> &middot;{" "}
              <a href="/leaving/firebase">Firebase</a>
            </p>
          </div>
        </section>

        <section className={SECTION} id="how">
          <h2 className={H2}>How it works</h2>
          <p className={LEAD}>
            We never get write access to your current provider. The one
            credential that writes is a GitHub token, scoped to the repo that
            holds your Terraform.
          </p>
          <div className="grid gap-5 grid-cols-1 md:grid-cols-4">
            {STEPS.map((s, i) => (
              <div key={s.title} className={CARD}>
                <span className="inline-flex w-8 h-8 items-center justify-center rounded-full bg-accent-dim text-accent font-bold mb-3.5">
                  {i + 1}
                </span>
                <h3 className="text-lg font-semibold mb-2">{s.title}</h3>
                <p className="text-muted text-[15px]">{s.body}</p>
              </div>
            ))}
          </div>
        </section>

        <section className={SECTION} id="standards">
          <h2 className={H2}>Everything is infrastructure as code</h2>
          <p className={LEAD}>
            Every resource is Terraform, committed to your repo and planned
            through Terraform Cloud, with the apply gated behind your review.
            You own the repo and state. Fire us anytime and keep everything.
          </p>
          <div className="grid gap-5 grid-cols-1 md:grid-cols-2">
            <div className={CARD}>
              <h3 className="text-lg font-semibold mb-2">Standards you can read</h3>
              <p className="text-muted text-[15px]">
                Module layout, naming, tagging, remote state and review gates
                are written down, and the code we hand over follows them. The
                ruleset is published in the dashboard so you can hold us to it.
              </p>
            </div>
            <div className={CARD}>
              <h3 className="text-lg font-semibold mb-2">Nothing to unpick later</h3>
              <p className="text-muted text-[15px]">
                No console-clicked resources, no half-managed stack. Everything
                we build exists as code from the first apply, so the repo is the
                whole picture.
              </p>
            </div>
          </div>
        </section>

        <section className={SECTION} id="pricing">
          <h2 className={H2}>Pricing</h2>
          <p className={LEAD}>
            Assessment is free. Migration is a fixed fee quoted in the report:
            the price you see is the price you pay.
          </p>
          <div className="grid gap-5 grid-cols-1 md:grid-cols-3">
            {PLANS.map((p) => (
              <div key={p.name} className={CARD}>
                <h3 className="text-lg font-semibold mb-2">{p.name}</h3>
                <div className="text-4xl font-bold my-3">
                  {p.price}
                  <small className="text-[15px] font-normal text-muted">
                    {p.unit}
                  </small>
                </div>
                <p className="text-muted text-[15px]">{p.sub}</p>
                <div className="mt-4 flex flex-col">
                  {p.lines.map((line) => (
                    <div
                      key={line}
                      className="text-muted text-[15px] py-1.5 border-t border-border"
                    >
                      <span className="text-accent">&#10003;</span> {line}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>

        <div
          id="assessment"
          className="bg-surface border border-border rounded-2xl px-8 py-14 my-18"
        >
          <div className="mx-auto max-w-[620px]">
            <h2 className="text-3xl font-bold mb-3 text-center">
              The assessment is free. The report is yours to keep.
            </h2>
            <p className="text-muted mb-7 text-center">
              Tell us where you run today. We reply with what your stack costs,
              where it could run instead, and a fixed fee to move it. No
              obligation, and no account to create first.
            </p>
            {LEAD_FORM_ENABLED ? (
              <AssessmentForm />
            ) : (
              <div className="text-center">
                <a className={`${BTN} bg-accent text-bg`} href={DASHBOARD_URL}>
                  Start your free assessment
                </a>
              </div>
            )}
            <p className="mt-6 text-center text-[13px] text-faint">
              Already a customer?{" "}
              <a href={DASHBOARD_URL}>Sign in to the dashboard</a>.
            </p>
          </div>
        </div>
      </main>

      <footer
        className={`${CONTAINER} border-t border-border py-10 text-muted text-sm flex justify-between`}
      >
        <div>&copy; {new Date().getFullYear()} infralift</div>
        <div>Fixed-fee migrations, delivered as Terraform.</div>
      </footer>
    </>
  );
}
