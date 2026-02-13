import { test, expect, describe } from "bun:test";
import { matchesPattern } from "./config";

describe("matchesPattern", () => {
  describe("HTTP patterns", () => {
    test("exact match", () => {
      expect(matchesPattern("GET /foo/bar", "GET /foo/bar")).toBe(true);
      expect(matchesPattern("GET /foo/bar", "GET /foo/baz")).toBe(false);
    });

    test("* matches single path segment", () => {
      expect(matchesPattern("GET /repos/*/actions", "GET /repos/myrepo/actions")).toBe(true);
      expect(matchesPattern("GET /repos/*/actions", "GET /repos/other/actions")).toBe(true);
      expect(matchesPattern("GET /repos/*/actions", "GET /repos/a/b/actions")).toBe(false);
    });

    test("multiple * wildcards", () => {
      expect(matchesPattern("GET /repos/*/*/actions/runs/*/jobs", "GET /repos/owner/repo/actions/runs/123/jobs")).toBe(true);
      expect(matchesPattern("GET /repos/*/*/actions/runs/*/jobs", "GET /repos/owner/repo/actions/runs/456/jobs")).toBe(true);
      expect(matchesPattern("GET /repos/*/*/actions/runs/*/jobs", "GET /repos/owner/actions/runs/123/jobs")).toBe(false);
    });

    test("METHOD * matches all paths", () => {
      expect(matchesPattern("GET *", "GET /any/path")).toBe(true);
      expect(matchesPattern("GET *", "GET /")).toBe(true);
      expect(matchesPattern("GET *", "POST /any/path")).toBe(false);
    });

    test("different methods don't match", () => {
      expect(matchesPattern("GET /foo", "POST /foo")).toBe(false);
      expect(matchesPattern("POST *", "GET /foo")).toBe(false);
    });
  });

  describe("GraphQL patterns", () => {
    test("exact match", () => {
      expect(matchesPattern("GRAPHQL query UserCurrent", "GRAPHQL query UserCurrent")).toBe(true);
      expect(matchesPattern("GRAPHQL query UserCurrent", "GRAPHQL query OtherQuery")).toBe(false);
    });

    test("query * matches all queries", () => {
      expect(matchesPattern("GRAPHQL query *", "GRAPHQL query UserCurrent")).toBe(true);
      expect(matchesPattern("GRAPHQL query *", "GRAPHQL query AnyOtherQuery")).toBe(true);
      expect(matchesPattern("GRAPHQL query *", "GRAPHQL mutation CreateUser")).toBe(false);
    });

    test("mutation * matches all mutations", () => {
      expect(matchesPattern("GRAPHQL mutation *", "GRAPHQL mutation CreateUser")).toBe(true);
      expect(matchesPattern("GRAPHQL mutation *", "GRAPHQL mutation DeleteUser")).toBe(true);
      expect(matchesPattern("GRAPHQL mutation *", "GRAPHQL query GetUser")).toBe(false);
    });

    test("exact match with args", () => {
      expect(matchesPattern(
        'GRAPHQL mutation createPullRequest(input: {title: "foo"})',
        'GRAPHQL mutation createPullRequest(input: {title: "foo"})',
      )).toBe(true);
      expect(matchesPattern(
        'GRAPHQL mutation createPullRequest(input: {title: "foo"})',
        'GRAPHQL mutation createPullRequest(input: {title: "bar"})',
      )).toBe(false);
    });

    test("$variable wildcard matches any scalar value", () => {
      expect(matchesPattern(
        "GRAPHQL mutation createUser(name: $ANY)",
        'GRAPHQL mutation createUser(name: "Alice")',
      )).toBe(true);
      expect(matchesPattern(
        "GRAPHQL mutation createUser(name: $ANY)",
        'GRAPHQL mutation createUser(name: "Bob")',
      )).toBe(true);
    });

    test("$variable wildcard matches any object value", () => {
      expect(matchesPattern(
        "GRAPHQL mutation createPullRequest(input: $ANY)",
        'GRAPHQL mutation createPullRequest(input: {title: "foo", body: "bar", headRefName: "branch"})',
      )).toBe(true);
    });

    test("$variable wildcard matches any list value", () => {
      expect(matchesPattern(
        "GRAPHQL query getUsers(ids: $ANY)",
        'GRAPHQL query getUsers(ids: [1, 2, 3])',
      )).toBe(true);
    });

    test("$variable wildcard in nested object", () => {
      expect(matchesPattern(
        'GRAPHQL mutation createPullRequest(input: {branch: "main", title: $ANY})',
        'GRAPHQL mutation createPullRequest(input: {branch: "main", title: "my PR"})',
      )).toBe(true);
      expect(matchesPattern(
        'GRAPHQL mutation createPullRequest(input: {branch: "main", title: $ANY})',
        'GRAPHQL mutation createPullRequest(input: {branch: "develop", title: "my PR"})',
      )).toBe(false);
    });

    test("multiple $ANY wildcards", () => {
      expect(matchesPattern(
        "GRAPHQL mutation createPullRequest(input: $ANY, dryRun: $ANY)",
        'GRAPHQL mutation createPullRequest(input: {title: "foo"}, dryRun: true)',
      )).toBe(true);
    });

    test("unknown variable throws", () => {
      expect(() => matchesPattern(
        "GRAPHQL mutation createUser(name: $FOO)",
        'GRAPHQL mutation createUser(name: "Alice")',
      )).toThrow("Unknown variable $FOO in grant/rejection pattern. Only $ANY is supported.");
    });

    test("field name mismatch with $variable", () => {
      expect(matchesPattern(
        "GRAPHQL mutation createPullRequest(input: $ANY)",
        'GRAPHQL mutation deletePullRequest(input: {id: "123"})',
      )).toBe(false);
    });

    test("arg count mismatch", () => {
      expect(matchesPattern(
        "GRAPHQL mutation createPullRequest(input: $ANY)",
        'GRAPHQL mutation createPullRequest(input: {title: "foo"}, dryRun: true)',
      )).toBe(false);
    });

    test("arg name mismatch", () => {
      expect(matchesPattern(
        "GRAPHQL mutation createPullRequest(data: $ANY)",
        'GRAPHQL mutation createPullRequest(input: {title: "foo"})',
      )).toBe(false);
    });

    test("operation type mismatch with $variable", () => {
      expect(matchesPattern(
        "GRAPHQL query createPullRequest(input: $ANY)",
        'GRAPHQL mutation createPullRequest(input: {title: "foo"})',
      )).toBe(false);
    });

    test("no-arg pattern does not match request with args", () => {
      expect(matchesPattern(
        "GRAPHQL query viewer",
        "GRAPHQL query viewer(id: 1)",
      )).toBe(false);
    });
  });
});
