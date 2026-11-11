import { DASHBOARD_URL, LEAD_FORM_ENABLED } from "../lib/links";
import { ADOPTION_PROVIDERS, ASSESSED_PROVIDERS, listProviders } from "../lib/providers";
import { AdoptionMock } from "./adoption-mock";
import { AssessmentForm } from "./assessment-form";
import { CONTAINER, SiteFooter, SiteHeader } from "./site-chrome";

const CARD = "bg-surface border border-border rounded-xl p-6";
const SECTION = "py-14 md:py-18 border-t border-border";
const H2 = "text-[28px] md:text-[32px] text-balance font-bold tracking-[-0.02em] mb-3";
const LEAD = "text-muted text-[17px] max-w-[640px] mb-10";
const BTN =
  "inline-flex min-h-11 items-center justify-center px-7 py-3 rounded-lg text-base font-semibold cursor-pointer border border-transparent";

const FEATURES = [
  {
    title: "Find what nobody wrote down",
    body: "Connect a cloud account with a read-only credential. The assessment inventories what is running and lists what can be brought under Terraform, including the things someone clicked into existence two years ago.",
  },
  {
    title: "Adopt it without touching it",
    body: "infralift writes the import blocks and resource code, scans the generated file for secrets, and opens a pull request in your repo. Its check runs a plan and passes only when that plan changes nothing. Resources Terraform cannot import are listed with the reason.",
  },
  {
    title: "Plan on the PR, apply on merge",
    body: "From then on every change is a pull request that shows its plan. Merging plans and applies that exact plan in your repo's production environment, where you can require a reviewer. infralift never holds write access to your cloud.",
  },
  {
    title: "Catch drift every day",
    body: "Your CI runs a read-only plan of the default branch daily. The project page says what it found: drift detected, no drift, or adopted but not yet applied.",
  },
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

// Neutral on purpose: the tag says which platform, and colour coding three
// vendors added two hues the rest of the palette does not use.
const TAG_STYLE = "bg-bg border border-border text-muted";

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
    body: "Create a read-only token for Vercel, Heroku, Netlify, Render, Railway, Fly.io, DigitalOcean, or Cloudflare. Or connect a Google Cloud or Azure service account. Credentials are encrypted at rest, and the provider credential is never used to change anything.",
  },
  {
    title: "Assessment report",
    body: "We inventory your projects, services, databases, functions, domains, and storage. You get a migration plan with cost projections at three prices (list, year-1 after credits, steady state), a ranked recommendation, and risk notes.",
  },
  {
    title: "Fixed-fee migration",
    body: "We build the target environment in parallel. Your current stack keeps serving and we never write to it. You get Terraform in a new GitHub repo, with state in Terraform Cloud.",
  },
  {
    title: "Keep the platform",
    body: "After cutover the dashboard keeps working: your inventory, cost tracking, and assessments you can re-run as the stack changes. You own the repo and state either way.",
  },
];

const PLAN_LINES = [
  "Free assessment first, no card",
  "Adoption pull requests with a zero-change check",
  "Plan-on-PR and apply-on-merge workflows in your repo",
  "Daily drift status per project",
  "Re-runnable assessments and cost tracking",
  "Unlimited users",
];

// Against doing the same work by hand, because that is the comparison we can
// stand behind line by line. Every infralift cell is something the product
// does today.
const COMPARISON = [
  ["Find resources nobody wrote Terraform for", "Listed from a read-only scan", "Walk every console and region"],
  ["Write import blocks and resource code", "Generated per resource, with its import ID", "Look up each import ID format, write the HCL"],
  ["Prove the import changes nothing", "PR check fails unless the plan has 0 changes", "Run a plan locally and read it"],
  ["Keep secrets out of generated code", "Scanned with gitleaks before commit", "Up to whoever writes it"],
  ["Plan on PR, apply on merge", "Workflows written into your repo", "Build and maintain the CI yourself"],
  ["Drift", "Daily status on every project", "A scheduled job you build"],
];

const FAQ = [
  {
    q: "Does adopting a resource change it?",
    a: "No. The adoption pull request only imports. Its check runs a plan and fails unless the plan changes nothing, and merging records the resources in state. Importing changes nothing that is running.",
  },
  {
    q: "Which clouds can it adopt from?",
    a: `${listProviders(ADOPTION_PROVIDERS)}. For Cloudflare that covers DNS records, Workers, Pages projects and R2 buckets. Anything without a Terraform import mapping is listed with the reason instead of skipped silently. AWS adoption is built, but AWS connections are not open yet.`,
  },
  {
    q: "What access does infralift need?",
    a: "A read-only credential for the cloud account, and a GitHub token scoped to the repository that holds the Terraform. The apply runs in your own GitHub Actions, with credentials you put on its production environment, so infralift never holds write access to your cloud.",
  },
  {
    q: "Where does the Terraform state live?",
    a: "In a backend you pick when you set up the project: Terraform Cloud, or OpenTofu with state in an R2 bucket.",
  },
  {
    q: "What happens if I cancel?",
    a: "The Terraform, the workflows and the state are in your repository and your backend. You keep all of it.",
  },
  {
    q: "Do you still move apps off Vercel, Heroku and the rest?",
    a: "Yes, as a separate fixed-fee project quoted from the assessment, from $3,000. Targets are Hetzner and Cloudflare. We build in parallel and never write to your current stack; moving the database needs a write pause of minutes, sized from your data.",
  },
];

export default function Home() {
  return (
    <>
      <SiteHeader />

      <main className={CONTAINER}>
        <section className="pt-12 pb-12 text-center md:pt-20">
          <h1 className="mx-auto mb-5 max-w-[820px] text-4xl font-bold leading-[1.15] tracking-[-0.03em] text-balance md:text-5xl">
            Put the infrastructure you clicked together under Terraform
          </h1>
          <p className="mx-auto mb-8 max-w-[660px] text-lg text-muted md:text-xl">
            infralift finds what is running outside your Terraform, adopts it
            through a pull request whose plan has to show zero changes, and
            then manages it as code: plan on the PR, apply on merge, drift
            checked daily.
          </p>
          <div className="flex flex-col justify-center gap-3 sm:flex-row">
            {/* Scrolls rather than linking straight to the sign-in. That click
                target is an OAuth redirect off this domain, which is a
                surprising thing for a hero button to do before the page has
                said what signing in gets you. */}
            <a className={`${BTN} bg-accent text-bg hover:bg-accent/90`} href="#assessment">
              Find what is unmanaged
            </a>
            <a
              className={`${BTN} bg-transparent text-text border-border hover:border-muted`}
              href="#features"
            >
              See how adoption works
            </a>
          </div>
          <p className="mx-auto mt-4 max-w-[560px] text-sm text-muted">
            The assessment is free. It needs a Google or GitHub sign-in and a
            read-only credential, and nothing is written to your cloud.
          </p>
        </section>

        <section className="pb-14" aria-label="Product example">
          <AdoptionMock />
        </section>

        <section className={SECTION} id="features">
          <h2 className={H2}>From click-ops to code in one pull request</h2>
          <p className={LEAD}>
            Adoption is the start. After it merges, the resources are managed
            the same way as everything else in the repo.
          </p>
          <div className="grid gap-5 grid-cols-1 md:grid-cols-2">
            {FEATURES.map((f) => (
              <div key={f.title} className={CARD}>
                <h3 className="text-lg font-semibold mb-2">{f.title}</h3>
                <p className="text-muted text-[15px]">{f.body}</p>
              </div>
            ))}
          </div>
        </section>

        <section className={SECTION} id="standards">
          <h2 className={H2}>Everything is infrastructure as code</h2>
          <p className={LEAD}>
            Every resource is Terraform, committed to your repo and planned in
            CI, with the apply gated behind your review.
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
          <h2 className={H2}>One plan</h2>
          <p className={LEAD}>
            Start with the free assessment. Keep infralift managing what it
            adopted for a flat monthly price, however many people use it.
          </p>
          <div className="grid gap-5 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)]">
            <div className={`${CARD} flex flex-col`}>
              <h3 className="text-lg font-semibold">Platform</h3>
              <div className="my-3 text-4xl font-bold [font-variant-numeric:tabular-nums]">
                $99<small className="text-[15px] font-normal text-muted">/mo</small>
              </div>
              <ul className="mb-6 flex flex-col">
                {PLAN_LINES.map((line) => (
                  <li key={line} className="border-t border-border py-1.5 text-[15px] text-muted">
                    <span className="text-accent" aria-hidden>&#10003;</span> {line}
                  </li>
                ))}
              </ul>
              <a className={`${BTN} mt-auto bg-accent text-bg hover:bg-accent/90`} href={DASHBOARD_URL}>
                Start with the free assessment
              </a>
            </div>
            <div className="overflow-x-auto rounded-xl border border-border">
              <table className="w-full min-w-[560px] text-left text-[15px]">
                <caption className="sr-only">infralift compared with doing the same work by hand</caption>
                <thead className="bg-surface">
                  <tr>
                    <th scope="col" className="px-4 py-3 font-semibold">Work</th>
                    <th scope="col" className="px-4 py-3 font-semibold text-accent">infralift</th>
                    <th scope="col" className="px-4 py-3 font-semibold">By hand</th>
                  </tr>
                </thead>
                <tbody>
                  {COMPARISON.map(([work, us, manual]) => (
                    <tr key={work} className="border-t border-border align-top">
                      <th scope="row" className="px-4 py-3 font-normal text-text">{work}</th>
                      <td className="px-4 py-3 text-text">{us}</td>
                      <td className="px-4 py-3 text-muted">{manual}</td>
                    </tr>
                  ))}
                  <tr className="border-t border-border align-top">
                    <th scope="row" className="px-4 py-3 font-normal text-text">Cost</th>
                    <td className="px-4 py-3 text-text">$99/mo</td>
                    <td className="px-4 py-3 text-muted">Engineer time, every time</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
          <p className="mt-5 text-[15px] text-muted">
            A migration off a PaaS is a separate fixed fee, quoted in the
            assessment before you commit.{" "}
            <a href="#migrations">What a migration costs</a>
          </p>
        </section>

        <section className={SECTION} id="migrations">
          <h2 className={H2}>Moving off a PaaS too?</h2>
          <p className={LEAD}>
            Every platform starts cheap. The bill comes when your product works.
            infralift also moves apps onto Hetzner or Cloudflare for a fixed
            fee, delivered as the same kind of Terraform.
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
                {ASSESSED_PROVIDERS.length} providers
              </div>
              <p className="text-muted text-[15px]">
                {listProviders()}. The assessment connects to all of them
                today.
              </p>
            </div>
          </div>
        </section>

        <section className="pb-14 md:pb-18" id="scenarios">
          <h3 className="text-2xl font-bold tracking-[-0.02em] mb-3">What teams actually pay</h3>
          <p className={LEAD}>
            Published 2026 pricing from Vercel and Heroku, compared against
            Cloudflare Workers + Neon or Hetzner + Docker + Neon.
          </p>

          <div className="grid gap-5 grid-cols-1 md:grid-cols-2">
            {SCENARIOS.map((s) => (
              <div key={s.title} className={`${CARD} flex flex-col gap-3`}>
                <span
                  className={`inline-block w-fit px-2.5 py-0.5 rounded-full text-[13px] ${TAG_STYLE}`}
                >
                  {TAG_LABEL[s.tag]}
                </span>
                <h3 className="text-lg font-semibold">{s.title}</h3>
                <p className="text-muted text-[15px]">{s.body}</p>
                <div className="grid grid-cols-2 gap-3 mt-1">
                  <div className="flex flex-col gap-1 p-3.5 rounded-lg bg-danger/5 border border-danger/15">
                    <span className="text-[13px] text-muted">
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
                    <span className="text-[13px] text-muted">
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

        <section className="pb-14 md:pb-18" id="how">
          <h3 className="text-2xl font-bold tracking-[-0.02em] mb-3">How a migration works</h3>
          <p className={LEAD}>
            We never get write access to your current provider. The one
            credential that writes is a GitHub token, scoped to the repo that
            holds your Terraform.
          </p>
          <div className="grid gap-5 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
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

        <section className={SECTION} id="faq">
          <h2 className={H2}>Questions</h2>
          <div className="mt-6 max-w-[760px] divide-y divide-border border-y border-border">
            {FAQ.map((f) => (
              <details key={f.q} className="group">
                <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-4 py-3 text-base font-semibold text-text [&::-webkit-details-marker]:hidden">
                  {f.q}
                  <span aria-hidden className="text-muted group-open:rotate-45 transition-transform">+</span>
                </summary>
                <p className="pb-4 text-[15px] text-muted">{f.a}</p>
              </details>
            ))}
          </div>
        </section>

        <div
          id="assessment"
          className="bg-surface border border-border rounded-2xl px-5 py-10 my-14 sm:px-8 md:py-14 md:my-18 scroll-mt-4"
        >
          <div className="mx-auto max-w-[620px]">
            <h2 className="text-[28px] md:text-3xl text-balance font-bold mb-3 text-center">
              The assessment is free. The report is yours to keep.
            </h2>
            <p className="text-muted mb-7 text-center">
              Sign in, connect a read-only credential, and the report comes back
              with what is running, what can be brought under Terraform, and
              what it costs today. No card, no sales call.
            </p>
            <div className="text-center">
              <a className={`${BTN} bg-accent text-bg hover:bg-accent/90`} href={DASHBOARD_URL}>
                Start your free assessment
              </a>
              <p className="mt-3.5 text-sm text-muted">
                Sign in with Google or GitHub. Same button whether you are new
                or coming back.
              </p>
            </div>

            {/* Secondary path. Signing in means handing over a provider token,
                which is a bigger ask than most people will make on a first
                visit, so the form stays for anyone who would rather describe
                their stack and get a reply by email. */}
            {LEAD_FORM_ENABLED && (
              <div className="mt-11 border-t border-border pt-9">
                <h3 className="mb-1.5 text-lg font-semibold">
                  Not ready to connect an account?
                </h3>
                <p className="mb-6 text-[15px] text-muted">
                  Tell us where you run today and roughly what it costs. We will
                  come back by email with whether an assessment is worth your
                  time.
                </p>
                <AssessmentForm />
              </div>
            )}
          </div>
        </div>
      </main>

      <SiteFooter />
    </>
  );
}
