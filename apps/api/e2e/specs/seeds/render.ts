// The Render workspace Prism serves (sources.ts "render"). Only the fields
// connectors/render.ts reads, plus what makes a record recognizable;
// extract.ts fills every other required field from the response schema and
// checks the whole example against it. Render lists wrap each item with a
// pagination cursor.

export const RENDER_SEED = {
  owner: { id: "tea-e2e0000000000000000", name: "infralift e2e" },
  service: { id: "srv-e2e0000000000000001", name: "e2e-web" },
  postgres: { id: "dpg-e2e0000000000000002", name: "e2e-pg" },
  redis: { id: "red-e2e0000000000000003", name: "e2e-cache" },
  envGroup: { id: "evg-e2e0000000000000004", name: "e2e-shared" },
} as const;

export const RENDER_EXAMPLES: Record<string, unknown> = {
  "/owners": [{ cursor: "c1", owner: { id: RENDER_SEED.owner.id, name: RENDER_SEED.owner.name, email: "e2e@infralift-e2e-render.example", type: "team" } }],
  "/services": [
    {
      cursor: "c1",
      service: { id: RENDER_SEED.service.id, name: RENDER_SEED.service.name, type: "web_service", ownerId: RENDER_SEED.owner.id, repo: "https://github.com/infralift-e2e/web", autoDeploy: "yes" },
    },
  ],
  "/postgres": [
    { cursor: "c1", postgres: { id: RENDER_SEED.postgres.id, name: RENDER_SEED.postgres.name, databaseName: "app", plan: "basic_256mb", region: "oregon", version: "16", status: "available" } },
  ],
  "/redis": [{ cursor: "c1", redis: { id: RENDER_SEED.redis.id, name: RENDER_SEED.redis.name, plan: "starter", region: "oregon", status: "available" } }],
  // Env groups are listed bare, not wrapped with a cursor like the others.
  "/env-groups": [{ id: RENDER_SEED.envGroup.id, name: RENDER_SEED.envGroup.name, ownerId: RENDER_SEED.owner.id }],
};
