import type { Adopter } from "./types.js";
import { tfName } from "./types.js";

// Resource names and import ids are those of the cloudflare/cloudflare v5
// provider, which codegen pins ("~> 5.0"). v4 named DNS records
// cloudflare_record and Workers cloudflare_worker_script; neither exists in v5.
//
//   cloudflare_zone            <zone_id>
//   cloudflare_dns_record      <zone_id>/<dns_record_id>
//   cloudflare_workers_script  <account_id>/<script_name>
//   cloudflare_pages_project   <account_id>/<project_name>
//   cloudflare_r2_bucket       <account_id>/<bucket_name>/<jurisdiction>

const ACCOUNT = /^[a-f0-9]{32}$/;
const NO_ACCOUNT =
  "assessed before infralift recorded the Cloudflare account id this import needs; run the assessment again";

const ACCOUNT_SCOPED: Record<string, string> = {
  "cloudflare:worker": "cloudflare_workers_script",
  "cloudflare:pages_project": "cloudflare_pages_project",
  "cloudflare:r2_bucket": "cloudflare_r2_bucket",
};

export const cloudflareAdopter: Adopter = {
  provider: "cloudflare",
  map(item) {
    const meta = item.metadata ?? {};
    if (item.type === "cloudflare:zone") return { to: `cloudflare_zone.${tfName(item.name)}`, id: item.externalId };
    if (item.type === "cloudflare:dns_record") {
      const zone = typeof meta.zoneId === "string" ? meta.zoneId : "";
      if (!zone) return { skip: "the DNS record has no zone id recorded" };
      const kind = typeof meta.recordType === "string" ? meta.recordType.toLowerCase() : "record";
      return { to: `cloudflare_dns_record.${tfName(`${kind}_${item.name}`)}`, id: `${zone}/${item.externalId}` };
    }
    const resource = ACCOUNT_SCOPED[item.type];
    if (!resource) return null;
    const account = typeof meta.accountId === "string" && ACCOUNT.test(meta.accountId) ? meta.accountId : null;
    if (!account) return { skip: NO_ACCOUNT };
    const id =
      item.type === "cloudflare:r2_bucket"
        ? `${account}/${item.name}/${typeof meta.jurisdiction === "string" && meta.jurisdiction ? meta.jurisdiction : "default"}`
        : `${account}/${item.name}`;
    return { to: `${resource}.${tfName(item.name)}`, id };
  },
};
