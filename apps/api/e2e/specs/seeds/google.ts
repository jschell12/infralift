// The Google Cloud project Prism serves (sources.ts "google"), for both the
// GCP and the Firebase connector. Only the fields connectors/gcp.ts and
// connectors/firebase.ts read, plus what makes a record recognizable;
// extract.ts fills the rest from the response schema and checks the example
// against it. Resource names are under the seeded project, which is the
// project_id of the service account key the e2e test connects with.

export const GOOGLE_SEED = {
  projectId: "infralift-e2e",
  clientEmail: "infralift-e2e@infralift-e2e.iam.gserviceaccount.com",
} as const;

const project = `projects/${GOOGLE_SEED.projectId}`;

export const GOOGLE_NAMES = {
  runService: `${project}/locations/us-central1/services/e2e-run`,
  instance: { id: "1234567890123456789", name: "e2e-vm" },
  sqlInstance: "e2e-sql",
  bucket: "infralift-e2e-assets",
  function: `${project}/locations/us-central1/functions/e2e-fn`,
  hostingSite: `${project}/sites/infralift-e2e`,
  firestore: `${project}/databases/(default)`,
} as const;

export const GOOGLE_EXAMPLES: Record<string, unknown> = {
  // One location: Prism answers every location's services.list with the same
  // example, so a second location would list the service twice.
  "/v1/projects/{project}/locations": {
    locations: [{ name: `${project}/locations/us-central1`, locationId: "us-central1", displayName: "Iowa" }],
  },
  "/v2/projects/{project}/locations/{location}/services": {
    services: [{ name: GOOGLE_NAMES.runService, uri: "https://e2e-run-abc123-uc.a.run.app" }],
  },
  "/compute/v1/projects/{project}/aggregated/instances": {
    kind: "compute#instanceAggregatedList",
    items: {
      "zones/us-central1-a": {
        instances: [
          {
            id: GOOGLE_NAMES.instance.id,
            name: GOOGLE_NAMES.instance.name,
            machineType: `https://www.googleapis.com/compute/v1/${project}/zones/us-central1-a/machineTypes/e2-small`,
            status: "RUNNING",
          },
        ],
      },
    },
  },
  "/v1/projects/{project}/instances": {
    kind: "sql#instancesList",
    items: [
      {
        kind: "sql#instance",
        name: GOOGLE_NAMES.sqlInstance,
        project: GOOGLE_SEED.projectId,
        region: "us-central1",
        databaseVersion: "POSTGRES_16",
        state: "RUNNABLE",
        settings: { kind: "sql#settings", tier: "db-custom-1-3840", dataDiskSizeGb: "10" },
      },
    ],
  },
  "/storage/v1/b": {
    kind: "storage#buckets",
    items: [{ kind: "storage#bucket", id: GOOGLE_NAMES.bucket, name: GOOGLE_NAMES.bucket, location: "US", storageClass: "STANDARD" }],
  },
  "/v2/projects/{project}/locations/{location}/functions": {
    functions: [{ name: GOOGLE_NAMES.function, buildConfig: { runtime: "nodejs22" }, state: "ACTIVE" }],
  },
  "/v1beta1/projects/{project}/sites": {
    sites: [{ name: GOOGLE_NAMES.hostingSite, defaultUrl: "https://infralift-e2e.web.app", type: "DEFAULT_SITE" }],
  },
  "/v1/projects/{project}/databases": {
    databases: [{ name: GOOGLE_NAMES.firestore, locationId: "nam5", type: "FIRESTORE_NATIVE" }],
  },
};
