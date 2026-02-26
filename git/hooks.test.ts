import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { GitHostConfig, RepoConfig } from "../git-config";
import { mergeProcessEnv } from "../test-utils/env";
import {
  configureGitIdentity,
  createUpstreamRepo as createUpstreamRepoShared,
  runGitChecked as runGitCheckedShared,
  type GitIdentity,
  type GitRunOptions,
} from "./assertions";
import {
  parsePreReceiveInput,
  validateAndPush,
  type PreReceiveContext,
} from "./hooks";
import { type HookApprovalRequest } from "./hook-socket";
import { initializeRepo } from "./repo";
import { git, type GitResult } from "./utils";

const ZERO_SHA = "0000000000000000000000000000000000000000";

const HOOKS_TEST_IDENTITY: GitIdentity = {
  email: "hooks-tests@example.com",
  name: "Hooks Tests",
};

const GIT_TEST_ENV = mergeProcessEnv({
  GIT_TERMINAL_PROMPT: "0",
  HTTP_PROXY: undefined,
  HTTPS_PROXY: undefined,
  ALL_PROXY: undefined,
  NO_PROXY: "localhost,127.0.0.1",
});

interface RepoFixture {
  tmpDir: string;
  reposDir: string;
  upstreamPath: string;
  repoKey: string;
  repoPath: string;
  repoConfig: RepoConfig;
}

const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length > 0) {
    const tmpDir = tmpDirs.pop();
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }
});

async function runGit(
  args: string[],
  options: {
    cwd?: string;
  } = {},
): Promise<GitResult> {
  return git(args, {
    cwd: options.cwd,
    fullEnv: true,
    env: GIT_TEST_ENV,
  });
}

async function runGitChecked(
  args: string[],
  options: GitRunOptions = {},
): Promise<string> {
  return runGitCheckedShared(runGit, args, options);
}

function createGitHostConfig(reposDir: string): GitHostConfig {
  return {
    repos_dir: reposDir,
    repos: {},
  };
}

function createRepoConfig(
  upstream: string,
  overrides: Partial<RepoConfig> = {},
): RepoConfig {
  return {
    upstream,
    base_branch: "main",
    allowed_push_branches: [],
    rejected_push_branches: [],
    protected_paths: [],
    ...overrides,
  };
}

async function createRepoFixture(
  repoConfigOverrides: Partial<RepoConfig> = {},
): Promise<RepoFixture> {
  const tmpDir = mkdtempSync(join(tmpdir(), "http-proxy-hooks-test-"));
  tmpDirs.push(tmpDir);

  const reposDir = join(tmpDir, "repos");
  mkdirSync(reposDir, { recursive: true });

  const upstreamPath = await createUpstreamRepoShared(
    runGit,
    tmpDir,
    "upstream",
    HOOKS_TEST_IDENTITY,
  );

  const repoKey = "owner/repo";
  const repoConfig = createRepoConfig(upstreamPath, repoConfigOverrides);

  const repoPath = await initializeRepo(
    repoKey,
    repoConfig,
    createGitHostConfig(reposDir),
    {},
  );

  return {
    tmpDir,
    reposDir,
    upstreamPath,
    repoKey,
    repoPath,
    repoConfig,
  };
}

function createContext(
  fixture: RepoFixture,
  requestApproval?: PreReceiveContext["requestApproval"],
): PreReceiveContext {
  return {
    host: "github.com",
    repoKey: fixture.repoKey,
    repoPath: fixture.repoPath,
    repoConfig: fixture.repoConfig,
    socketPath: join(fixture.tmpDir, ".unused-hook.sock"),
    sshEnv: {},
    ...(requestApproval ? { requestApproval } : {}),
  };
}

async function createBranchCommitInProxy(
  fixture: RepoFixture,
  branch: string,
  relativeFilePath: string,
  fileContent: string,
): Promise<string> {
  const workDir = join(
    fixture.tmpDir,
    `work-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );

  await runGitChecked(["clone", fixture.repoPath, workDir]);
  await configureGitIdentity(runGit, workDir, HOOKS_TEST_IDENTITY);

  await runGitChecked(["checkout", "-b", branch], { cwd: workDir });

  const absoluteFilePath = join(workDir, relativeFilePath);
  mkdirSync(dirname(absoluteFilePath), { recursive: true });
  writeFileSync(absoluteFilePath, fileContent);

  await runGitChecked(["add", relativeFilePath], { cwd: workDir });
  await runGitChecked(["commit", "-m", `update ${relativeFilePath}`], {
    cwd: workDir,
  });

  const newSha = await runGitChecked(["rev-parse", "HEAD"], {
    cwd: workDir,
  });

  await runGitChecked(["push", "origin", branch], { cwd: workDir });

  rmSync(workDir, { recursive: true, force: true });

  return newSha;
}

async function createTagInProxy(
  fixture: RepoFixture,
  tagName: string,
): Promise<string> {
  const workDir = join(
    fixture.tmpDir,
    `tag-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );

  await runGitChecked(["clone", fixture.repoPath, workDir]);
  await configureGitIdentity(runGit, workDir, HOOKS_TEST_IDENTITY);

  await runGitChecked(["tag", tagName], { cwd: workDir });
  await runGitChecked(["push", "origin", tagName], { cwd: workDir });

  const tagSha = await runGitChecked(["rev-parse", `refs/tags/${tagName}`], {
    cwd: fixture.repoPath,
  });

  rmSync(workDir, { recursive: true, force: true });

  return tagSha;
}

async function createForcePushUpdate(
  fixture: RepoFixture,
  branch: string,
): Promise<{ oldSha: string; newSha: string }> {
  const workDir = join(
    fixture.tmpDir,
    `force-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );

  await runGitChecked(["clone", fixture.repoPath, workDir]);
  await configureGitIdentity(runGit, workDir, HOOKS_TEST_IDENTITY);

  await runGitChecked(["checkout", "-b", branch], { cwd: workDir });

  writeFileSync(join(workDir, "force.txt"), "one\n");
  await runGitChecked(["add", "force.txt"], { cwd: workDir });
  await runGitChecked(["commit", "-m", "force one"], { cwd: workDir });
  await runGitChecked(["push", "origin", branch], { cwd: workDir });

  writeFileSync(join(workDir, "force.txt"), "two\n");
  await runGitChecked(["add", "force.txt"], { cwd: workDir });
  await runGitChecked(["commit", "-m", "force two"], { cwd: workDir });
  await runGitChecked(["push", "origin", branch], { cwd: workDir });

  const oldSha = await runGitChecked(["rev-parse", "HEAD"], { cwd: workDir });

  await runGitChecked(["reset", "--hard", "HEAD~1"], { cwd: workDir });

  writeFileSync(join(workDir, "force.txt"), "three rewritten\n");
  await runGitChecked(["add", "force.txt"], { cwd: workDir });
  await runGitChecked(["commit", "-m", "force rewrite"], { cwd: workDir });

  const newSha = await runGitChecked(["rev-parse", "HEAD"], { cwd: workDir });

  // Make sure the rewritten commit object exists in the proxy repo.
  await runGitChecked(["push", "--force", "origin", branch], { cwd: workDir });

  rmSync(workDir, { recursive: true, force: true });

  return { oldSha, newSha };
}

async function refExists(repoPath: string, refName: string): Promise<boolean> {
  const result = await runGit(["show-ref", "--verify", refName], {
    cwd: repoPath,
  });
  return result.success;
}

describe("git/hooks.ts", () => {
  test("parsePreReceiveInput parses multiple ref updates", () => {
    const updates = parsePreReceiveInput(
      [
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb refs/heads/main",
        "0000000000000000000000000000000000000000 cccccccccccccccccccccccccccccccccccccccc refs/tags/v1.0.0",
      ].join("\n"),
    );

    expect(updates).toEqual([
      {
        oldSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        newSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        refName: "refs/heads/main",
      },
      {
        oldSha: ZERO_SHA,
        newSha: "cccccccccccccccccccccccccccccccccccccccc",
        refName: "refs/tags/v1.0.0",
      },
    ]);
  });

  test("parsePreReceiveInput throws on invalid input", () => {
    expect(() => parsePreReceiveInput("invalid-line-without-three-parts")).toThrow(
      "Invalid pre-receive input line",
    );
  });

  test("validateAndPush rejects protected path changes without requesting approval", async () => {
    const fixture = await createRepoFixture({
      allowed_push_branches: ["agent/*"],
      protected_paths: [".github/**"],
    });

    const branch = "agent/protected";
    const newSha = await createBranchCommitInProxy(
      fixture,
      branch,
      ".github/workflows/ci.yml",
      "name: changed\n",
    );

    let approvalCalls = 0;

    const result = await validateAndPush(
      [
        {
          oldSha: ZERO_SHA,
          newSha,
          refName: `refs/heads/${branch}`,
        },
      ],
      createContext(fixture, async () => {
        approvalCalls += 1;
        return { allowed: true };
      }),
    );

    expect(result.allowed).toBe(false);
    expect(result.message).toContain("Changes to protected paths detected");
    expect(approvalCalls).toBe(0);
    expect(await refExists(fixture.upstreamPath, `refs/heads/${branch}`)).toBe(false);
  });

  test("branch approval patterns apply to following updates in same push", async () => {
    const fixture = await createRepoFixture();

    const branchOne = "agent/one";
    const branchTwo = "agent/two";

    const shaOne = await createBranchCommitInProxy(
      fixture,
      branchOne,
      "one.txt",
      "one\n",
    );
    const shaTwo = await createBranchCommitInProxy(
      fixture,
      branchTwo,
      "two.txt",
      "two\n",
    );

    const approvals: HookApprovalRequest[] = [];

    const result = await validateAndPush(
      [
        {
          oldSha: ZERO_SHA,
          newSha: shaOne,
          refName: `refs/heads/${branchOne}`,
        },
        {
          oldSha: ZERO_SHA,
          newSha: shaTwo,
          refName: `refs/heads/${branchTwo}`,
        },
      ],
      createContext(fixture, async (request) => {
        approvals.push(request);

        if (request.type === "branch" && request.ref === branchOne) {
          return {
            allowed: true,
            addAllowedPatterns: ["agent/*"],
          };
        }

        throw new Error(`Unexpected approval request: ${JSON.stringify(request)}`);
      }),
    );

    expect(result.allowed).toBe(true);
    expect(approvals).toEqual([
      {
        host: "github.com",
        repo: fixture.repoKey,
        type: "branch",
        ref: branchOne,
        baseBranch: "main",
      },
    ]);

    expect(await refExists(fixture.upstreamPath, `refs/heads/${branchOne}`)).toBe(true);
    expect(await refExists(fixture.upstreamPath, `refs/heads/${branchTwo}`)).toBe(true);
  });

  test("tag updates request approval and push to upstream", async () => {
    const fixture = await createRepoFixture();

    const tagName = "v1.0.0";
    const tagSha = await createTagInProxy(fixture, tagName);

    const approvals: HookApprovalRequest[] = [];

    const result = await validateAndPush(
      [
        {
          oldSha: ZERO_SHA,
          newSha: tagSha,
          refName: `refs/tags/${tagName}`,
        },
      ],
      createContext(fixture, async (request) => {
        approvals.push(request);
        return { allowed: true };
      }),
    );

    expect(result.allowed).toBe(true);
    expect(approvals).toEqual([
      {
        host: "github.com",
        repo: fixture.repoKey,
        type: "tag",
        ref: tagName,
      },
    ]);
    expect(await refExists(fixture.upstreamPath, `refs/tags/${tagName}`)).toBe(true);
  });

  test("force push requires dedicated approval", async () => {
    const fixture = await createRepoFixture({
      allowed_push_branches: ["agent/*"],
    });

    const branch = "agent/force";
    const { oldSha, newSha } = await createForcePushUpdate(fixture, branch);

    const approvals: HookApprovalRequest[] = [];

    const result = await validateAndPush(
      [
        {
          oldSha,
          newSha,
          refName: `refs/heads/${branch}`,
        },
      ],
      createContext(fixture, async (request) => {
        approvals.push(request);
        if (request.type === "force-push") {
          return {
            allowed: false,
            error: "Force push rejected by test",
          };
        }
        return { allowed: true };
      }),
    );

    expect(result.allowed).toBe(false);
    expect(result.message).toContain("Force push rejected by test");
    expect(approvals).toEqual([
      {
        host: "github.com",
        repo: fixture.repoKey,
        type: "force-push",
        ref: branch,
      },
    ]);
  });

  test("branch deletion requests one-time approval and deletes upstream ref", async () => {
    const fixture = await createRepoFixture({
      allowed_push_branches: ["agent/*"],
    });

    const branch = "agent/delete";
    const branchSha = await createBranchCommitInProxy(
      fixture,
      branch,
      "delete.txt",
      "delete\n",
    );

    const createResult = await validateAndPush(
      [
        {
          oldSha: ZERO_SHA,
          newSha: branchSha,
          refName: `refs/heads/${branch}`,
        },
      ],
      createContext(fixture),
    );
    expect(createResult.allowed).toBe(true);
    expect(await refExists(fixture.upstreamPath, `refs/heads/${branch}`)).toBe(true);

    const deletionApprovals: HookApprovalRequest[] = [];

    const deleteResult = await validateAndPush(
      [
        {
          oldSha: branchSha,
          newSha: ZERO_SHA,
          refName: `refs/heads/${branch}`,
        },
      ],
      createContext(fixture, async (request) => {
        deletionApprovals.push(request);
        return { allowed: true };
      }),
    );

    expect(deleteResult.allowed).toBe(true);
    expect(deletionApprovals).toEqual([
      {
        host: "github.com",
        repo: fixture.repoKey,
        type: "branch-deletion",
        ref: branch,
      },
    ]);
    expect(await refExists(fixture.upstreamPath, `refs/heads/${branch}`)).toBe(false);
  });
});
