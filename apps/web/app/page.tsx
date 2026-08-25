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
            <a href="#how">How it works</a>
            <a href="#pricing">Pricing</a>
            <a href="#standards">IaC standards</a>
            <a href="/docs">Docs</a>
            <a className="btn btn-primary" href={DASHBOARD_URL}>
              Start assessment
            </a>
          </div>
        </nav>
      </header>

      <main className="container">
        <section className="hero">
          <div className="badge">Fixed fee. No hourly billing. Ever.</div>
          <h1>
            Get off Vercel, Heroku, Firebase, or AWS.
            <br />
            Keep everything as Terraform.
          </h1>
          <p className="sub">
            Connect a read-only token and get a migration report with cost
            projections. We execute the migration onto Cloudflare or a VPS for
            a fixed fee, and every deliverable is Terraform in a repo you own.
          </p>
          <a className="btn btn-primary" href={DASHBOARD_URL}>
            Get your free assessment
          </a>
          <a className="btn btn-secondary" href="#how">
            See how it works
          </a>
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
                Create a read-only API token for Vercel, Heroku, or Cloudflare,
                an AWS ReadOnlyAccess role, or a Firebase/GCP Viewer service
                account. Credentials are encrypted at rest and never used to
                change anything.
              </p>
            </div>
            <div className="card">
              <div className="step-num">2</div>
              <h3>Assessment report</h3>
              <p>
                We inventory your projects, dynos, functions, domains, and
                add-ons, then produce a migration plan with monthly cost
                projections and risk notes.
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
                IaC standards enforcement, and Terraform Cloud workspace
                management. You own the repo either way.
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
                <li>Monthly cost projection</li>
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
                <li>Drift detection & alerts</li>
                <li>IaC standards enforcement</li>
                <li>Workspace management</li>
                <li>Cost tracking</li>
              </ul>
            </div>
          </div>
        </section>

        <div className="cta-panel">
          <h2>See what your stack costs, and what it should cost</h2>
          <p>
            The assessment is free, read-only, and takes minutes. The report is
            yours to keep even if you never hire us.
          </p>
          <a className="btn btn-primary" href={DASHBOARD_URL}>
            Start your assessment
          </a>
        </div>
      </main>

      <footer className="container footer">
        <div>© {new Date().getFullYear()} infralift</div>
        <div>Fixed-fee migrations, delivered as Terraform.</div>
      </footer>
    </>
  );
}
