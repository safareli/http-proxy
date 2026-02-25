import { describe, expect, test } from "bun:test";
import { isGitRequest, parseGitRequest } from "./git-config";

describe("parseGitRequest", () => {
  test("parses discovery request with .git suffix", () => {
    const url = new URL(
      "https://github.com/owner/repo.git/info/refs?service=git-upload-pack",
    );

    expect(parseGitRequest(url)).toEqual({
      owner: "owner",
      repo: "repo",
      operation: "upload-pack",
      phase: "discovery",
    });
  });

  test("parses discovery request without .git suffix", () => {
    const url = new URL(
      "https://github.com/owner/repo/info/refs?service=git-receive-pack",
    );

    expect(parseGitRequest(url)).toEqual({
      owner: "owner",
      repo: "repo",
      operation: "receive-pack",
      phase: "discovery",
    });
  });

  test("parses data request with .git suffix", () => {
    const url = new URL("https://github.com/owner/repo.git/git-upload-pack");

    expect(parseGitRequest(url)).toEqual({
      owner: "owner",
      repo: "repo",
      operation: "upload-pack",
      phase: "data",
    });
  });

  test("parses data request without .git suffix", () => {
    const url = new URL("https://github.com/owner/repo/git-receive-pack");

    expect(parseGitRequest(url)).toEqual({
      owner: "owner",
      repo: "repo",
      operation: "receive-pack",
      phase: "data",
    });
  });

  test("returns null for invalid git URLs", () => {
    const url = new URL("https://github.com/owner/repo/issues");
    expect(parseGitRequest(url)).toBeNull();
  });

  test("returns null when discovery service is missing/invalid", () => {
    const urlMissing = new URL("https://github.com/owner/repo.git/info/refs");
    const urlInvalid = new URL(
      "https://github.com/owner/repo.git/info/refs?service=git-foo",
    );

    expect(parseGitRequest(urlMissing)).toBeNull();
    expect(parseGitRequest(urlInvalid)).toBeNull();
  });
});

describe("isGitRequest", () => {
  test("returns true for git smart-http URLs", () => {
    expect(
      isGitRequest(
        new URL(
          "https://github.com/owner/repo.git/info/refs?service=git-upload-pack",
        ),
      ),
    ).toBe(true);
    expect(
      isGitRequest(new URL("https://github.com/owner/repo/git-upload-pack")),
    ).toBe(true);
  });

  test("returns false for non-git URLs", () => {
    expect(isGitRequest(new URL("https://github.com/owner/repo/pulls"))).toBe(
      false,
    );
  });
});
