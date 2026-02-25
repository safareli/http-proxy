import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { GitHostConfig, RepoConfig } from "../git-config";
import {
  createUpstreamRepo as createUpstreamRepoShared,
  pushCommitToUpstream as pushCommitToUpstreamShared,
  runGitChecked as runGitCheckedShared,
  type GitIdentity,
  type GitRunOptions,
} from "./assertions";
import {
  getBareRepoPath,
  initializeRepo,
  resolveReposRoot,
  setupSshEnv,
  syncRepoFromUpstream,
} from "./repo";
import { git } from "./utils";

const REPO_TEST_IDENTITY: GitIdentity = {
  email: "tests@example.com",
  name: "Repo Tests",
};

async function runGitChecked(
  args: string[],
  options: GitRunOptions = {},
): Promise<string> {
  return runGitCheckedShared(git, args, options);
}

async function createUpstreamRepo(
  baseDir: string,
  name: string,
): Promise<string> {
  return createUpstreamRepoShared(git, baseDir, name, REPO_TEST_IDENTITY);
}

async function pushCommitToUpstream(
  baseDir: string,
  upstreamPath: string,
  fileName: string,
  content: string,
): Promise<string> {
  return pushCommitToUpstreamShared(
    git,
    baseDir,
    upstreamPath,
    fileName,
    content,
    REPO_TEST_IDENTITY,
  );
}

function createGitHostConfig(
  reposDir: string,
  sshKeyPath?: string,
): GitHostConfig {
  return {
    repos_dir: reposDir,
    ssh_key_path: sshKeyPath,
    repos: {},
  };
}

function createRepoConfig(upstream: string, baseBranch = "main"): RepoConfig {
  return {
    upstream,
    base_branch: baseBranch,
    allowed_push_branches: [],
    rejected_push_branches: [],
    protected_paths: [],
  };
}

describe("git/repo.ts", () => {
  let tmpDir = "";

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "http-proxy-git-repo-test-"));
  });

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("resolveReposRoot and getBareRepoPath resolve nested repo location", () => {
    const gitConfig = createGitHostConfig("./tmp/git-repos");

    const reposRoot = resolveReposRoot(gitConfig);
    const repoPath = getBareRepoPath(gitConfig, "owner/repo");

    expect(reposRoot).toBe(resolve("./tmp/git-repos"));
    expect(repoPath).toBe(join(reposRoot, "owner/repo.git"));
  });

  test("setupSshEnv returns command when ssh_key_path is configured", () => {
    const withKey = createGitHostConfig("./repos", "/run/secrets/github-key");
    const withoutKey = createGitHostConfig("./repos");

    expect(setupSshEnv(withoutKey)).toEqual({});

    const sshEnv = setupSshEnv(withKey);
    expect(sshEnv.GIT_SSH_COMMAND).toMatchInlineSnapshot(
      '"ssh -i /run/secrets/github-key -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/dev/null"',
    );
  });

  test("initializeRepo creates bare repo and configures upstream/fetch/head", async () => {
    const upstreamPath = await createUpstreamRepo(tmpDir, "upstream-main");
    const reposDir = join(tmpDir, "repos");
    const gitConfig = createGitHostConfig(reposDir);

    const repoPath = await initializeRepo(
      "test-owner/test-repo",
      createRepoConfig(upstreamPath, "main"),
      gitConfig,
      {},
    );

    expect(existsSync(repoPath)).toBe(true);
    expect(repoPath).toBe(join(resolve(reposDir), "test-owner/test-repo.git"));

    const originUrl = await runGitChecked(["remote", "get-url", "origin"], {
      cwd: repoPath,
    });
    expect(originUrl).toBe(upstreamPath);

    const fetchRefspecs = await runGitChecked(
      ["config", "--get-all", "remote.origin.fetch"],
      { cwd: repoPath },
    );
    const refspecLines = fetchRefspecs
      .split("\n")
      .filter((line) => line.length > 0);
    expect(refspecLines).toMatchInlineSnapshot(`
      [
        "+refs/heads/*:refs/remotes/origin/*",
        "+refs/heads/*:refs/heads/*",
      ]
    `);

    const receivePack = await runGitChecked(
      ["config", "--get", "http.receivepack"],
      {
        cwd: repoPath,
      },
    );
    expect(receivePack).toBe("true");

    const quarantine = await runGitChecked(
      ["config", "--get", "receive.quarantine"],
      { cwd: repoPath },
    );
    expect(quarantine).toBe("false");

    const headRef = await runGitChecked(["symbolic-ref", "HEAD"], {
      cwd: repoPath,
    });
    expect(headRef).toBe("refs/heads/main");

    const hasMainBranch = await git(
      ["show-ref", "--verify", "refs/heads/main"],
      {
        cwd: repoPath,
      },
    );
    expect(hasMainBranch.success).toBe(true);
  });

  test("initializeRepo is idempotent and updates origin URL on reconfigure", async () => {
    const upstreamA = await createUpstreamRepo(tmpDir, "upstream-a");
    const upstreamB = await createUpstreamRepo(tmpDir, "upstream-b");

    const reposDir = join(tmpDir, "repos");
    const gitConfig = createGitHostConfig(reposDir);
    const repoKey = "owner/repo";

    const repoPath = await initializeRepo(
      repoKey,
      createRepoConfig(upstreamA, "main"),
      gitConfig,
      {},
    );

    const originA = await runGitChecked(["remote", "get-url", "origin"], {
      cwd: repoPath,
    });
    expect(originA).toBe(upstreamA);

    await initializeRepo(
      repoKey,
      createRepoConfig(upstreamB, "main"),
      gitConfig,
      {},
    );

    const originB = await runGitChecked(["remote", "get-url", "origin"], {
      cwd: repoPath,
    });
    expect(originB).toBe(upstreamB);

    const fetchRefspecs = await runGitChecked(
      ["config", "--get-all", "remote.origin.fetch"],
      { cwd: repoPath },
    );
    expect(
      fetchRefspecs
        .split("\n")
        .filter((line) => line === "+refs/heads/*:refs/heads/*"),
    ).toHaveLength(1);
  });

  test("syncRepoFromUpstream fetches latest upstream commits", async () => {
    const upstreamPath = await createUpstreamRepo(tmpDir, "upstream-sync");

    const reposDir = join(tmpDir, "repos");
    const gitConfig = createGitHostConfig(reposDir);
    const repoPath = await initializeRepo(
      "sync-owner/sync-repo",
      createRepoConfig(upstreamPath, "main"),
      gitConfig,
      {},
    );

    const beforeLocalSha = await runGitChecked(
      ["rev-parse", "refs/heads/main"],
      {
        cwd: repoPath,
      },
    );

    const upstreamNewSha = await pushCommitToUpstream(
      tmpDir,
      upstreamPath,
      "CHANGELOG.md",
      "v2 changes\n",
    );

    await syncRepoFromUpstream(repoPath, {});

    const afterLocalSha = await runGitChecked(
      ["rev-parse", "refs/heads/main"],
      {
        cwd: repoPath,
      },
    );

    expect(afterLocalSha).toBe(upstreamNewSha);
    expect(afterLocalSha).not.toBe(beforeLocalSha);
  });
});
