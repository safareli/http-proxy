import { describe, expect, test } from "bun:test";
import {
  buildCgiEnv,
  canonicalizeIncomingRequest,
  createGitBackendRequest,
  extractScriptName,
  getRepoPathFromCanonicalPath,
  getServerPort,
} from "./backend";

describe("extractScriptName", () => {
  test("extracts repo .git prefix from canonical git path", () => {
    expect(extractScriptName("/owner/repo.git/info/refs")).toBe(
      "/owner/repo.git",
    );
    expect(extractScriptName("/owner/repo.git/git-upload-pack")).toBe(
      "/owner/repo.git",
    );
  });

  test("falls back to the input path when no .git segment exists", () => {
    expect(extractScriptName("/owner/repo/info/refs")).toBe(
      "/owner/repo/info/refs",
    );
  });
});

describe("getRepoPathFromCanonicalPath", () => {
  test("builds repo cwd from canonical git path", () => {
    expect(
      getRepoPathFromCanonicalPath("/tmp/git-repos", "/owner/repo.git/info/refs"),
    ).toBe("/tmp/git-repos/owner/repo.git");
  });
});

describe("getServerPort", () => {
  test("uses explicit URL port when present", () => {
    expect(getServerPort(new URL("https://example.com:8443/repo.git"))).toBe(
      "8443",
    );
  });

  test("uses protocol defaults when URL has no explicit port", () => {
    expect(getServerPort(new URL("https://example.com/repo.git"))).toBe("443");
    expect(getServerPort(new URL("http://example.com/repo.git"))).toBe("80");
  });
});

describe("buildCgiEnv", () => {
  test("builds expected CGI and git-http-backend variables", () => {
    const env = buildCgiEnv({
      method: "GET",
      url: new URL(
        "https://github.com/owner/repo.git/info/refs?service=git-upload-pack",
      ),
      headers: new Headers({
        "content-type": "application/x-git-upload-pack-request",
        "x-test-header": "test-value",
      }),
      body: null,
      reposRoot: "/tmp/git-repos",
      canonicalPath: "/owner/repo.git/info/refs",
    });

    expect(env.REQUEST_METHOD).toBe("GET");
    expect(env.QUERY_STRING).toBe("service=git-upload-pack");
    expect(env.CONTENT_TYPE).toBe("application/x-git-upload-pack-request");
    expect(env.PATH_INFO).toBe("/owner/repo.git/info/refs");
    expect(env.SCRIPT_NAME).toBe("/owner/repo.git");
    expect(env.SERVER_NAME).toBe("github.com");
    expect(env.SERVER_PORT).toBe("443");
    expect(env.GIT_PROJECT_ROOT).toBe("/tmp/git-repos");
    expect(env.GIT_HTTP_EXPORT_ALL).toBe("1");
    expect(env.GIT_HTTP_UPLOAD_PACK).toBe("true");
    expect(env.GIT_HTTP_RECEIVE_PACK).toBe("true");
    expect(env.HTTP_X_TEST_HEADER).toBe("test-value");
  });
});

describe("createGitBackendRequest", () => {
  test("canonicalizes host and derives canonical git path", () => {
    const request = new Request(
      "https://127.0.0.1/owner/repo/info/refs?service=git-upload-pack",
      {
        method: "GET",
        headers: {
          host: "github.com",
          "x-test": "1",
        },
      },
    );

    const canonical = canonicalizeIncomingRequest(request);
    expect(canonical).not.toBeNull();
    if (!canonical) {
      throw new Error("Expected git request to be canonicalized");
    }

    const backendRequest = createGitBackendRequest(canonical, "/tmp/repos");

    expect(backendRequest.url.host).toBe("github.com");
    expect(backendRequest.headers.has("host")).toBe(false);
    expect(backendRequest.headers.get("x-test")).toBe("1");
    expect(backendRequest.canonicalPath).toBe("/owner/repo.git/info/refs");
    expect(backendRequest.reposRoot).toBe("/tmp/repos");
    expect(
      getRepoPathFromCanonicalPath(
        backendRequest.reposRoot,
        backendRequest.canonicalPath,
      ),
    ).toBe("/tmp/repos/owner/repo.git");
  });

  test("returns null canonicalization for non-git request", () => {
    const request = new Request("https://github.com/owner/repo/issues", {
      method: "GET",
    });

    const canonical = canonicalizeIncomingRequest(request);
    expect(canonical).toBeNull();
  });
});
