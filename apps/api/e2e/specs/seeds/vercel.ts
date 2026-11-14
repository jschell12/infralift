// The Vercel account Prism serves (sources.ts "vercel"). Only the fields
// packages/collectors/vercel.mjs reads; extract.ts fills the rest from the
// response schema and checks the example against it. Prism serves one fixed
// example per operation, so the projects page says there is no next page:
// following pagination.next is covered by the collector's unit tests
// (src/connectors/vercel.test.ts), where pages can differ.

export const VERCEL_SEED = {
  user: { id: "e2e0user000000000000001", username: "infralift-e2e" },
  domain: { id: "dom_e2e0000000000000001", name: "infralift-e2e-vercel.example" },
  project: { id: "prj_e2e00000000000000000001", name: "infralift-e2e-app" },
} as const;

export const VERCEL_EXAMPLES: Record<string, unknown> = {
  "/v2/user": { user: { id: VERCEL_SEED.user.id, username: VERCEL_SEED.user.username, email: "e2e@infralift-e2e-vercel.example" } },
  "/v5/domains": {
    domains: [{ id: VERCEL_SEED.domain.id, name: VERCEL_SEED.domain.name, serviceType: "zeit.world" }],
    pagination: { count: 1, next: null, prev: null },
  },
  "/v10/projects": {
    projects: [
      {
        id: VERCEL_SEED.project.id,
        name: VERCEL_SEED.project.name,
        framework: "nextjs",
        nodeVersion: "22.x",
        serverlessFunctionRegion: "iad1",
        buildCommand: "pnpm build",
        outputDirectory: null,
        rootDirectory: "apps/web",
        installCommand: null,
        devCommand: null,
      },
    ],
    pagination: { count: 1, next: null },
  },
};
