export default function Overview() {
  return (
    <>
      <h1>Overview</h1>
      <p className="lead">
        Connect a read-only provider token, run an assessment, and track your
        migration — everything delivered as Terraform in a repo you own.
      </p>

      <div className="grid grid-3">
        <div className="card">
          <h3>1. Connect a provider</h3>
          <p>
            Add a read-only token for Vercel, Cloudflare, Heroku, or an AWS
            ReadOnlyAccess role. Tokens are encrypted at rest and only used for
            read calls.
          </p>
          <a className="btn btn-primary" href="/connections">
            Connect provider
          </a>
        </div>
        <div className="card">
          <h3>2. Run your assessment</h3>
          <p>
            Inventory resources, project monthly costs, and get a fixed-fee
            migration quote in your report.
          </p>
          <a className="btn btn-secondary" href="/assessments">
            View assessments
          </a>
        </div>
        <div className="card">
          <h3>3. Track the migration</h3>
          <p>
            Follow each phase from repo setup through cutover and handoff, with
            links to your Terraform Cloud workspaces.
          </p>
          <a className="btn btn-secondary" href="/migrations">
            Migration status
          </a>
        </div>
      </div>
    </>
  );
}
