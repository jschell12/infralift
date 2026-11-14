// ---------------------------------------------------------------------------
// The part of a vendor's GraphQL schema that infralift's queries use.
//
// Railway and Fly.io's platform API are GraphQL, which Prism does not serve.
// For those, extract.ts writes a subset of the vendor's own schema (at a
// pinned commit) holding the query root, every field the connector's queries
// select, and the full argument and input types of those fields. The provider
// fake (e2e/provider-fakes) validates each incoming query against it and
// executes the query against the seeded account, so a field the vendor does
// not have, or a null where the vendor promises a value, fails the request.
//
// Every query must validate against the full schema first; one that does not
// is reported, not pruned around.
// ---------------------------------------------------------------------------

import {
  GraphQLInterfaceType,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLSchema,
  TypeInfo,
  isEnumType,
  isInputObjectType,
  isInterfaceType,
  isListType,
  isNonNullType,
  isObjectType,
  isScalarType,
  isUnionType,
  parse,
  printSchema,
  validate,
  visit,
  visitWithTypeInfo,
  type GraphQLFieldConfigArgumentMap,
  type GraphQLFieldConfigMap,
  type GraphQLNamedType,
  type GraphQLOutputType,
} from "graphql";

/** Problems with each query against `schema`; empty when every one is valid. */
export function queryProblems(schema: GraphQLSchema, queries: string[]): string[] {
  const problems: string[] = [];
  for (const query of queries) {
    for (const error of validate(schema, parse(query))) problems.push(`${error.message} (in: ${query.replace(/\s+/g, " ").slice(0, 80)}...)`);
  }
  return problems;
}

/** Field names each object type's selections use, across all queries. */
function usedFields(schema: GraphQLSchema, queries: string[]): Map<string, Set<string>> {
  const used = new Map<string, Set<string>>();
  for (const query of queries) {
    const info = new TypeInfo(schema);
    visit(
      parse(query),
      visitWithTypeInfo(info, {
        Field(node) {
          const parent = info.getParentType();
          if (!parent) return;
          if (!isObjectType(parent) && !isInterfaceType(parent)) throw new Error(`${parent.name}: selections on unions are not supported by the subset`);
          if (!used.has(parent.name)) used.set(parent.name, new Set());
          used.get(parent.name)!.add(node.name.value);
        },
      })
    );
  }
  return used;
}

/** `schema` cut down to the query root and the fields `queries` select. */
export function graphqlSubset(schema: GraphQLSchema, queries: string[]): GraphQLSchema {
  const problems = queryProblems(schema, queries);
  if (problems.length) throw new Error(`queries the vendor's schema rejects:\n  ${problems.join("\n  ")}`);
  const used = usedFields(schema, queries);
  const pruned = new Map<string, GraphQLObjectType | GraphQLInterfaceType>();
  const interfaces = new Set<GraphQLInterfaceType>();

  // Scalars, enums and input types are kept whole and shared with the full
  // schema: they only ever reference each other. Object and interface types
  // are rebuilt with the used fields only. An interface brings every type
  // that implements it (the seed names which one with __typename), each
  // with the interface's used fields.
  const named = (type: GraphQLNamedType): GraphQLNamedType => {
    if (isScalarType(type) || isEnumType(type) || isInputObjectType(type)) return type;
    if (isUnionType(type)) throw new Error(`${type.name}: unions are not supported by the subset`);
    if (isInterfaceType(type)) return interfaceType(type);
    return objectType(type as GraphQLObjectType);
  };
  const wrap = (type: GraphQLOutputType): GraphQLOutputType => {
    if (isNonNullType(type)) return new GraphQLNonNull(wrap(type.ofType) as any);
    if (isListType(type)) return new GraphQLList(wrap(type.ofType));
    return named(type as GraphQLNamedType) as GraphQLOutputType;
  };
  const fieldsOf = (type: GraphQLObjectType | GraphQLInterfaceType, keep: Set<string>) => (): GraphQLFieldConfigMap<unknown, unknown> => {
    const fields: GraphQLFieldConfigMap<unknown, unknown> = {};
    for (const [name, field] of Object.entries(type.getFields())) {
      if (!keep.has(name)) continue;
      const args: GraphQLFieldConfigArgumentMap = {};
      for (const arg of field.args) args[arg.name] = { type: arg.type, defaultValue: arg.defaultValue, description: arg.description };
      fields[name] = { type: wrap(field.type), args, description: field.description, deprecationReason: field.deprecationReason };
    }
    return fields;
  };
  const interfaceType = (type: GraphQLInterfaceType): GraphQLInterfaceType => {
    const existing = pruned.get(type.name);
    if (existing) return existing as GraphQLInterfaceType;
    const result = new GraphQLInterfaceType({ name: type.name, description: type.description, fields: fieldsOf(type, used.get(type.name) ?? new Set()) });
    pruned.set(type.name, result);
    interfaces.add(type);
    return result;
  };
  const objectType = (type: GraphQLObjectType): GraphQLObjectType => {
    const existing = pruned.get(type.name);
    if (existing) return existing as GraphQLObjectType;
    const keep = new Set(used.get(type.name) ?? []);
    const result = new GraphQLObjectType({
      name: type.name,
      description: type.description,
      interfaces: () => type.getInterfaces().filter((i) => interfaces.has(i)).map(interfaceType),
      fields: () => {
        for (const i of type.getInterfaces()) if (interfaces.has(i)) for (const f of used.get(i.name) ?? []) keep.add(f);
        return fieldsOf(type, keep)();
      },
    });
    pruned.set(type.name, result);
    return result;
  };

  const query = schema.getQueryType();
  if (!query) throw new Error("the schema has no query type");
  const root = objectType(query);
  // Resolve every rebuilt type's fields until no new type appears: that is
  // what finds the interfaces in use, and through them their implementations.
  for (let size = -1; size !== pruned.size; ) {
    size = pruned.size;
    for (const t of [...pruned.values()]) t.getFields();
    for (const i of [...interfaces]) for (const impl of schema.getPossibleTypes(i)) objectType(impl as GraphQLObjectType);
  }
  const implementations = [...pruned.values()].filter((t): t is GraphQLObjectType => isObjectType(t) && t.getInterfaces().length > 0);
  const subset = new GraphQLSchema({ query: root, types: implementations });
  const after = queryProblems(subset, queries);
  if (after.length) throw new Error(`the subset rejects queries the full schema accepts:\n  ${after.join("\n  ")}`);
  return subset;
}

/** The subset as SDL, the form extract.ts commits. */
export function printSubset(schema: GraphQLSchema): string {
  return printSchema(schema);
}
