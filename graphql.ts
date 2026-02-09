import {
  parse,
  type DocumentNode,
  type OperationDefinitionNode,
  type SelectionSetNode,
  type SelectionNode,
  type FieldNode,
  type FragmentDefinitionNode,
  type ArgumentNode,
  type ValueNode,
  Kind,
} from "graphql";

/**
 * Represents the parsed result of a GraphQL request.
 * Groups all top-level fields by operation type.
 */
export interface ParsedGraphQLRequest {
  /** Top-level query fields with arguments (e.g., ["viewer", "repository(owner: \"foo\", name: \"bar\")"]) */
  queries: string[];
  /** Top-level mutation fields with arguments (e.g., ["createRepository(input: {...})"]) */
  mutations: string[];
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

  const allQueries: string[] = [];
  const allMutations: string[] = [];

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

  // Deduplicate
  return {
    queries: [...new Set(allQueries)],
    mutations: [...new Set(allMutations)],
  };
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

  const queries: string[] = [];
  const mutations: string[] = [];

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
 * Includes serialized arguments when present, with variables substituted.
 */
function extractTopLevelFields(
  selectionSet: SelectionSetNode,
  variables: Record<string, unknown>,
): string[] | null {
  const fields: string[] = [];

  for (const selection of selectionSet.selections) {
    if (selection.kind !== Kind.FIELD) {
      console.log(
        `  → GraphQL parse error: Unsupported selection kind: ${selection.kind}`,
      );
      return null;
    }
    const field = selection;
    const fieldName = field.name.value;

    if (field.arguments && field.arguments.length > 0) {
      const argsStr = serializeArguments(field.arguments, variables);
      fields.push(`${fieldName}(${argsStr})`);
    } else {
      fields.push(fieldName);
    }
  }

  return fields;
}

/**
 * Serialize GraphQL arguments to a string representation.
 * Variable references are substituted with their values.
 */
function serializeArguments(
  args: readonly ArgumentNode[],
  variables: Record<string, unknown>,
): string {
  const parts: string[] = [];
  for (const arg of args) {
    const valueStr = serializeValue(arg.value, variables);
    parts.push(`${arg.name.value}: ${valueStr}`);
  }
  return parts.join(", ");
}

/**
 * Serialize a GraphQL value node to a string representation.
 * Variable references are substituted with their values from the variables object.
 */
function serializeValue(
  value: ValueNode,
  variables: Record<string, unknown>,
): string {
  switch (value.kind) {
    case Kind.VARIABLE: {
      const varName = value.name.value;
      if (varName in variables) {
        return serializeJsValue(variables[varName]);
      }
      // Variable not provided, keep as variable reference
      return `$${varName}`;
    }
    case Kind.INT:
      return value.value;
    case Kind.FLOAT:
      return value.value;
    case Kind.STRING:
      return JSON.stringify(value.value);
    case Kind.BOOLEAN:
      return value.value ? "true" : "false";
    case Kind.NULL:
      return "null";
    case Kind.ENUM:
      return value.value;
    case Kind.LIST: {
      const items = value.values.map((v) => serializeValue(v, variables));
      return `[${items.join(", ")}]`;
    }
    case Kind.OBJECT: {
      const fields = value.fields.map(
        (f) => `${f.name.value}: ${serializeValue(f.value, variables)}`,
      );
      return `{${fields.join(", ")}}`;
    }
    default:
      return "null";
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
 * Generate individual request keys for each field in a parsed GraphQL request.
 * Returns a list of keys like "GRAPHQL query viewer", "GRAPHQL mutation createUser(name: \"Bob\")".
 * This allows for granular permission grants per field.
 */
export function getGraphQLRequestKeys(parsed: ParsedGraphQLRequest): string[] {
  const keys: string[] = [];

  for (const field of parsed.queries) {
    keys.push(`GRAPHQL query ${field}`);
  }

  for (const field of parsed.mutations) {
    keys.push(`GRAPHQL mutation ${field}`);
  }

  return keys;
}

/**
 * Get a display-friendly description of the GraphQL request.
 */
export function getGraphQLDescription(parsed: ParsedGraphQLRequest): string {
  const parts: string[] = [];

  if (parsed.queries.length > 0) {
    parts.push(`query { ${parsed.queries.join(", ")} }`);
  }

  if (parsed.mutations.length > 0) {
    parts.push(`mutation { ${parsed.mutations.join(", ")} }`);
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
