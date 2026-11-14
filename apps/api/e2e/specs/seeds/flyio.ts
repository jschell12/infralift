// The Fly.io organization the e2e stack serves: Machines API examples for
// Prism (sources.ts "flyio-machines") and the GraphQL root for the provider
// fake (sources.ts "flyio", executed against flyio.graphql). Only the fields
// connectors/flyio.ts reads, plus what makes a record recognizable.
// Prism answers every app's machines and volumes with the same lists, so the
// seed has one app.

export const FLY_SEED = {
  app: { id: "e2e0app0000000000001", name: "infralift-e2e-fly" },
  machine: { id: "e2e0machine0001", name: "e2e-machine" },
  volume: { id: "vol_e2e00000000000001", name: "e2e_data" },
} as const;

export const FLY_MACHINES_EXAMPLES: Record<string, unknown> = {
  "/v1/apps/{app_name}/machines": [
    {
      id: FLY_SEED.machine.id,
      name: FLY_SEED.machine.name,
      state: "started",
      region: "iad",
      config: { image: "registry.fly.io/infralift-e2e-fly:latest", guest: { cpu_kind: "shared", cpus: 1, memory_mb: 256 } },
    },
  ],
  "/v1/apps/{app_name}/volumes": [{ id: FLY_SEED.volume.id, name: FLY_SEED.volume.name, region: "iad", size_gb: 1, state: "created", encrypted: true }],
};

/** The GraphQL root value: queries are executed against it with the schema's
 *  own types, so a field the schema marks non-null must be present here. */
export const FLY_GRAPHQL_ROOT = {
  viewer: { __typename: "User", id: "e2e0user0000000000001" },
  apps: {
    nodes: [
      {
        id: FLY_SEED.app.id,
        name: FLY_SEED.app.name,
        status: "deployed",
        organization: { slug: "infralift-e2e" },
        regions: [{ code: "iad", name: "Ashburn, Virginia (US)" }],
      },
    ],
  },
};
