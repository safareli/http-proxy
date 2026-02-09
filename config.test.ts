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
  });
});
