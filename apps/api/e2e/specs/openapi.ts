// ---------------------------------------------------------------------------
// Working with a vendor's OpenAPI description: find an operation, validate a
// request or response body against it, and fill a partial response out to
// one the description accepts.
//
// Used by the GitHub fake (to answer in GitHub's documented shapes and to
// refuse requests GitHub would refuse) and by the extractor (to check the
// Cloudflare examples it seeds). The descriptions themselves are subsets of
// the vendors' published ones at a pinned commit, written by extract.ts.
// ---------------------------------------------------------------------------

import { Ajv, type ValidateFunction } from "ajv";

export type Schema = Record<string, any>;
export interface OpenApiDocument {
  openapi: string;
  paths: Record<string, Record<string, any>>;
  components?: Record<string, Record<string, Schema>>;
  [key: string]: unknown;
}

export const HTTP_METHODS = ["get", "put", "post", "delete", "patch", "head"] as const;

/** One operation as a caller names it: method and the description's path template. */
export interface OperationRef {
  method: (typeof HTTP_METHODS)[number];
  path: string;
}

/** Resolves a local "#/components/..." reference, following chains. */
export function deref(doc: OpenApiDocument, schema: Schema | undefined): Schema | undefined {
  let s = schema;
  for (let hops = 0; s && typeof s.$ref === "string" && hops < 20; hops++) {
    const parts = s.$ref.replace(/^#\//, "").split("/").map((p: string) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
    let node: any = doc;
    for (const p of parts) node = node?.[p];
    s = node;
  }
  return s;
}

export function operation(doc: OpenApiDocument, ref: OperationRef): Schema {
  const op = doc.paths[ref.path]?.[ref.method];
  if (!op) throw new Error(`${ref.method.toUpperCase()} ${ref.path} is not in this description`);
  return op;
}

/** The JSON schema of a response, or null when that status has no JSON body
 *  (204, a redirect). Throws when the status is not documented at all: an
 *  undocumented status is itself a departure from the vendor's contract. */
export function responseSchema(doc: OpenApiDocument, ref: OperationRef, status: number): Schema | null {
  const op = operation(doc, ref);
  const response = deref(doc, op.responses?.[String(status)] ?? op.responses?.default);
  if (!response) throw new Error(`${ref.method.toUpperCase()} ${ref.path} does not document a ${status} response`);
  const content = response.content ?? {};
  const json = content["application/json"] ?? Object.entries(content).find(([type]) => type.includes("json"))?.[1];
  return json?.schema ?? null;
}

export function requestSchema(doc: OpenApiDocument, ref: OperationRef): Schema | null {
  const body = deref(doc, operation(doc, ref).requestBody);
  return body?.content?.["application/json"]?.schema ?? null;
}

/** JSON Schema validation against a description. Formats are not checked
 *  (dates and URIs are strings to the fake); everything else is. */
export class SpecValidator {
  private readonly ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });
  private readonly cache = new Map<Schema, ValidateFunction>();

  constructor(private readonly doc: OpenApiDocument) {
    // Registered once, so "#/components/..." inside any schema resolves.
    this.ajv.addSchema({ components: nullableToJsonSchema(doc.components ?? {}) }, "spec");
  }

  /** null when `value` matches `schema`, else the first few errors as text. */
  check(schema: Schema, value: unknown): string | null {
    let validate = this.cache.get(schema);
    if (!validate) {
      validate = this.ajv.compile(rebase(schema));
      this.cache.set(schema, validate);
    }
    if (validate(value)) return null;
    return (validate.errors ?? [])
      .slice(0, 5)
      .map((e) => `${e.instancePath || "(root)"} ${e.message}`)
      .join("; ");
  }

  get document(): OpenApiDocument {
    return this.doc;
  }
}

/** A schema whose local refs point into the registered "spec" document. */
function rebase(schema: Schema): Schema {
  return nullableToJsonSchema(JSON.parse(JSON.stringify(schema).replace(/"\$ref":"#\//g, '"$ref":"spec#/')));
}

/** OpenAPI 3.0's `nullable: true` on a schema with no `type` (a $ref, an
 *  allOf) as JSON Schema: anyOf the schema or null. Ajv handles nullable
 *  only beside a type. */
function nullableToJsonSchema<T>(node: T): T {
  if (Array.isArray(node)) return node.map(nullableToJsonSchema) as T;
  if (!node || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) out[k] = nullableToJsonSchema(v);
  if (out.nullable === true && out.type === undefined) {
    const { nullable, ...rest } = out;
    return { anyOf: [rest, { type: "null" }] } as T;
  }
  return out as T;
}

// -- filling a partial response ------------------------------------------------

export const FILL_DATE = "2026-01-01T00:00:00Z";

/**
 * `value` with every missing required property filled from `schema`, so the
 * fake sets only the fields infralift reads and the description supplies the
 * rest. A filled value is the plainest one the schema allows: null where it
 * is nullable, else the default, the first enum value, "", 0, false, [] or an
 * object filled the same way. Formats get a fixed date or a URL under
 * example.invalid. Deterministic: the same input always fills the same way.
 */
export function fillRequired(doc: OpenApiDocument, schema: Schema | undefined, value: unknown, depth = 0): unknown {
  const s = flatten(doc, schema, value);
  if (!s || depth > 14) return value ?? null;
  if (value === undefined) return plainest(doc, s, depth);
  if (Array.isArray(value)) return s.items ? value.map((v) => fillRequired(doc, s.items, v, depth + 1)) : value;
  if (value && typeof value === "object" && (s.properties || s.type === "object")) {
    const out: Record<string, unknown> = { ...(value as Record<string, unknown>) };
    for (const [key, prop] of Object.entries<Schema>(s.properties ?? {})) {
      if (key in out) out[key] = fillRequired(doc, prop, out[key], depth + 1);
      else if ((s.required ?? []).includes(key)) out[key] = fillRequired(doc, prop, undefined, depth + 1);
    }
    // Required with no schema of its own (Cloudflare's DNS record requires
    // `data` on every type, and describes it only on some): any value passes.
    for (const key of s.required ?? []) if (!(key in out)) out[key] = null;
    return out;
  }
  return value;
}

function plainest(doc: OpenApiDocument, s: Schema, depth: number): unknown {
  if (s.nullable) return null;
  if ("default" in s) return s.default;
  if (Array.isArray(s.enum) && s.enum.length) return s.enum[0];
  let type = s.type ?? (s.properties ? "object" : undefined);
  // JSON Schema type arrays (OpenAPI 3.1, Heroku's draft-04): null if allowed,
  // else the first type.
  if (Array.isArray(type)) {
    if (type.includes("null")) return null;
    type = type[0];
  }
  switch (type) {
    case "string":
      if (s.format === "date-time") return FILL_DATE;
      if (s.format === "uri" || s.format === "uri-template") return "https://example.invalid/";
      if (s.format === "email") return "fake@example.invalid";
      return "";
    case "integer":
    case "number":
      return typeof s.minimum === "number" ? s.minimum : 0;
    case "boolean":
      return false;
    case "array":
      return [];
    case "object":
      return fillRequired(doc, s, {}, depth + 1);
    default:
      return null;
  }
}

/**
 * One schema from allOf (every part merged), oneOf/anyOf (the branch that
 * fits `value`, nullable if any branch is null) and $ref chains. A branch
 * fits when each enum-constrained property `value` sets is one of that
 * property's values, which is how a DNS record's `type: "A"` picks the A
 * record branch; with nothing to go on, the first branch.
 */
function flatten(doc: OpenApiDocument, schema: Schema | undefined, value?: unknown): Schema | undefined {
  const s = deref(doc, schema);
  if (!s) return s;
  if (Array.isArray(s.allOf)) {
    const { allOf, ...rest } = s;
    const merged: Schema = { ...rest, properties: { ...(rest.properties ?? {}) }, required: [...(rest.required ?? [])] };
    for (const part of allOf.map((p: Schema) => flatten(doc, p, value))) {
      if (!part) continue;
      const { properties, required, ...keys } = part;
      Object.assign(merged, keys);
      Object.assign(merged.properties, properties ?? {});
      merged.required.push(...(required ?? []));
    }
    if (!merged.type && Object.keys(merged.properties).length) merged.type = "object";
    return merged;
  }
  const branches = s.oneOf ?? s.anyOf;
  if (Array.isArray(branches)) {
    const { oneOf, anyOf, ...rest } = s;
    const resolved = branches.map((b: Schema) => flatten(doc, b, value)).filter(Boolean) as Schema[];
    const nullable = s.nullable || resolved.some((b) => b.type === "null" || b.nullable);
    const candidates = resolved.filter((b) => b.type !== "null");
    const chosen = candidates.find((b) => fits(doc, b, value)) ?? candidates[0] ?? {};
    return { ...rest, ...chosen, ...(nullable ? { nullable: true } : {}) };
  }
  return s;
}

function fits(doc: OpenApiDocument, branch: Schema, value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return true;
  for (const [key, v] of Object.entries(value)) {
    const prop = deref(doc, branch.properties?.[key]);
    if (Array.isArray(prop?.enum) && !prop.enum.includes(v)) return false;
  }
  return true;
}

// -- fields the description does not declare --------------------------------------

/**
 * Every property in `value` that `schema` does not declare, as a JSON path.
 * Validation alone cannot catch an invented field: most vendor schemas leave
 * additionalProperties open, so a field the vendor never sends passes. This
 * is the check that does: a seed or a recorded fixture may only carry fields
 * the vendor documents. A property counts as declared when any allOf, oneOf
 * or anyOf branch declares it. An object is open (anything goes) when its
 * schema declares no properties at all, or says additionalProperties: true;
 * an additionalProperties schema is applied to the undeclared keys instead.
 */
export function undeclaredFields(doc: OpenApiDocument, schema: Schema | undefined, value: unknown, path = "$"): string[] {
  if (value === null || typeof value !== "object" || !schema) return [];
  const parts = branches(doc, schema);
  if (Array.isArray(value)) {
    const items = parts.map((p) => p.items).find(Boolean);
    return items ? value.flatMap((v, i) => undeclaredFields(doc, items, v, `${path}[${i}]`)) : [];
  }
  const declared = new Map<string, Schema[]>();
  let extra: Schema | undefined;
  let open = true;
  for (const p of parts) {
    if (p.properties) {
      open = false;
      for (const [k, v] of Object.entries<Schema>(p.properties)) declared.set(k, [...(declared.get(k) ?? []), v]);
    }
    if (p.additionalProperties === true) return [];
    if (p.additionalProperties && typeof p.additionalProperties === "object") extra = p.additionalProperties;
  }
  if (open && !extra) return [];
  const out: string[] = [];
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    const candidates = declared.get(key) ?? (extra ? [extra] : null);
    if (!candidates) {
      out.push(`${path}.${key}`);
      continue;
    }
    // Declared by several branches: undeclared below only if every branch says so.
    const nested = candidates.map((c) => undeclaredFields(doc, c, v, `${path}.${key}`));
    out.push(...nested.reduce((a, b) => a.filter((x) => b.includes(x))));
  }
  return out;
}

/** A schema's own part plus every allOf/oneOf/anyOf branch, refs followed. */
function branches(doc: OpenApiDocument, schema: Schema, depth = 0): Schema[] {
  const s = deref(doc, schema);
  if (!s || depth > 10) return [];
  const out: Schema[] = [s];
  for (const key of ["allOf", "oneOf", "anyOf"]) {
    if (Array.isArray(s[key])) for (const b of s[key]) out.push(...branches(doc, b, depth + 1));
  }
  return out;
}
