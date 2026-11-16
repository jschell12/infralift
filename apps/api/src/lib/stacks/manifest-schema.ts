// JSON Schema for stack.json, the manifest every stack carries: the catalog's
// on disk and a team's in its own repository (ADR 0009). It describes the
// shape StackManifest in ./index.ts already has; the catalog manifest is tested
// against it so the two cannot drift.
//
// `modules` is optional and descriptive for now. A module manages one important
// resource (a database, a server) plus what exists only to serve it.
//
// `version` is the stack's release (ADR 0012). Every catalog stack has one,
// with a CHANGELOG.md beside its stack.json (catalog.test.ts holds both to
// it). It is optional here because a team stack is pinned by commit (ADR 0009)
// and registered team stacks predate the field.

const slug = { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,62}$" };
const text = { type: "string", minLength: 1, maxLength: 2000 };
const when = { type: "object", additionalProperties: { type: "string" } };
// MAJOR.MINOR.PATCH, digits only. A release is immutable and ordered, so
// pre-release and build suffixes are not accepted. Bounded and free of nested
// quantifiers, because team manifests are checked against this schema too.
export const STACK_RELEASE_PATTERN = "^(0|[1-9][0-9]{0,8})\\.(0|[1-9][0-9]{0,8})\\.(0|[1-9][0-9]{0,8})$";

/** True for a stack release such as "1.4.0". */
export function isStackRelease(value: unknown): value is string {
  return typeof value === "string" && new RegExp(STACK_RELEASE_PATTERN).test(value);
}

const named = {
  type: "object",
  required: ["slug", "name"],
  properties: { slug, name: text },
};

export const STACK_MANIFEST_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  // template, runtime and source describe an app and where its deploy setup
  // came from. An infrastructure stack (ADR 0010) has none of them.
  required: ["slug", "name", "description", "target", "deliveries", "inputSchema", "example", "rendered"],
  properties: {
    slug,
    name: text,
    version: { type: "string", pattern: STACK_RELEASE_PATTERN },
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
