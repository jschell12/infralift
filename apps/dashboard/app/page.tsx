export default function Overview() {
  return (
    <>
      <h1 className="text-3xl font-bold tracking-tight mb-2">Overview</h1>
      <p className="text-muted mb-8">
        Connect a read-only provider token, run an assessment, and track your
        migration. Everything is delivered as Terraform in a repo you own.
      </p>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
        <div className="bg-surface border border-border rounded-xl p-6">
          <h3 className="text-base font-semibold mb-1.5">1. Connect a provider</h3>
          <p className="text-muted text-sm">
            Add a read-only token for Vercel, Cloudflare, Heroku, or an AWS
            ReadOnlyAccess role. Tokens are encrypted at rest and only used for
            read calls.
          </p>
          <a
            className="inline-block mt-4 px-7 py-3 rounded-lg text-base font-semibold cursor-pointer border border-transparent bg-accent text-bg hover:bg-accent/90"
            href="/connections"
          >
            Connect provider
          </a>
        </div>
        <div className="bg-surface border border-border rounded-xl p-6">
          <h3 className="text-base font-semibold mb-1.5">2. Run your assessment</h3>
          <p className="text-muted text-sm">
            Inventory resources, project monthly costs, and get a fixed-fee
            migration quote in your report.
          </p>
          <a
            className="inline-block mt-4 px-7 py-3 rounded-lg text-base font-semibold cursor-pointer border border-border bg-transparent text-text hover:bg-surface"
            href="/assessments"
          >
            View assessments
          </a>
        </div>
        <div className="bg-surface border border-border rounded-xl p-6">
          <h3 className="text-base font-semibold mb-1.5">3. Track the migration</h3>
          <p className="text-muted text-sm">
            Follow each phase from repo setup through cutover and handoff, with
            links to your Terraform Cloud workspaces.
          </p>
          <a
            className="inline-block mt-4 px-7 py-3 rounded-lg text-base font-semibold cursor-pointer border border-border bg-transparent text-text hover:bg-surface"
            href="/migrations"
          >
            Migration status
          </a>
        </div>
      </div>
    </>
  );
}
