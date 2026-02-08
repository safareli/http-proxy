import {
  parse,
  type DocumentNode,
  type OperationDefinitionNode,
  type SelectionSetNode,
  type FieldNode,
  Kind,
} from "graphql";

export interface GraphQLOperation {
  type: "query" | "mutation" | "subscription";
  name: string | null;
  topLevelFields: string[];
}

interface GraphQLRequestBody {
  query?: string;
  operationName?: string;
  variables?: Record<string, unknown>;
}

/**
 * Parse a GraphQL request body (JSON string) and extract all operations.
 * Returns null if parsing fails.
 */
export function parseGraphQLRequest(body: string): GraphQLOperation[] | null {
  let parsed: GraphQLRequestBody | GraphQLRequestBody[];
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    console.log(`  → GraphQL parse error: Invalid JSON body: ${error}`);
    return null;
  }

  // Handle batched requests (array of operations)
  const requests = Array.isArray(parsed) ? parsed : [parsed];
  const operations: GraphQLOperation[] = [];

  for (const req of requests) {
    if (!req.query || typeof req.query !== "string") {
      console.log(`  → GraphQL parse error: Missing or invalid 'query' field`);
      return null;
    }

    const ops = parseGraphQLQuery(req.query);
    if (!ops) {
      return null;
    }

    operations.push(...ops);
  }

  if (operations.length === 0) {
    console.log(`  → GraphQL parse error: No operations found in document`);
    return null;
  }

  return operations;
}

/**
 * Parse a GraphQL query string and extract operations.
 */
function parseGraphQLQuery(query: string): GraphQLOperation[] | null {
  let document: DocumentNode;
  try {
    document = parse(query);
  } catch (error) {
    console.log(`  → GraphQL parse error: Invalid GraphQL syntax: ${error}`);
    return null;
  }

  const operations: GraphQLOperation[] = [];

  for (const definition of document.definitions) {
    if (definition.kind !== Kind.OPERATION_DEFINITION) {
      console.log(
        `  → GraphQL parse error: Unsupported definition kind: ${definition.kind}`,
      );
      return null;
    }

    const opDef = definition as OperationDefinitionNode;
    const topLevelFields = extractTopLevelFields(opDef.selectionSet);
    if (!topLevelFields) {
      return null;
    }

    operations.push({
      type: opDef.operation,
      name: opDef.name?.value ?? null,
      topLevelFields,
    });
  }

  return operations;
}

/**
 * Extract top-level field names from a selection set.
 * Returns null if unsupported selection types are encountered.
 */
function extractTopLevelFields(selectionSet: SelectionSetNode): string[] | null {
  const fields: string[] = [];

  for (const selection of selectionSet.selections) {
    if (selection.kind !== Kind.FIELD) {
      console.log(
        `  → GraphQL parse error: Unsupported selection kind: ${selection.kind}`,
      );
      return null;
    }
    const field = selection as FieldNode;
    fields.push(field.name.value);
  }

  return fields;
}

/**
 * Get a display-friendly description of the operation (without GRAPHQL prefix).
 * Format:
 * - Named: "query getUserById"
 * - Anonymous: "query { user, posts }"
 */
export function getGraphQLOperationDescription(op: GraphQLOperation): string {
  if (op.name) {
    return `${op.type} ${op.name}`;
  }
  return `${op.type} { ${op.topLevelFields.join(", ")} }`;
}

/**
 * Generate a request key for a GraphQL operation.
 * Format:
 * - Named: "GRAPHQL query getUserById"
 * - Anonymous: "GRAPHQL query { user, posts }"
 */
export function getGraphQLRequestKey(op: GraphQLOperation): string {
  return `GRAPHQL ${getGraphQLOperationDescription(op)}`;
}

/**
 * Parse GraphQL query from URL search params (for GET requests).
 * Returns null if no valid query found.
 */
export function parseGraphQLFromSearchParams(
  searchParams: URLSearchParams,
): GraphQLOperation[] | null {
  const query = searchParams.get("query");
  if (!query) {
    console.log(`  → GraphQL parse error: Missing 'query' search parameter`);
    return null;
  }

  return parseGraphQLQuery(query);
}
