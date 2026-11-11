// JSON Schema for stack.json, the manifest every stack carries: the catalog's
// on disk and a team's in its own repository (ADR 0009). It describes the
// shape StackManifest in ./index.ts already has; the catalog manifest is tested
// against it so the two cannot drift.
//
// `modules` is optional and descriptive for now. A module manages one important
// resource (a database, a server) plus what exists only to serve it.

const slug = { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,62}$" };
const text = { type: "string", minLength: 1, maxLength: 2000 };
const when = { type: "object", additionalProperties: { type: "string" } };
const named = {
  type: "object",
  required: ["slug", "name"],
  properties: { slug, name: text },
};

export const STACK_MANIFEST_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  required: [
    "slug",
    "name",
    "description",
    "template",
    "target",
    "runtime",
    "deliveries",
    "source",
    "inputSchema",
    "example",
    "rendered",
  ],
  properties: {
    slug,
    name: text,
    description: text,
    template: {
      type: "object",
      required: ["slug", "name", "description", "repo"],
      properties: { slug, name: text, description: text, repo: text },
    },
    target: named,
    runtime: named,
    deliveries: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["slug", "name", "gitHost"],
        properties: { slug, name: text, gitHost: { enum: ["github", "gitlab"] } },
      },
    },
    source: {
      type: "object",
      required: ["repo", "commit"],
      properties: { repo: text, commit: text },
    },
    inputSchema: { type: "object" },
    example: { type: "object" },
    rendered: {
      type: "array",
      items: {
        type: "object",
        required: ["path", "template"],
        properties: { path: text, template: text, when },
      },
    },
    exclude: {
      type: "array",
      items: { type: "object", required: ["prefix"], properties: { prefix: text, when } },
    },
    seed: { type: "array", items: text },
    modules: {
      type: "array",
      items: {
        type: "object",
        required: ["name", "path", "anchor"],
        additionalProperties: false,
        properties: {
          name: slug,
          path: text,
          description: text,
          anchor: { type: "string", pattern: "^[a-z0-9_]+$" },
          inputs: { type: "array", items: text },
          outputs: { type: "array", items: text },
        },
      },
    },
  },
} as const;
