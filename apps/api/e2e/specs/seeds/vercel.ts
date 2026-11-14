// The Vercel account Prism serves (sources.ts "vercel"). Only the fields
// packages/collectors/vercel.mjs reads; extract.ts fills the rest from the
// response schema and checks the example against it. There is no projects
// example: the collector lists projects at /v9/projects, which Vercel's
// description does not have (sources.ts records it as undocumented).

export const VERCEL_SEED = {
  user: { id: "e2e0user000000000000001", username: "infralift-e2e" },
  domain: { name: "infralift-e2e-vercel.example" },
} as const;

export const VERCEL_EXAMPLES: Record<string, unknown> = {
  "/v2/user": { user: { id: VERCEL_SEED.user.id, username: VERCEL_SEED.user.username, email: "e2e@infralift-e2e-vercel.example" } },
  "/v5/domains": {
    domains: [{ id: "dom_e2e0000000000000001", name: VERCEL_SEED.domain.name, serviceType: "zeit.world" }],
    pagination: { count: 1, next: null, prev: null },
  },
};
