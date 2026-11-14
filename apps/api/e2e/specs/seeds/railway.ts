// The Railway account the provider fake serves (sources.ts "railway"):
// the GraphQL root value, executed against railway.graphql with the schema's
// own types, so a field the schema marks non-null must be present here.
// Only the fields connectors/railway.ts selects.

export const RAILWAY_SEED = {
  project: { id: "e2e0a0a0-0000-4000-8000-000000000301", name: "infralift-e2e" },
  service: { id: "e2e0a0a0-0000-4000-8000-000000000302", name: "web" },
  environment: { id: "e2e0a0a0-0000-4000-8000-000000000303", name: "production" },
} as const;

const edges = <T>(nodes: T[]) => ({ edges: nodes.map((node) => ({ node })) });

export const RAILWAY_GRAPHQL_ROOT = {
  me: { id: "e2e0a0a0-0000-4000-8000-0000000003aa" },
  projects: edges([
    {
      id: RAILWAY_SEED.project.id,
      name: RAILWAY_SEED.project.name,
      description: "infralift e2e project",
      environments: edges([{ id: RAILWAY_SEED.environment.id, name: RAILWAY_SEED.environment.name }]),
      services: edges([{ id: RAILWAY_SEED.service.id, name: RAILWAY_SEED.service.name, icon: null }]),
      // Railway removed plugins; the schema keeps the field, deprecated.
      plugins: edges([]),
    },
  ]),
};
