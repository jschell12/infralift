// ---------------------------------------------------------------------------
// Vendor descriptions that are not OpenAPI 3, as OpenAPI, so Prism can serve
// them and SpecValidator can check against them.
//
//   swagger2ToOpenApi    Swagger 2.0 (Netlify, Azure), after bundle.ts
//   discoveryToOpenApi   Google API discovery documents (GCP, Firebase)
//   hyperSchemaToOpenApi JSON Hyper-Schema (Heroku's Platform API)
//
// Each converts only what infralift's calls need: GET operations, their path
// and query parameters, and the 200 response's schema with everything it
// references. Nothing is added that the vendor's document does not say; where
// a format has no OpenAPI equivalent the field is dropped rather than guessed.
// ---------------------------------------------------------------------------

import type { Bundled } from "./bundle.js";
import type { OpenApiDocument, Schema } from "./openapi.js";

// -- Swagger 2.0 ------------------------------------------------------------------

/** A Swagger 2.0 non-body parameter as an OpenAPI 3 parameter. */
function swaggerParameter(p: Schema): Schema {
  const { name, in: where, required, description, type, format, items, enum: values, default: dflt, minimum, maximum, pattern, collectionFormat, ...rest } = p;
  const schema: Schema = { type, format, items, enum: values, default: dflt, minimum, maximum, pattern };
  for (const k of Object.keys(schema)) if (schema[k] === undefined) delete schema[k];
  void collectionFormat;
  const out: Schema = { name, in: where, required: required === true || where === "path", schema };
  if (description) out.description = description;
  for (const [k, v] of Object.entries(rest)) if (k.startsWith("x-")) out[k] = v;
  return out;
}

/** Swagger 2.0's x-nullable as OpenAPI 3.0's nullable, everywhere in a schema. */
function swaggerSchema<T>(node: T): T {
  if (Array.isArray(node)) return node.map(swaggerSchema) as T;
  if (!node || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === "x-nullable") out.nullable = v;
    else if (k === "$ref" && typeof v === "string") out.$ref = v.replace("#/definitions/", "#/components/schemas/");
    else out[k] = swaggerSchema(v);
  }
  return out as T;
}

/** A bundled Swagger 2.0 description (bundle.ts) as OpenAPI 3.0. */
export function swagger2ToOpenApi(bundled: Bundled): OpenApiDocument {
  const paths: OpenApiDocument["paths"] = {};
  for (const [path, item] of Object.entries(bundled.paths)) {
    const outItem: Record<string, any> = {};
    const shared = ((item.parameters as Schema[]) ?? []).filter((p) => p.in !== "body");
    for (const [method, op] of Object.entries(item) as [string, Schema][]) {
      if (method === "parameters") continue;
      const own = ((op.parameters as Schema[]) ?? []).filter((p) => p.in !== "body");
      const byKey = new Map<string, Schema>();
      for (const p of [...shared, ...own]) byKey.set(`${p.in}:${p.name}`, p);
      const responses: Record<string, unknown> = {};
      for (const [status, res] of Object.entries<Schema>(op.responses ?? {})) {
        responses[status] = {
          description: res.description ?? "",
          ...(res.schema ? { content: { "application/json": { schema: swaggerSchema(res.schema) } } } : {}),
        };
      }
      const { parameters, responses: _r, produces, consumes, ...rest } = op;
      void parameters;
      void _r;
      void produces;
      void consumes;
      outItem[method] = { ...rest, parameters: [...byKey.values()].map(swaggerParameter), responses };
    }
    paths[path] = outItem;
  }
  return {
    openapi: "3.0.3",
    info: bundled.info,
    paths,
    components: { schemas: swaggerSchema(bundled.schemas) as Record<string, Schema> },
  };
}

// -- Google discovery documents ----------------------------------------------------

/** One discovery method, named by its id, served at an OpenAPI path template.
 *  The template is infralift's: discovery paths are `{+parent}` expansions
 *  ("v2/{+parent}/services") that OpenAPI cannot express. */
export interface DiscoveryOperation {
  id: string;
  path: string;
}

type Discovery = Record<string, any>;

function findMethod(doc: Discovery, id: string): Discovery {
  const walk = (resources: Record<string, Discovery> | undefined): Discovery | undefined => {
    for (const r of Object.values(resources ?? {})) {
      for (const m of Object.values<Discovery>(r.methods ?? {})) if (m.id === id) return m;
      const found = walk(r.resources);
      if (found) return found;
    }
    return undefined;
  };
  const method = walk(doc.resources);
  if (!method) throw new Error(`${id} is not in the ${doc.name} ${doc.version} discovery document`);
  return method;
}

/** A discovery schema as JSON Schema: "$ref": "Name" points into components,
 *  "any" is any value, and the discovery-only keys are dropped. */
function discoverySchema(node: unknown, prefix: string, refs: Set<string>): unknown {
  if (Array.isArray(node)) return node.map((n) => discoverySchema(n, prefix, refs));
  if (!node || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === "id" || k === "enumDescriptions" || k === "enumDeprecated" || k === "annotations" || k === "location") continue;
    if (k === "$ref" && typeof v === "string") {
      refs.add(v);
      out.$ref = `#/components/schemas/${prefix}${v}`;
    } else if (k === "type" && v === "any") {
      continue;
    } else if (k === "properties" || k === "additionalProperties" || k === "items") {
      out[k] = k === "properties" ? Object.fromEntries(Object.entries(v as object).map(([p, s]) => [p, discoverySchema(s, prefix, refs)])) : discoverySchema(v, prefix, refs);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** The listed methods of each discovery document as one OpenAPI 3.0 document.
 *  Schema names are prefixed with the API's name ("run_", "storage_"), since
 *  Google's APIs reuse names like Status for different shapes. */
export function discoveryToOpenApi(docs: { doc: Discovery; operations: DiscoveryOperation[] }[]): OpenApiDocument {
  const paths: OpenApiDocument["paths"] = {};
  const schemas: Record<string, Schema> = {};
  for (const { doc, operations } of docs) {
    const prefix = `${doc.name}_`;
    const pending = new Set<string>();
    for (const op of operations) {
      const method = findMethod(doc, op.id);
      const pathParams = [...op.path.matchAll(/\{([^}]+)\}/g)].map(([, name]) => ({ name, in: "path", required: true, schema: { type: "string" } }));
      const queryParams = Object.entries<Discovery>(method.parameters ?? {})
        .filter(([, p]) => p.location === "query")
        .map(([name, p]) => {
          const base = discoverySchema({ type: p.type, format: p.format, enum: p.enum, pattern: p.pattern }, prefix, pending) as Schema;
          for (const k of Object.keys(base)) if (base[k] === undefined) delete base[k];
          return { name, in: "query", required: p.required === true, schema: p.repeated ? { type: "array", items: base } : base };
        });
      if (!method.response?.$ref) throw new Error(`${op.id} has no response schema`);
      pending.add(method.response.$ref);
      (paths[op.path] ??= {})[String(method.httpMethod).toLowerCase()] = {
        operationId: op.id,
        description: method.description,
        parameters: [...pathParams, ...queryParams],
        responses: {
          "200": { description: "Successful response", content: { "application/json": { schema: { $ref: `#/components/schemas/${prefix}${method.response.$ref}` } } } },
        },
      };
    }
    const done = new Set<string>();
    while (pending.size) {
      const [name] = pending;
      pending.delete(name);
      if (done.has(name)) continue;
      done.add(name);
      const schema = doc.schemas?.[name];
      if (!schema) throw new Error(`schema ${name} is not in the ${doc.name} discovery document`);
      const found = new Set<string>();
      schemas[`${prefix}${name}`] = discoverySchema(schema, prefix, found) as Schema;
      for (const f of found) if (!done.has(f)) pending.add(f);
    }
  }
  const sorted = Object.fromEntries(Object.entries(schemas).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return { openapi: "3.0.3", info: { title: "Google APIs (discovery documents)", version: "discovery" }, paths, components: { schemas: sorted } };
}

// -- JSON Hyper-Schema (Heroku) ---------------------------------------------------

/** One link of a Heroku resource, by the resource's definition name and the
 *  link's title ("formation", "List"), served at an OpenAPI path template.
 *  The template is infralift's: the schema's hrefs embed JSON pointers
 *  ("/apps/{(%23%2Fdefinitions%2Fapp%2Fdefinitions%2Fidentity)}"). */
export interface HyperSchemaOperation {
  resource: string;
  link: string;
  path: string;
}

const HYPER_ONLY_KEYS = new Set(["links", "$schema", "stability", "strictProperties", "example", "title"]);
/** Keys whose children are named by the vendor (a property called "links" is a property). */
const NAME_MAPS = new Set(["properties", "definitions", "patternProperties"]);

/** Every "#/definitions/<name>" a schema reaches, by top-level name. */
function hyperRefs(node: unknown, found: Set<string>): void {
  if (Array.isArray(node)) return node.forEach((n) => hyperRefs(n, found));
  if (!node || typeof node !== "object") return;
  for (const [k, v] of Object.entries(node)) {
    if (k === "$ref" && typeof v === "string" && v.startsWith("#/definitions/")) found.add(v.split("/")[2]);
    else if (NAME_MAPS.has(k) && v && typeof v === "object") Object.values(v).forEach((s) => hyperRefs(s, found));
    else if (!HYPER_ONLY_KEYS.has(k)) hyperRefs(v, found);
  }
}

function hyperSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(hyperSchema);
  if (!node || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    if (NAME_MAPS.has(k) && v && typeof v === "object") {
      out[k] = Object.fromEntries(Object.entries(v).map(([name, s]) => [name, hyperSchema(s)]));
      continue;
    }
    // prmd's strictProperties: no properties beyond those listed.
    if (k === "strictProperties" && v === true && !("additionalProperties" in node)) out.additionalProperties = false;
    if (HYPER_ONLY_KEYS.has(k)) continue;
    out[k] = k === "$ref" && typeof v === "string" ? v.replace(/^#\/definitions\//, "#/components/schemas/") : hyperSchema(v);
  }
  return out;
}

/** The listed links as an OpenAPI 3.1 document. 3.1, because the schema's
 *  types are draft-04 type arrays (["string", "null"]), which 3.0 lacks. */
export function hyperSchemaToOpenApi(doc: Record<string, any>, operations: HyperSchemaOperation[]): OpenApiDocument {
  const paths: OpenApiDocument["paths"] = {};
  const pending = new Set<string>();
  for (const op of operations) {
    const resource = doc.definitions?.[op.resource];
    const link = resource?.links?.find((l: Schema) => l.title === op.link);
    if (!link) throw new Error(`Heroku schema has no "${op.link}" link on ${op.resource}`);
    const target = link.targetSchema ?? (link.rel === "instances" ? { type: ["array"], items: { $ref: `#/definitions/${op.resource}` } } : { $ref: `#/definitions/${op.resource}` });
    hyperRefs(target, pending);
    const pathParams = [...op.path.matchAll(/\{([^}]+)\}/g)].map(([, name]) => ({ name, in: "path", required: true, schema: { type: "string" } }));
    (paths[op.path] ??= {})[String(link.method).toLowerCase()] = {
      summary: `${op.resource} ${op.link}`,
      description: link.description,
      parameters: pathParams,
      responses: { "200": { description: "Successful response", content: { "application/json": { schema: hyperSchema(target) } } } },
    };
  }
  const schemas: Record<string, Schema> = {};
  const done = new Set<string>();
  while (pending.size) {
    const [name] = pending;
    pending.delete(name);
    if (done.has(name)) continue;
    done.add(name);
    const definition = doc.definitions?.[name];
    if (!definition) throw new Error(`Heroku schema has no definition ${name}`);
    const found = new Set<string>();
    hyperRefs(definition, found);
    for (const f of found) if (!done.has(f)) pending.add(f);
    schemas[name] = hyperSchema(definition) as Schema;
  }
  const sorted = Object.fromEntries(Object.entries(schemas).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return { openapi: "3.1.0", info: { title: doc.title ?? "Heroku Platform API", version: "3" }, paths, components: { schemas: sorted } };
}
