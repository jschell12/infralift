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
