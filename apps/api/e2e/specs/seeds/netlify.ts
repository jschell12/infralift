// The Netlify account Prism serves (sources.ts "netlify"). Only the fields
// connectors/netlify.ts reads, plus what makes a record recognizable;
// extract.ts fills the rest from the response schema and checks the example
// against it. Forms are listed per site (/sites/{site_id}/forms).

export const NETLIFY_SEED = {
  site: { id: "e2e0a0a0-0000-4000-8000-000000000201", name: "infralift-e2e-site" },
  zone: { id: "e2e0zone00000000000000001", name: "infralift-e2e-netlify.example" },
  hook: { id: "e2e0hook00000000000000001" },
  form: { id: "e2e0form00000000000000001", name: "contact" },
} as const;

export const NETLIFY_EXAMPLES: Record<string, unknown> = {
  "/user": { id: "e2e0user00000000000000001", email: "e2e@infralift-e2e-netlify.example" },
  "/sites": [
    {
      id: NETLIFY_SEED.site.id,
      name: NETLIFY_SEED.site.name,
      custom_domain: "www.infralift-e2e-netlify.example",
      build_settings: { repo_url: "https://github.com/infralift-e2e/site", dir: "dist", cmd: "npm run build", functions_dir: "netlify/functions" },
    },
  ],
  "/dns_zones": [{ id: NETLIFY_SEED.zone.id, name: NETLIFY_SEED.zone.name, records: [] }],
  "/sites/{site_id}/forms": [{ id: NETLIFY_SEED.form.id, site_id: NETLIFY_SEED.site.id, name: NETLIFY_SEED.form.name, submission_count: 3 }],
  "/sites/{site_id}/build_hooks": [{ id: NETLIFY_SEED.hook.id, title: "deploy", branch: "main", url: "https://api.netlify.com/build_hooks/e2e0hook00000000000000001" }],
};
