export default function AdminOverview() {
  return (
    <>
      <h1 className="text-3xl font-bold tracking-tight mb-2">Admin</h1>
      <p className="text-muted mb-8">
        Internal tools for lead management and community monitoring.
      </p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        <a href="/leads" className="bg-surface border border-border rounded-xl p-6 hover:border-accent transition-colors">
          <h3 className="text-lg font-semibold mb-2">Leads</h3>
          <p className="text-muted text-sm">
            View classified posts from developer communities. Filter by billing
            pain, migration interest, or platform complaints.
          </p>
        </a>
        <a href="/communities" className="bg-surface border border-border rounded-xl p-6 hover:border-accent transition-colors">
          <h3 className="text-lg font-semibold mb-2">Communities</h3>
          <p className="text-muted text-sm">
            48 forums, subreddits, and Discords where your target audience
            discusses cloud costs and migrations.
          </p>
        </a>
      </div>
    </>
  );
}
