import { test, expect, describe } from "bun:test";
import {
  parseGraphQLRequest,
  getGraphQLRequestKeys,
  getGraphQLDescription,
  parseGraphQLFromSearchParams,
  generateGraphQLFieldPatternOptions,
  type GraphQLField,
  type GraphQLFieldArg,
  type JSONValue,
} from "./graphql";

/** Helper to create a GraphQLFieldArg */
const a = (name: string, value: JSONValue): GraphQLFieldArg => ({
  name,
  value,
});

/** Helper to create a GraphQLField */
const f = (name: string, args: GraphQLFieldArg[] = []): GraphQLField => ({
  name,
  args,
});

describe("parseGraphQLRequest", () => {
  test("parses simple query without fragments", () => {
    const body = JSON.stringify({
      query: `query GetUser { user { id name } }`,
    });

    const result = parseGraphQLRequest(body);

    expect(result).toEqual({
      queries: [f("user")],
      mutations: [],
    });
  });

  test("parses query with named fragment", () => {
    const body = JSON.stringify({
      query: `
        fragment UserFields on User {
          id
          name
          email
        }
        query GetUser {
          user {
            ...UserFields
          }
        }
      `,
    });

    const result = parseGraphQLRequest(body);

    expect(result).toEqual({
      queries: [f("user")],
      mutations: [],
    });
  });

  test("parses query with multiple top-level fields", () => {
    const body = JSON.stringify({
      query: `
        query GetRepo {
          viewer { login }
          repository(owner: "foo", name: "bar") {
            id
          }
        }
      `,
    });

    const result = parseGraphQLRequest(body);

    expect(result).toEqual({
      queries: [
        f("viewer"),
        f("repository", [a("owner", "foo"), a("name", "bar")]),
      ],
      mutations: [],
    });
  });

  test("parses query with nested fragments", () => {
    const body = JSON.stringify({
      query: `
        fragment OwnerFields on Owner {
          login
        }
        fragment RepoFields on Repository {
          id
          name
          owner {
            ...OwnerFields
          }
        }
        query GetRepo {
          repository(owner: "foo", name: "bar") {
            ...RepoFields
          }
        }
      `,
    });

    const result = parseGraphQLRequest(body);

    expect(result).toEqual({
      queries: [f("repository", [a("owner", "foo"), a("name", "bar")])],
      mutations: [],
    });
  });

  test("parses query with inline fragment", () => {
    const body = JSON.stringify({
      query: `
        query GetNode {
          node(id: "123") {
            ... on User {
              name
            }
            ... on Repository {
              description
            }
          }
        }
      `,
    });

    const result = parseGraphQLRequest(body);

    expect(result).toEqual({
      queries: [f("node", [a("id", "123")])],
      mutations: [],
    });
  });

  test("parses mutation with arguments", () => {
    const body = JSON.stringify({
      query: `
        mutation CreateRepo {
          createRepository(input: { name: "my-repo", visibility: PRIVATE }) {
            repository {
              id
            }
          }
        }
      `,
    });

    const result = parseGraphQLRequest(body);

    expect(result).toEqual({
      queries: [],
      mutations: [
        f("createRepository", [
          a("input", { name: "my-repo", visibility: "PRIVATE" }),
        ]),
      ],
    });
  });

  test("parses mutation with variable arguments - substitutes variables", () => {
    const body = JSON.stringify({
      query: `
        mutation CreateRepo($input: CreateRepositoryInput!) {
          createRepository(input: $input) {
            repository {
              id
            }
          }
        }
      `,
      variables: { input: { name: "my-repo", visibility: "PRIVATE" } },
    });

    const result = parseGraphQLRequest(body);

    expect(result).toEqual({
      queries: [],
      mutations: [
        f("createRepository", [
          a("input", { name: "my-repo", visibility: "PRIVATE" }),
        ]),
      ],
    });
  });

  test("returns null for unprovided variable", () => {
    const body = JSON.stringify({
      query: `
        mutation CreateRepo($input: CreateRepositoryInput!) {
          createRepository(input: $input) {
            repository {
              id
            }
          }
        }
      `,
      // No variables provided
    });

    const result = parseGraphQLRequest(body);

    expect(result).toEqual({
      queries: [],
      mutations: [f("createRepository", [a("input", null)])],
    });
  });

  test("parses mutation without arguments", () => {
    const body = JSON.stringify({
      query: `
        mutation {
          logout {
            success
          }
        }
      `,
    });

    const result = parseGraphQLRequest(body);

    expect(result).toEqual({
      queries: [],
      mutations: [f("logout")],
    });
  });

  test("parses batched requests", () => {
    const body = JSON.stringify([
      {
        query: `query Q1 { user { id } }`,
      },
      {
        query: `query Q2 { posts { title } }`,
      },
    ]);

    const result = parseGraphQLRequest(body);

    expect(result).toEqual({
      queries: [f("user"), f("posts")],
      mutations: [],
    });
  });

  test("parses batched requests with mixed operations", () => {
    const body = JSON.stringify([
      {
        query: `query { user { id } }`,
      },
      {
        query: `mutation { deleteUser(id: "123") { success } }`,
      },
    ]);

    const result = parseGraphQLRequest(body);

    expect(result).toEqual({
      queries: [f("user")],
      mutations: [f("deleteUser", [a("id", "123")])],
    });
  });

  test("deduplicates fields across batched requests", () => {
    const body = JSON.stringify([
      {
        query: `query { user { id } }`,
      },
      {
        query: `query { user { name } posts { title } }`,
      },
    ]);

    const result = parseGraphQLRequest(body);

    expect(result).toEqual({
      queries: [f("user"), f("posts")],
      mutations: [],
    });
  });

  test("filters by operationName when provided", () => {
    const body = JSON.stringify({
      query: `
        query GetUser { user { id } }
        query GetPosts { posts { title } }
      `,
      operationName: "GetUser",
    });

    const result = parseGraphQLRequest(body);

    expect(result).toEqual({
      queries: [f("user")],
      mutations: [],
    });
  });

  test("filters by operationName in batched requests", () => {
    const body = JSON.stringify([
      {
        query: `
          query GetUser { user { id } }
          query GetPosts { posts { title } }
        `,
        operationName: "GetUser",
      },
      {
        query: `
          mutation CreatePost { createPost(title: "Hi") { id } }
          mutation DeletePost { deletePost(id: "1") { success } }
        `,
        operationName: "CreatePost",
      },
    ]);

    const result = parseGraphQLRequest(body);

    expect(result).toEqual({
      queries: [f("user")],
      mutations: [f("createPost", [a("title", "Hi")])],
    });
  });

  test("returns null for unknown operationName", () => {
    const body = JSON.stringify({
      query: `query GetUser { user { id } }`,
      operationName: "NonExistent",
    });

    const result = parseGraphQLRequest(body);

    expect(result).toBeNull();
  });

  test("returns null for unknown fragment reference", () => {
    const body = JSON.stringify({
      query: `
        query GetUser {
          user {
            ...UnknownFragment
          }
        }
      `,
    });

    const result = parseGraphQLRequest(body);

    expect(result).toBeNull();
  });

  test("returns null for invalid JSON", () => {
    const result = parseGraphQLRequest("not json");
    expect(result).toBeNull();
  });

  test("returns null for invalid GraphQL syntax", () => {
    const body = JSON.stringify({
      query: "not valid graphql {{{",
    });

    const result = parseGraphQLRequest(body);

    expect(result).toBeNull();
  });

  test("parses anonymous query", () => {
    const body = JSON.stringify({
      query: `{ user { id } }`,
    });

    const result = parseGraphQLRequest(body);

    expect(result).toEqual({
      queries: [f("user")],
      mutations: [],
    });
  });

  test("substitutes variables in query arguments", () => {
    const body = JSON.stringify({
      query: `
        query GetRepo($owner: String!, $name: String!) {
          repository(owner: $owner, name: $name) {
            id
          }
        }
      `,
      variables: { owner: "archetype-labs", name: "app" },
    });

    const result = parseGraphQLRequest(body);

    expect(result).toEqual({
      queries: [
        f("repository", [a("owner", "archetype-labs"), a("name", "app")]),
      ],
      mutations: [],
    });
  });

  test("handles mixed literal and variable arguments", () => {
    const body = JSON.stringify({
      query: `
        query GetRepo($name: String!) {
          repository(owner: "archetype-labs", name: $name) {
            id
          }
        }
      `,
      variables: { name: "app" },
    });

    const result = parseGraphQLRequest(body);

    expect(result).toEqual({
      queries: [
        f("repository", [a("owner", "archetype-labs"), a("name", "app")]),
      ],
      mutations: [],
    });
  });

  test("handles document with both query and mutation", () => {
    const body = JSON.stringify({
      query: `
        query GetUser { user { id } }
        mutation UpdateUser { updateUser(name: "Bob") { id } }
      `,
    });

    // Without operationName, all operations are processed
    const result = parseGraphQLRequest(body);

    expect(result).toEqual({
      queries: [f("user")],
      mutations: [f("updateUser", [a("name", "Bob")])],
    });
  });
});

describe("getGraphQLRequestKeys", () => {
  test("returns individual keys for each query field", () => {
    const keys = getGraphQLRequestKeys({
      queries: [f("user"), f("posts")],
      mutations: [],
    });

    expect(keys).toEqual(["GRAPHQL query user", "GRAPHQL query posts"]);
  });

  test("returns individual keys for each mutation field", () => {
    const keys = getGraphQLRequestKeys({
      queries: [],
      mutations: [f("createUser", [a("name", "Bob")]), f("logout")],
    });

    expect(keys).toEqual([
      'GRAPHQL mutation createUser(name: "Bob")',
      "GRAPHQL mutation logout",
    ]);
  });

  test("returns keys for both queries and mutations", () => {
    const keys = getGraphQLRequestKeys({
      queries: [f("user")],
      mutations: [f("updateUser", [a("id", "1")])],
    });

    expect(keys).toEqual([
      "GRAPHQL query user",
      'GRAPHQL mutation updateUser(id: "1")',
    ]);
  });

  test("returns empty array when no fields", () => {
    const keys = getGraphQLRequestKeys({
      queries: [],
      mutations: [],
    });

    expect(keys).toEqual([]);
  });
});

describe("getGraphQLDescription", () => {
  test("returns query description", () => {
    const desc = getGraphQLDescription({
      queries: [f("user"), f("posts")],
      mutations: [],
    });

    expect(desc).toBe("query { user, posts }");
  });

  test("returns mutation description", () => {
    const desc = getGraphQLDescription({
      queries: [],
      mutations: [f("createUser", [a("name", "Bob")])],
    });

    expect(desc).toBe('mutation { createUser(name: "Bob") }');
  });

  test("returns combined description", () => {
    const desc = getGraphQLDescription({
      queries: [f("user")],
      mutations: [f("updateUser", [a("id", "1")])],
    });

    expect(desc).toBe('query { user }; mutation { updateUser(id: "1") }');
  });
});

describe("parseGraphQLFromSearchParams", () => {
  test("parses query from search params", () => {
    const params = new URLSearchParams();
    params.set("query", "query GetUser { user { id } }");

    const result = parseGraphQLFromSearchParams(params);

    expect(result).toEqual({
      queries: [f("user")],
      mutations: [],
    });
  });

  test("parses query with fragments from search params", () => {
    const params = new URLSearchParams();
    params.set(
      "query",
      `
      fragment F on User { id name }
      query GetUser { user { ...F } }
    `,
    );

    const result = parseGraphQLFromSearchParams(params);

    expect(result).toEqual({
      queries: [f("user")],
      mutations: [],
    });
  });

  test("respects operationName from search params", () => {
    const params = new URLSearchParams();
    params.set(
      "query",
      `
      query GetUser { user { id } }
      query GetPosts { posts { title } }
    `,
    );
    params.set("operationName", "GetPosts");

    const result = parseGraphQLFromSearchParams(params);

    expect(result).toEqual({
      queries: [f("posts")],
      mutations: [],
    });
  });

  test("returns null when query param missing", () => {
    const params = new URLSearchParams();

    const result = parseGraphQLFromSearchParams(params);

    expect(result).toBeNull();
  });

  test("substitutes variables from search params", () => {
    const params = new URLSearchParams();
    params.set(
      "query",
      `query GetRepo($owner: String!) { repository(owner: $owner) { id } }`,
    );
    params.set("variables", JSON.stringify({ owner: "archetype-labs" }));

    const result = parseGraphQLFromSearchParams(params);

    expect(result).toEqual({
      queries: [f("repository", [a("owner", "archetype-labs")])],
      mutations: [],
    });
  });

  test("returns null for invalid variables JSON in search params", () => {
    const params = new URLSearchParams();
    params.set("query", "query { user { id } }");
    params.set("variables", "not valid json");

    const result = parseGraphQLFromSearchParams(params);

    expect(result).toBeNull();
  });
});

describe("generateGraphQLFieldPatternOptions", () => {
  test("field with no args returns exact + catch-all", () => {
    const options = generateGraphQLFieldPatternOptions("query", f("viewer"));

    expect(options).toEqual([
      { pattern: "GRAPHQL query viewer", description: "GRAPHQL query viewer" },
      { pattern: "GRAPHQL query *", description: "GRAPHQL query *" },
    ]);
  });

  test("field with one arg returns exact + $ANY + catch-all", () => {
    const options = generateGraphQLFieldPatternOptions(
      "query",
      f("node", [a("id", "123")]),
    );

    expect(options).toEqual([
      {
        pattern: 'GRAPHQL query node(id: "123")',
        description: 'GRAPHQL query node(id: "123")',
      },
      {
        pattern: "GRAPHQL query node(id: $ANY)",
        description: "GRAPHQL query node(id: $ANY)",
      },
      { pattern: "GRAPHQL query *", description: "GRAPHQL query *" },
    ]);
  });

  test("field with one arg where value is $ANY-like skips duplicate", () => {
    // Edge case: if the exact pattern somehow equals the $ANY pattern, skip it
    // This can't actually happen since $ANY is not a valid JSON value,
    // but test the dedup logic anyway
    const options = generateGraphQLFieldPatternOptions(
      "mutation",
      f("logout"),
    );

    // No args, so just exact + catch-all
    expect(options).toEqual([
      {
        pattern: "GRAPHQL mutation logout",
        description: "GRAPHQL mutation logout",
      },
      {
        pattern: "GRAPHQL mutation *",
        description: "GRAPHQL mutation *",
      },
    ]);
  });

  test("field with multiple args generates progressive $ANY patterns", () => {
    const options = generateGraphQLFieldPatternOptions(
      "mutation",
      f("createPullRequest", [
        a("repositoryId", "abc"),
        a("title", "foo"),
        a("body", "bar"),
      ]),
    );

    expect(options).toEqual([
      {
        pattern:
          'GRAPHQL mutation createPullRequest(repositoryId: "abc", title: "foo", body: "bar")',
        description:
          'GRAPHQL mutation createPullRequest(repositoryId: "abc", title: "foo", body: "bar")',
      },
      {
        pattern:
          'GRAPHQL mutation createPullRequest(repositoryId: "abc", title: "foo", body: $ANY)',
        description:
          'GRAPHQL mutation createPullRequest(repositoryId: "abc", title: "foo", body: $ANY)',
      },
      {
        pattern:
          'GRAPHQL mutation createPullRequest(repositoryId: "abc", title: $ANY, body: $ANY)',
        description:
          'GRAPHQL mutation createPullRequest(repositoryId: "abc", title: $ANY, body: $ANY)',
      },
      {
        pattern:
          "GRAPHQL mutation createPullRequest(repositoryId: $ANY, title: $ANY, body: $ANY)",
        description:
          "GRAPHQL mutation createPullRequest(repositoryId: $ANY, title: $ANY, body: $ANY)",
      },
      {
        pattern: "GRAPHQL mutation *",
        description: "GRAPHQL mutation *",
      },
    ]);
  });

  test("field with two args generates correct progressive patterns", () => {
    const options = generateGraphQLFieldPatternOptions(
      "query",
      f("repository", [a("owner", "foo"), a("name", "bar")]),
    );

    expect(options).toEqual([
      {
        pattern: 'GRAPHQL query repository(owner: "foo", name: "bar")',
        description: 'GRAPHQL query repository(owner: "foo", name: "bar")',
      },
      {
        pattern: 'GRAPHQL query repository(owner: "foo", name: $ANY)',
        description: 'GRAPHQL query repository(owner: "foo", name: $ANY)',
      },
      {
        pattern: "GRAPHQL query repository(owner: $ANY, name: $ANY)",
        description: "GRAPHQL query repository(owner: $ANY, name: $ANY)",
      },
      {
        pattern: "GRAPHQL query *",
        description: "GRAPHQL query *",
      },
    ]);
  });

  test("field with object arg returns exact + $ANY + catch-all", () => {
    const options = generateGraphQLFieldPatternOptions(
      "mutation",
      f("createRepository", [
        a("input", { name: "my-repo", visibility: "PRIVATE" }),
      ]),
    );

    expect(options).toEqual([
      {
        pattern:
          'GRAPHQL mutation createRepository(input: {name: "my-repo", visibility: "PRIVATE"})',
        description:
          'GRAPHQL mutation createRepository(input: {name: "my-repo", visibility: "PRIVATE"})',
      },
      {
        pattern: "GRAPHQL mutation createRepository(input: $ANY)",
        description: "GRAPHQL mutation createRepository(input: $ANY)",
      },
      {
        pattern: "GRAPHQL mutation *",
        description: "GRAPHQL mutation *",
      },
    ]);
  });
});
