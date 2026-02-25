import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { GitHostConfig, RepoConfig } from "../git-config";
import {
  getBareRepoPath,
  initializeRepo,
  resolveReposRoot,
  setupSshEnv,
  syncRepoFromUpstream,
} from "./repo";
import { git } from "./utils";

async function runGitChecked(
  args: string[],
  options: {
    cwd?: string;
    env?: Record<string, string>;
    fullEnv?: boolean;
  } = {},
): Promise<string> {
  const result = await git(args, options);
  if (!result.success) {
    throw new Error(
      `git ${args.join(" ")} failed (exit ${result.exitCode})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  return result.stdout.trim();
}

async function createUpstreamRepo(
  baseDir: string,
  name: string,
): Promise<string> {
  const upstreamPath = join(baseDir, `${name}.git`);
  const seedPath = join(baseDir, `${name}-seed`);

  await runGitChecked(["init", "--bare", upstreamPath]);

  mkdirSync(seedPath, { recursive: true });
  await runGitChecked(["init"], { cwd: seedPath });
  await runGitChecked(["config", "user.email", "tests@example.com"], {
    cwd: seedPath,
  });
  await runGitChecked(["config", "user.name", "Repo Tests"], {
    cwd: seedPath,
  });

  writeFileSync(join(seedPath, "README.md"), `# ${name}\n`);
  await runGitChecked(["add", "."], { cwd: seedPath });
  await runGitChecked(["commit", "-m", "initial commit"], { cwd: seedPath });
  await runGitChecked(["branch", "-M", "main"], { cwd: seedPath });
  await runGitChecked(["remote", "add", "origin", upstreamPath], {
    cwd: seedPath,
  });
  await runGitChecked(["push", "-u", "origin", "main"], { cwd: seedPath });

  // Ensure clones default to main.
  await runGitChecked(["symbolic-ref", "HEAD", "refs/heads/main"], {
    cwd: upstreamPath,
  });

  rmSync(seedPath, { recursive: true, force: true });

  return upstreamPath;
}

async function pushCommitToUpstream(
  baseDir: string,
  upstreamPath: string,
  fileName: string,
  content: string,
): Promise<string> {
  const workDir = join(
    baseDir,
    `push-work-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );

  await runGitChecked(["clone", upstreamPath, workDir]);
  await runGitChecked(["config", "user.email", "tests@example.com"], {
    cwd: workDir,
  });
  await runGitChecked(["config", "user.name", "Repo Tests"], {
    cwd: workDir,
  });

  writeFileSync(join(workDir, fileName), content);
  await runGitChecked(["add", fileName], { cwd: workDir });
  await runGitChecked(["commit", "-m", `update ${fileName}`], {
    cwd: workDir,
  });
  await runGitChecked(["push", "origin", "main"], { cwd: workDir });

  const newSha = await runGitChecked(["rev-parse", "HEAD"], { cwd: workDir });

  rmSync(workDir, { recursive: true, force: true });

  return newSha;
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
    expect(sshEnv.GIT_SSH_COMMAND).toContain("ssh -i /run/secrets/github-key");
    expect(sshEnv.GIT_SSH_COMMAND).toContain(
      "StrictHostKeyChecking=accept-new",
    );
    expect(sshEnv.GIT_SSH_COMMAND).toContain("UserKnownHostsFile=/dev/null");
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
    expect(refspecLines).toContain("+refs/heads/*:refs/heads/*");

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
