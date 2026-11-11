// A faithful mock of one adoption, built as HTML rather than a screenshot so it
// costs no image bytes, cannot shift layout while loading, and reads as a real
// table to a screen reader.
//
// The words are the product's own: the check output is what the import check
// prints (apps/api/src/lib/import/check.ts) and the status pill is the label
// the dashboard's project page shows for an adopted module whose apply has not
// run yet. Only the resource names are invented, and the caption says so.

const ROWS = [
  { kind: "DNS record", name: "www.example.com", address: "cloudflare_dns_record.www" },
  { kind: "DNS record", name: "api.example.com", address: "cloudflare_dns_record.api" },
  { kind: "Worker", name: "api-gateway", address: "cloudflare_workers_script.api_gateway" },
  { kind: "Pages project", name: "site", address: "cloudflare_pages_project.site" },
  { kind: "R2 bucket", name: "assets", address: "cloudflare_r2_bucket.assets" },
];

export function AdoptionMock() {
  return (
    <figure className="mx-auto max-w-[920px]">
      <div className="overflow-hidden rounded-xl border border-border bg-surface">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <div className="font-semibold text-text">Adopt Cloudflare: example.com</div>
            <div className="text-[13px] text-muted">
              Import check on the adoption pull request
            </div>
          </div>
          <span className="rounded-full border border-warn/30 bg-warn/10 px-2.5 py-0.5 text-[13px] text-warn">
            adopted, not yet applied
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-left text-sm [font-variant-numeric:tabular-nums]">
            <caption className="sr-only">
              Resources found in the account, the Terraform address each one is
              imported to, and what the plan does to it
            </caption>
            <thead className="text-muted">
              <tr className="border-b border-border">
                <th scope="col" className="px-4 py-2.5 font-semibold">Resource</th>
                <th scope="col" className="px-4 py-2.5 font-semibold">Terraform address</th>
                <th scope="col" className="px-4 py-2.5 font-semibold">Plan</th>
              </tr>
            </thead>
            <tbody>
              {ROWS.map((r) => (
                <tr key={r.address} className="border-b border-border last:border-b-0">
                  <td className="px-4 py-2.5">
                    <span className="text-text">{r.name}</span>{" "}
                    <span className="text-muted">{r.kind}</span>
                  </td>
                  <td className="px-4 py-2.5 font-mono text-[13px] text-text">{r.address}</td>
                  <td className="px-4 py-2.5 text-accent">import</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="border-t border-border bg-bg px-4 py-3 font-mono text-[13px] leading-relaxed text-text">
          <p>
            <span className="text-accent">No changes.</span> All 5 resources
            match the code, so infralift can take this module over without
            touching anything.
          </p>
          <p className="text-muted">
            5 resource(s) will be imported into state on apply. Importing
            changes nothing that is running.
          </p>
        </div>
      </div>
      <figcaption className="mt-3 text-center text-sm text-muted">
        An adoption pull request&apos;s check, and the status the project page
        shows until the apply on merge has run. The resource names are
        examples.
      </figcaption>
    </figure>
  );
}
