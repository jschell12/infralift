// ---------------------------------------------------------------------------
// The Cloudflare account the e2e stack pretends to have.
//
// extract.ts writes these as the examples of the Cloudflare operations the
// connector calls, after checking each one against that operation's response
// schema, and Prism (docker-compose.e2e.yml) answers with them. The e2e
// suite reads the same values to know what the unmanaged view should list.
// Ids are 32 hex characters because the connector and the adopter require
// that of account and zone ids.
// ---------------------------------------------------------------------------

export const CF_SEED = {
  token: { id: "e2e000000000000000000000000token", status: "active" },
  account: { id: "e2e00000000000000000000000000001", name: "infralift e2e" },
  zone: { id: "e2e00000000000000000000000000002", name: "infralift-e2e.example" },
  dnsRecord: { id: "e2e00000000000000000000000000003", name: "www.infralift-e2e.example", type: "A", content: "192.0.2.10" },
  r2Bucket: { name: "e2e-assets" },
  worker: { id: "e2e-worker" },
  pagesProject: { name: "e2e-site" },
} as const;

const page = (count: number) => ({ page: 1, per_page: 50, count, total_count: count, total_pages: 1 });
const envelope = (result: unknown, resultInfo?: unknown) => ({
  success: true,
  errors: [],
  messages: [],
  result,
  ...(resultInfo ? { result_info: resultInfo } : {}),
});

// Only what the connector reads, plus what makes the record recognizable.
// extract.ts fills every other required field from the response schema
// (fillRequired) before checking the whole example against it.
const account = { id: CF_SEED.account.id, name: CF_SEED.account.name };

/** GET responses by the description's path template. */
export const CF_EXAMPLES: Record<string, unknown> = {
  "/user/tokens/verify": envelope({ id: CF_SEED.token.id, status: CF_SEED.token.status }),
  // Cloudflare's description gives the account list's result_info no
  // total_pages (iam_result_info), so the seed has none; the connector then
  // reads the list as one page.
  "/accounts": envelope([account], { page: 1, per_page: 50, count: 1, total_count: 1 }),
  "/accounts/{account_id}/workers/scripts": envelope([{ id: CF_SEED.worker.id, modified_on: "2026-01-01T00:00:00Z" }]),
  "/accounts/{account_id}/pages/projects": envelope(
    [
      {
        name: CF_SEED.pagesProject.name,
        production_branch: "main",
        // Required objects whose project_name has a pattern the filler's "" fails.
        canonical_deployment: { project_name: CF_SEED.pagesProject.name },
        latest_deployment: { project_name: CF_SEED.pagesProject.name },
      },
    ],
    page(1)
  ),
  "/accounts/{account_id}/r2/buckets": envelope(
    { buckets: [{ name: CF_SEED.r2Bucket.name, creation_date: "2026-01-01T00:00:00Z", jurisdiction: "default" }] },
    { cursor: "", per_page: 20 }
  ),
  "/zones": envelope(
    [{ id: CF_SEED.zone.id, name: CF_SEED.zone.name, status: "active", account: { id: CF_SEED.account.id, name: CF_SEED.account.name } }],
    page(1)
  ),
  "/zones/{zone_id}/dns_records": envelope(
    [{ id: CF_SEED.dnsRecord.id, name: CF_SEED.dnsRecord.name, type: CF_SEED.dnsRecord.type, content: CF_SEED.dnsRecord.content, proxied: false, ttl: 1 }],
    { ...page(1), per_page: 100 }
  ),
};
