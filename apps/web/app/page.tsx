const DASHBOARD_URL =
  process.env.NEXT_PUBLIC_DASHBOARD_URL ?? "http://localhost:3001";

export default function Home() {
  return (
    <>
      <header className="container">
        <nav className="nav">
          <div className="logo">
            infra<span>lift</span>
          </div>
          <div className="nav-links">
            <a href="#why">Why now</a>
            <a href="#scenarios">Scenarios</a>
            <a href="#how">How it works</a>
            <a href="#pricing">Pricing</a>
            <a href="#standards">IaC standards</a>
            <a href="/docs">Docs</a>
          </div>
        </nav>
      </header>

      <main className="container">
        <section className="hero">
          <div className="badge">Fixed fee. No hourly billing. Ever.</div>
          <h1>
            Your cloud bill shouldn&apos;t scale
            <br />
            faster than your revenue.
          </h1>
          <p className="sub">
            Vercel, Heroku, and Firebase are great for shipping your MVP. But
            usage-based pricing compounds fast. Get a free assessment showing
            what your stack costs today and what it&apos;ll cost at 10x, then
            migrate to infrastructure you own for a fixed fee.
          </p>
          <a className="btn btn-primary" href={DASHBOARD_URL}>
            Get your free assessment
          </a>
          <a className="btn btn-secondary" href="#why">
            See why teams are moving
          </a>
        </section>

        <section className="section" id="why">
          <h2>Plan your exit before you need one</h2>
          <p className="lead">
            Every platform starts cheap. The bill comes when your product works.
          </p>
          <div className="grid grid-3">
            <div className="card">
              <h3>The Vercel inflection point</h3>
              <p>
                A solo dev pays $20/mo. A growing startup with 100k monthly
                users averages $400/mo on Vercel vs $80/mo self-hosted on
                equivalent infrastructure. Fast Data Transfer ($0.15/GB) and
                Edge Requests ($2/M) are the line items that surprise you.
              </p>
            </div>
            <div className="card">
              <h3>Firebase at scale</h3>
              <p>
                Firestore charges per document read and write. A &ldquo;live&rdquo;
                dashboard with listeners, plus an AI feature reading the same
                data, causes read amplification that turns a $50/mo bill into
                thousands overnight. One team saw $70,000 in a single day.
              </p>
            </div>
            <div className="card">
              <h3>Heroku in maintenance mode</h3>
              <p>
                Salesforce moved Heroku into sustaining engineering in early
                2026. No new features, no new Enterprise contracts. Same
                30-second timeout and two regions since 2011. Paying
                $25/dyno/mo for a platform that stopped investing in itself.
              </p>
            </div>
          </div>
          <div className="grid grid-3" style={{ marginTop: 20 }}>
            <div className="card stat-card">
              <div className="stat">5x-10x</div>
              <p>
                cost savings reported by teams migrating high-traffic apps off
                Vercel to self-hosted infrastructure
              </p>
            </div>
            <div className="card stat-card">
              <div className="stat">$850 vs $80</div>
              <p>
                monthly cost for a 10M request/mo API backend on Vercel vs a
                VPS alternative
              </p>
            </div>
            <div className="card stat-card">
              <div className="stat">12</div>
              <p>
                source providers assessed: Vercel, Heroku, Firebase, AWS, GCP,
                Azure, Netlify, Render, Railway, Fly.io, DigitalOcean, and
                Cloudflare
              </p>
            </div>
          </div>
        </section>

        <section className="section" id="scenarios">
          <h2>Real numbers, real savings</h2>
          <p className="lead">
            These scenarios use published 2026 pricing from Vercel and Heroku.
            Savings are measured against Cloudflare Workers + Neon or Hetzner +
            Docker + Neon, depending on the migration target.
          </p>

          <div className="grid grid-2">
            <div className="card scenario-card">
              <div className="scenario-badge">Vercel</div>
              <h3>5-person funded startup</h3>
              <p>
                Seed-stage SaaS, Next.js + API routes, 50k MAU, 500GB/mo
                transfer, preview deploys on every PR.
              </p>
              <div className="scenario-compare">
                <div className="scenario-before">
                  <span className="scenario-label">Vercel today</span>
                  <span className="scenario-amount">$197<small>/mo</small></span>
                  <span className="scenario-detail">5 seats, bandwidth, functions, Postgres</span>
                </div>
                <div className="scenario-after">
                  <span className="scenario-label">After migration</span>
                  <span className="scenario-amount">$34<small>/mo</small></span>
                  <span className="scenario-detail">CF Workers + R2 + Neon</span>
                </div>
              </div>
              <div className="scenario-savings">
                Save <strong>$1,960/yr</strong> (83%)
              </div>
            </div>

            <div className="card scenario-card">
              <div className="scenario-badge">Vercel</div>
              <h3>Scaling SaaS (the sweat zone)</h3>
              <p>
                Series A, 10 engineers, 200k MAU, 2TB/mo transfer,
                image-heavy product with ISR + edge middleware.
              </p>
              <div className="scenario-compare">
                <div className="scenario-before">
                  <span className="scenario-label">Vercel today</span>
                  <span className="scenario-amount">$755<small>/mo</small></span>
                  <span className="scenario-detail">10 seats, egress, functions, observability</span>
                </div>
                <div className="scenario-after">
                  <span className="scenario-label">After migration</span>
                  <span className="scenario-amount">$114<small>/mo</small></span>
                  <span className="scenario-detail">CF Workers + R2 + Neon</span>
                </div>
              </div>
              <div className="scenario-savings">
                Save <strong>$7,690/yr</strong> (85%) &middot; Payback under 5 months
              </div>
            </div>

            <div className="card scenario-card">
              <div className="scenario-badge">Vercel</div>
              <h3>High-traffic content site</h3>
              <p>
                1.5M monthly visitors, 10TB/mo transfer, marketing site +
                storefront, 6 engineers. Vercel starts calling about Enterprise.
              </p>
              <div className="scenario-compare">
                <div className="scenario-before">
                  <span className="scenario-label">Vercel today</span>
                  <span className="scenario-amount">$3,080<small>/mo</small></span>
                  <span className="scenario-detail">Egress alone: $1,350/mo at $0.15/GB</span>
                </div>
                <div className="scenario-after">
                  <span className="scenario-label">After migration</span>
                  <span className="scenario-amount">$180<small>/mo</small></span>
                  <span className="scenario-detail">CF Workers + R2 (egress: $0)</span>
                </div>
              </div>
              <div className="scenario-savings">
                Save <strong>$34,800/yr</strong> (94%) &middot; Payback in 5 weeks
              </div>
            </div>

            <div className="card scenario-card">
              <div className="scenario-badge scenario-badge-heroku">Heroku</div>
              <h3>Bootstrapped API business</h3>
              <p>
                2 founders, REST API at 10M requests/mo, worker dyno for
                background jobs, Postgres + Redis.
              </p>
              <div className="scenario-compare">
                <div className="scenario-before">
                  <span className="scenario-label">Heroku today</span>
                  <span className="scenario-amount">$150<small>/mo</small></span>
                  <span className="scenario-detail">2 dynos, Postgres, Redis, logging</span>
                </div>
                <div className="scenario-after">
                  <span className="scenario-label">After migration</span>
                  <span className="scenario-amount">$27<small>/mo</small></span>
                  <span className="scenario-detail">Hetzner VPS + Neon</span>
                </div>
              </div>
              <div className="scenario-savings">
                Save <strong>$1,480/yr</strong> (82%)
              </div>
            </div>

            <div className="card scenario-card">
              <div className="scenario-badge scenario-badge-heroku">Heroku</div>
              <h3>Production SaaS (the step function)</h3>
              <p>
                8-person team, B2B SaaS. Traffic outgrew Standard dynos, so
                they jumped to Performance-M: 5x the price for 2.5x the compute.
              </p>
              <div className="scenario-compare">
                <div className="scenario-before">
                  <span className="scenario-label">Heroku today</span>
                  <span className="scenario-amount">$910<small>/mo</small></span>
                  <span className="scenario-detail">Performance dynos, Postgres, Redis, add-ons</span>
                </div>
                <div className="scenario-after">
                  <span className="scenario-label">After migration</span>
                  <span className="scenario-amount">$128<small>/mo</small></span>
                  <span className="scenario-detail">Hetzner dedicated + Neon</span>
                </div>
              </div>
              <div className="scenario-savings">
                Save <strong>$9,380/yr</strong> (86%) &middot; Payback under 4 months
              </div>
            </div>

            <div className="card scenario-card">
              <div className="scenario-badge scenario-badge-split">Both</div>
              <h3>Split stack (Vercel + Heroku)</h3>
              <p>
                Common pattern: Next.js frontend on Vercel, API + jobs on
                Heroku. Two bills, two dashboards, 6 engineers.
              </p>
              <div className="scenario-compare">
                <div className="scenario-before">
                  <span className="scenario-label">Combined today</span>
                  <span className="scenario-amount">$325<small>/mo</small></span>
                  <span className="scenario-detail">Vercel seats + bandwidth + Heroku dynos</span>
                </div>
                <div className="scenario-after">
                  <span className="scenario-label">After migration</span>
                  <span className="scenario-amount">$39<small>/mo</small></span>
                  <span className="scenario-detail">Unified: CF Workers + Neon</span>
                </div>
              </div>
              <div className="scenario-savings">
                Save <strong>$3,430/yr</strong> (88%) &middot; One platform instead of two
              </div>
            </div>
          </div>

          <div className="scenario-footnote">
            <p>
              Every scenario&apos;s alternative is an engineer spending 2-4 weeks
              migrating. At loaded cost, that&apos;s $10k-30k of payroll plus risk.
              A from-$3,000 fixed fee undercuts DIY before you count the savings.
            </p>
          </div>
        </section>

        <section className="section" id="how">
          <h2>How it works</h2>
          <p className="lead">
            Read-only access in, working infrastructure out. You never hand us
            write access to your current provider.
          </p>
          <div className="grid grid-4">
            <div className="card">
              <div className="step-num">1</div>
              <h3>Connect read-only</h3>
              <p>
                Create a read-only token for Vercel, Heroku, Netlify, Render,
                Railway, Fly.io, DigitalOcean, or Cloudflare. Or connect an
                AWS/GCP/Azure service account. Credentials are encrypted at
                rest and never used to change anything.
              </p>
            </div>
            <div className="card">
              <div className="step-num">2</div>
              <h3>Assessment report</h3>
              <p>
                We inventory your projects, services, databases, functions,
                domains, and storage. You get a migration plan with monthly
                cost projections at current and 10x scale, plus risk notes.
              </p>
            </div>
            <div className="card">
              <div className="step-num">3</div>
              <h3>Fixed-fee migration</h3>
              <p>
                We build the target environment in parallel, with zero downtime
                on your current stack, as Terraform in a new GitHub or GitLab
                repo with state in Terraform Cloud.
              </p>
            </div>
            <div className="card">
              <div className="step-num">4</div>
              <h3>Keep the platform</h3>
              <p>
                After cutover, the dashboard keeps working: drift visibility,
                IaC standards enforcement, and workspace management. You own
                the repo and state either way.
              </p>
            </div>
          </div>
        </section>

        <section className="section" id="standards">
          <h2>Everything is infrastructure as code</h2>
          <p className="lead">
            No console clicking, no snowflake servers. Every resource we create
            is Terraform, checked into your repo, planned and applied through
            Terraform Cloud.
          </p>
          <div className="grid grid-3">
            <div className="card">
              <h3>You own the repo</h3>
              <p>
                Deliverables live in your GitHub or GitLab org. Fire us
                anytime; the code, the state, and the docs stay with you. No
                lock-in by design.
              </p>
            </div>
            <div className="card">
              <h3>Standards enforced</h3>
              <p>
                Modules, naming, tagging, remote state, and review gates,
                enforced automatically on every change. Your infra stays clean
                after we leave.
              </p>
            </div>
            <div className="card">
              <h3>Drift visibility</h3>
              <p>
                If someone changes something in a console, you see it. The
                dashboard surfaces drift between Terraform state and reality.
              </p>
            </div>
          </div>
        </section>

        <section className="section" id="pricing">
          <h2>Pricing</h2>
          <p className="lead">
            Assessment is free. Migration is a fixed fee quoted in the report:
            the price you see is the price you pay.
          </p>
          <div className="grid grid-3">
            <div className="card">
              <h3>Assessment</h3>
              <div className="price">
                Free<small></small>
              </div>
              <p>Read-only inventory + migration report</p>
              <ul>
                <li>Full resource inventory</li>
                <li>Cost projection at current and 10x scale</li>
                <li>Fixed-fee migration quote</li>
                <li>Risk & effort breakdown</li>
              </ul>
            </div>
            <div className="card">
              <h3>Migration</h3>
              <div className="price">
                from $3,000<small> fixed</small>
              </div>
              <p>Quoted precisely in your assessment report</p>
              <ul>
                <li>Terraform repo you own</li>
                <li>Terraform Cloud workspaces</li>
                <li>Parallel build, zero downtime</li>
                <li>DNS + data cutover</li>
                <li>30-day post-cutover support</li>
              </ul>
            </div>
            <div className="card">
              <h3>Platform</h3>
              <div className="price">
                $99<small>/mo, optional</small>
              </div>
              <p>Keep the dashboard after migration</p>
              <ul>
                <li>Unlimited users</li>
                <li>Drift detection & alerts</li>
                <li>IaC standards enforcement</li>
                <li>Workspace management</li>
                <li>Cost tracking</li>
              </ul>
            </div>
          </div>
        </section>

        <div className="cta-panel">
          <h2>
            Start at $20/mo. Migrate at $200/mo. Not at $3,000/mo.
          </h2>
          <p>
            The assessment is free, read-only, and takes minutes. You get a
            report showing your current costs, projected costs at scale, and a
            fixed-fee quote to move. The report is yours even if you never hire
            us.
          </p>
          <a className="btn btn-primary" href={DASHBOARD_URL}>
            Start your free assessment
          </a>
        </div>
      </main>

      <footer className="container footer">
        <div>&copy; {new Date().getFullYear()} infralift</div>
        <div>Fixed-fee migrations, delivered as Terraform.</div>
      </footer>
    </>
  );
}
