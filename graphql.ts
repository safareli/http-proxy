import {
  parse,
  type DocumentNode,
  type OperationDefinitionNode,
  type SelectionSetNode,
  type SelectionNode,
  type FragmentDefinitionNode,
  type FieldNode,
  type ValueNode,
  Kind,
} from "graphql";

/** Represents a JSON-compatible value */
export type JSONValue =
  | string
  | number
  | boolean
  | null
  | JSONValue[]
  | { [key: string]: JSONValue };

/** Represents an argument to a GraphQL field */
export interface GraphQLFieldArg {
  name: string;
  value: JSONValue;
}

/** Represents a top-level GraphQL field with its arguments */
export interface GraphQLField {
  name: string;
  args: GraphQLFieldArg[];
}

/**
 * Represents the parsed result of a GraphQL request.
 * Groups all top-level fields by operation type.
 */
export interface ParsedGraphQLRequest {
  /** Top-level query fields with arguments */
  queries: GraphQLField[];
  /** Top-level mutation fields with arguments */
  mutations: GraphQLField[];
}

interface GraphQLRequestBody {
  query?: string;
  operationName?: string;
  variables?: Record<string, unknown>;
}

/**
 * Parse a GraphQL request body (JSON string) and extract all accessed fields.
 * Handles batched requests and operationName filtering.
 * Returns null if parsing fails.
 */
export function parseGraphQLRequest(body: string): ParsedGraphQLRequest | null {
  let parsed: GraphQLRequestBody | GraphQLRequestBody[];
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    console.log(`  → GraphQL parse error: Invalid JSON body: ${error}`);
    return null;
  }

  // Handle batched requests (array of operations)
  const requests = Array.isArray(parsed) ? parsed : [parsed];

  const allQueries: GraphQLField[] = [];
  const allMutations: GraphQLField[] = [];

  for (const req of requests) {
    if (!req.query || typeof req.query !== "string") {
      console.log(`  → GraphQL parse error: Missing or invalid 'query' field`);
      return null;
    }

    const result = parseGraphQLDocument(
      req.query,
      req.operationName ?? null,
      req.variables ?? {},
    );
    if (!result) {
      return null;
    }

    allQueries.push(...result.queries);
    allMutations.push(...result.mutations);
  }

  if (allQueries.length === 0 && allMutations.length === 0) {
    console.log(`  → GraphQL parse error: No operations found in document`);
    return null;
  }

  // Deduplicate by serializing fields to JSON strings
  return {
    queries: deduplicateFields(allQueries),
    mutations: deduplicateFields(allMutations),
  };
}

/**
 * Deduplicate GraphQL fields by comparing their serialized form.
 */
function deduplicateFields(fields: GraphQLField[]): GraphQLField[] {
  const seen = new Set<string>();
  const result: GraphQLField[] = [];

  for (const field of fields) {
    const key = JSON.stringify(field);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(field);
  }

  return result;
}

/**
 * Parse a GraphQL document string and extract fields.
 * If operationName is provided, only that operation is processed.
 * Variables are substituted into argument values.
 */
function parseGraphQLDocument(
  query: string,
  operationName: string | null,
  variables: Record<string, unknown> = {},
): ParsedGraphQLRequest | null {
  let document: DocumentNode;
  try {
    document = parse(query);
  } catch (error) {
    console.log(`  → GraphQL parse error: Invalid GraphQL syntax: ${error}`);
    return null;
  }

  // Collect all fragment and operation definitions
  const fragments = new Map<string, FragmentDefinitionNode>();
  const operations: OperationDefinitionNode[] = [];
  for (const definition of document.definitions) {
    if (definition.kind === Kind.FRAGMENT_DEFINITION) {
      fragments.set(definition.name.value, definition);
      continue;
    }
    if (definition.kind !== Kind.OPERATION_DEFINITION) {
      console.log(
        `  → GraphQL parse error: Unsupported definition kind: ${definition.kind}`,
      );
      return null;
    }
    operations.push(definition);
  }

  // Filter by operationName if provided
  let selectedOperations = operations;
  if (operationName !== null) {
    selectedOperations = operations.filter(
      (op) => op.name?.value === operationName,
    );
    if (selectedOperations.length === 0) {
      console.log(
        `  → GraphQL parse error: Operation "${operationName}" not found`,
      );
      return null;
    }
  }

  const queries: GraphQLField[] = [];
  const mutations: GraphQLField[] = [];

  for (const opDef of selectedOperations) {
    const inlinedSelectionSet = inlineFragments(opDef.selectionSet, fragments);
    if (!inlinedSelectionSet) {
      return null;
    }

    const fields = extractTopLevelFields(inlinedSelectionSet, variables);
    if (!fields) {
      return null;
    }

    if (opDef.operation === "mutation") {
      mutations.push(...fields);
    } else {
      // TODO we can treat them different but they technically
      // subscription is just like a query so it's not that wrong
      // Treat queries and subscriptions the same
      queries.push(...fields);
    }
  }

  return { queries, mutations };
}

/**
 * Inline all fragment spreads in a selection set.
 * Returns a new selection set with fragments expanded.
 */
function inlineFragments(
  selectionSet: SelectionSetNode,
  fragments: Map<string, FragmentDefinitionNode>,
): SelectionSetNode | null {
  const newSelections: SelectionNode[] = [];

  for (const selection of selectionSet.selections) {
    if (selection.kind === Kind.FIELD) {
      if (!selection.selectionSet) {
        newSelections.push(selection);
        continue;
      }
      const inlinedNested = inlineFragments(selection.selectionSet, fragments);
      if (!inlinedNested) {
        return null;
      }
      newSelections.push({
        ...selection,
        selectionSet: inlinedNested,
      });
      continue;
    }

    if (selection.kind === Kind.FRAGMENT_SPREAD) {
      const fragment = fragments.get(selection.name.value);
      if (!fragment) {
        console.log(
          `  → GraphQL parse error: Unknown fragment: ${selection.name.value}`,
        );
        return null;
      }
      const inlinedFragment = inlineFragments(fragment.selectionSet, fragments);
      if (!inlinedFragment) {
        return null;
      }
      newSelections.push(...inlinedFragment.selections);
      continue;
    }

    if (selection.kind === Kind.INLINE_FRAGMENT) {
      const inlinedInline = inlineFragments(selection.selectionSet, fragments);
      if (!inlinedInline) {
        return null;
      }
      newSelections.push(...inlinedInline.selections);
      continue;
    }

    console.log(
      `  → GraphQL parse error: Unsupported selection kind: ${(selection as SelectionNode).kind}`,
    );
    return null;
  }

  return {
    ...selectionSet,
    selections: newSelections,
  };
}

/**
 * Extract top-level field representations from a selection set.
 * Includes arguments with their values (variables substituted).
 */
function extractTopLevelFields(
  selectionSet: SelectionSetNode,
  variables: Record<string, unknown>,
): GraphQLField[] | null {
  const fields: GraphQLField[] = [];

  for (const selection of selectionSet.selections) {
    if (selection.kind !== Kind.FIELD) {
      console.log(
        `  → GraphQL parse error: Unsupported selection kind: ${selection.kind}`,
      );
      return null;
    }
    const field = selection;
    const fieldName = field.name.value;

    const args: GraphQLFieldArg[] = [];
    if (field.arguments && field.arguments.length > 0) {
      for (const arg of field.arguments) {
        args.push({
          name: arg.name.value,
          value: valueNodeToJSON(arg.value, variables),
        });
      }
    }

    fields.push({ name: fieldName, args });
  }

  return fields;
}

/**
 * Convert a GraphQL ValueNode to a JSON value.
 * Variable references are substituted with their values from the variables object.
 */
function valueNodeToJSON(
  value: ValueNode,
  variables: Record<string, unknown>,
): JSONValue {
  switch (value.kind) {
    case Kind.VARIABLE: {
      const varName = value.name.value;
      if (varName in variables) {
        return variables[varName] as JSONValue;
      }
      // Variable not provided, treat as null (GraphQL default for nullable variables)
      return null;
    }
    case Kind.INT:
      return parseInt(value.value, 10);
    case Kind.FLOAT:
      return parseFloat(value.value);
    case Kind.STRING:
      return value.value;
    case Kind.BOOLEAN:
      return value.value;
    case Kind.NULL:
      return null;
    case Kind.ENUM:
      return value.value;
    case Kind.LIST:
      return value.values.map((v) => valueNodeToJSON(v, variables));
    case Kind.OBJECT: {
      const obj: { [key: string]: JSONValue } = {};
      for (const f of value.fields) {
        obj[f.name.value] = valueNodeToJSON(f.value, variables);
      }
      return obj;
    }
    default:
      return null;
  }
}

/**
 * Serialize a JavaScript value to GraphQL-like syntax.
 */
function serializeJsValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "null";
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    return String(value);
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (Array.isArray(value)) {
    const items = value.map(serializeJsValue);
    return `[${items.join(", ")}]`;
  }
  if (typeof value === "object") {
    const fields = Object.entries(value).map(
      ([k, v]) => `${k}: ${serializeJsValue(v)}`,
    );
    return `{${fields.join(", ")}}`;
  }
  return String(value);
}

/**
 * Format a GraphQL field as a string (e.g., "repository(owner: \"foo\", name: \"bar\")").
 */
export function formatGraphQLField(field: GraphQLField): string {
  if (field.args.length === 0) {
    return field.name;
  }
  const argsStr = field.args
    .map((arg) => `${arg.name}: ${serializeJsValue(arg.value)}`)
    .join(", ");
  return `${field.name}(${argsStr})`;
}

/**
 * Generate individual request keys for each field in a parsed GraphQL request.
 * Returns a list of keys like "GRAPHQL query viewer", "GRAPHQL mutation createUser(name: \"Bob\")".
 * This allows for granular permission grants per field.
 */
export function getGraphQLRequestKeys(parsed: ParsedGraphQLRequest): string[] {
  const keys: string[] = [];

  for (const field of parsed.queries) {
    keys.push(`GRAPHQL query ${formatGraphQLField(field)}`);
  }

  for (const field of parsed.mutations) {
    keys.push(`GRAPHQL mutation ${formatGraphQLField(field)}`);
  }

  return keys;
}

/**
 * Get a display-friendly description of the GraphQL request.
 */
export function getGraphQLDescription(parsed: ParsedGraphQLRequest): string {
  const parts: string[] = [];

  if (parsed.queries.length > 0) {
    const queryFields = parsed.queries.map(formatGraphQLField).join(", ");
    parts.push(`query { ${queryFields} }`);
  }

  if (parsed.mutations.length > 0) {
    const mutationFields = parsed.mutations.map(formatGraphQLField).join(", ");
    parts.push(`mutation { ${mutationFields} }`);
  }

  return parts.join("; ");
}

/**
 * Parse GraphQL query from URL search params (for GET requests).
 * Returns null if no valid query found.
 */
export function parseGraphQLFromSearchParams(
  searchParams: URLSearchParams,
): ParsedGraphQLRequest | null {
  const query = searchParams.get("query");
  if (!query) {
    console.log(`  → GraphQL parse error: Missing 'query' search parameter`);
    return null;
  }

  const operationName = searchParams.get("operationName");

  let variables: Record<string, unknown> = {};
  const variablesParam = searchParams.get("variables");
  if (variablesParam) {
    try {
      variables = JSON.parse(variablesParam);
    } catch {
      console.log(`  → GraphQL parse error: Invalid 'variables' JSON`);
      return null;
    }
  }

  return parseGraphQLDocument(query, operationName, variables);
}

/**
 * Parse a single GraphQL field string like "createPullRequest(input: $ANY)"
 * by wrapping it in a minimal document: "{ fieldStr }".
 */
function parseFieldString(fieldStr: string): FieldNode | null {
  try {
    const doc = parse(`{ ${fieldStr} }`);
    const op = doc.definitions[0];
    if (!op || op.kind !== Kind.OPERATION_DEFINITION) return null;
    const field = op.selectionSet.selections[0];
    if (!field || field.kind !== Kind.FIELD) return null;
    return field;
  } catch {
    return null;
  }
}

/**
 * Match two ValueNode ASTs. A $ANY variable in the pattern acts as a wildcard
 * that matches any value in the request. Other variable names are not allowed.
 */
function matchValueNode(pattern: ValueNode, request: ValueNode): boolean {
  if (pattern.kind === Kind.VARIABLE) {
    if (pattern.name.value !== "ANY") {
      throw new Error(`Unknown variable $${pattern.name.value} in grant/rejection pattern. Only $ANY is supported.`);
    }
    return true;
  }
  if (pattern.kind !== request.kind) return false;

  switch (pattern.kind) {
    case Kind.NULL:
      return true;
    case Kind.INT:
    case Kind.FLOAT:
    case Kind.STRING:
    case Kind.BOOLEAN:
    case Kind.ENUM:
      return (pattern as { readonly value: unknown }).value ===
        (request as { readonly value: unknown }).value;
    case Kind.LIST: {
      const rList = request as typeof pattern;
      if (pattern.values.length !== rList.values.length) return false;
      return pattern.values.every((pv, i) => matchValueNode(pv, rList.values[i]));
    }
    case Kind.OBJECT: {
      const rObj = request as typeof pattern;
      if (pattern.fields.length !== rObj.fields.length) return false;
      for (const pField of pattern.fields) {
        const rField = rObj.fields.find(f => f.name.value === pField.name.value);
        if (!rField) return false;
        if (!matchValueNode(pField.value, rField.value)) return false;
      }
      return true;
    }
    default:
      return false;
  }
}

/**
 * Match a GraphQL field pattern string against a request field string.
 * Pattern may contain $ANY references that act as wildcards.
 *
 * e.g. pattern "createPullRequest(input: $ANY)" matches
 *      request "createPullRequest(input: {title: \"foo\", body: \"bar\"})"
 */
export function matchesGraphQLFieldPattern(
  patternFieldStr: string,
  requestFieldStr: string,
): boolean {
  const patternNode = parseFieldString(patternFieldStr);
  const requestNode = parseFieldString(requestFieldStr);
  if (!patternNode || !requestNode) return false;
  if (patternNode.name.value !== requestNode.name.value) return false;

  const patternArgs = patternNode.arguments ?? [];
  const requestArgs = requestNode.arguments ?? [];
  if (patternArgs.length !== requestArgs.length) return false;

  for (const pArg of patternArgs) {
    const rArg = requestArgs.find(a => a.name.value === pArg.name.value);
    if (!rArg) return false;
    if (!matchValueNode(pArg.value, rArg.value)) return false;
  }

  return true;
}
