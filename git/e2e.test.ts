import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { addGitAllowedPushBranch, loadConfig } from "../config";
import type { RepoConfig } from "../git-config";
import { mergeProcessEnv, setEnvVars } from "../test-utils/env";
import {
  configureGitIdentity,
  createUpstreamRepo as createUpstreamRepoShared,
  pushCommitToUpstream,
  runGitChecked as runGitCheckedShared,
  type GitIdentity,
  type GitRunOptions,
} from "./assertions";
import {
  handleGitRequest,
  type GitRequestDependencies,
} from "./handler";
import {
  startHookSocketServer,
  type HookApprovalRequest,
  type HookApprovalResponse,
  type HookSocketServer,
} from "./hook-socket";
import { git, type GitResult } from "./utils";

const E2E_IDENTITY: GitIdentity = {
  email: "e2e@example.com",
  name: "Git E2E",
};

const GIT_TEST_ENV = mergeProcessEnv({
  GIT_TERMINAL_PROMPT: "0",
  HTTP_PROXY: undefined,
  HTTPS_PROXY: undefined,
  ALL_PROXY: undefined,
  NO_PROXY: "localhost,127.0.0.1",
});

interface E2EContext {
  tmpDir: string;
  reposDir: string;
  configPath: string;
  host: string;
  port: number;
  server: ReturnType<typeof Bun.serve>;
  restoreEnv: () => void;
}

type HookApprovalHandler = (
  request: HookApprovalRequest,
  signal: AbortSignal,
) => Promise<HookApprovalResponse>;

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

async function getRefShaOrNull(
  repoPath: string,
  refName: string,
): Promise<string | null> {
  const result = await runGit(["rev-parse", "--verify", refName], {
    cwd: repoPath,
  });

  if (!result.success) {
    return null;
  }

  return result.stdout.trim();
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

async function createUpstreamRepo(baseDir: string, name: string): Promise<string> {
  return createUpstreamRepoShared(runGit, baseDir, name, E2E_IDENTITY);
}

async function pushDirectlyToUpstream(
  baseDir: string,
  upstreamPath: string,
  fileName: string,
  content: string,
): Promise<string> {
  return pushCommitToUpstream(
    runGit,
    baseDir,
    upstreamPath,
    fileName,
    content,
    E2E_IDENTITY,
  );
}

async function configureProxy(
  ctx: E2EContext,
  repos: Record<string, RepoConfig>,
): Promise<void> {
  const config = {
    [ctx.host]: {
      git: {
        repos_dir: ctx.reposDir,
        repos,
      },
    },
  };

  await Bun.write(ctx.configPath, JSON.stringify(config, null, 2));
  await loadConfig();
}

async function cloneRepo(
  port: number,
  repoPath: string,
  targetDir: string,
): Promise<GitResult> {
  return runGit(["clone", `http://localhost:${port}/${repoPath}`, targetDir]);
}

function normalizeOutput(output: string, ctx: E2EContext): string {
  return output
    .replaceAll(ctx.tmpDir, "<TMP_DIR>")
    .replaceAll(`localhost:${ctx.port}`, "localhost:<PORT>");
}

async function cloneRepoAndConfigureIdentity(
  ctx: E2EContext,
  repoPath: string,
  targetDirName: string,
): Promise<string> {
  const cloneDir = join(ctx.tmpDir, targetDirName);
  const cloneResult = await cloneRepo(ctx.port, repoPath, cloneDir);
  expect(cloneResult.success).toBe(true);
  await configureGitIdentity(runGit, cloneDir, E2E_IDENTITY);
  return cloneDir;
}

async function commitFile(
  cwd: string,
  filePath: string,
  content: string,
  message: string,
): Promise<void> {
  const absolutePath = join(cwd, filePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content);
  await runGitChecked(["add", filePath], { cwd });
  await runGitChecked(["commit", "-m", message], { cwd });
}

describe("git e2e", () => {
  let ctx: E2EContext;
  let gitRequestDependencies: GitRequestDependencies | undefined;
  let hookApprovalHandler: HookApprovalHandler;
  let hookSocketServer: HookSocketServer;

  beforeEach(async () => {
    const tmp = mkdtempSync(join(tmpdir(), "http-proxy-git-e2e-"));
    const reposDir = join(tmp, "repos");
    mkdirSync(reposDir, { recursive: true });

    const configPath = join(tmp, "proxy-config.json");
    const restoreEnv = setEnvVars({ PROXY_CONFIG_PATH: configPath });

    gitRequestDependencies = undefined;

    const server = Bun.serve({
      port: 0,
      fetch: (request) => handleGitRequest(request, gitRequestDependencies),
    });

    const port = server.port;
    if (port === undefined) {
      throw new Error("Failed to bind e2e test server port");
    }

    ctx = {
      tmpDir: tmp,
      reposDir,
      configPath,
      host: `localhost:${port}`,
      port,
      server,
      restoreEnv,
    };

    hookApprovalHandler = async () => ({
      allowed: false,
      error: "No hook approval handler configured for this test",
    });

    hookSocketServer = await startHookSocketServer(
      join(reposDir, ".hook.sock"),
      (request, signal) => hookApprovalHandler(request, signal),
    );
  });

  afterEach(async () => {
    await hookSocketServer.close();
    ctx.server.stop(true);
    ctx.restoreEnv();

    // Reset in-memory config to default location after env cleanup.
    await loadConfig();

    rmSync(ctx.tmpDir, { recursive: true, force: true });
  });

  test("clone of configured repo succeeds and lazily initializes bare repo", async () => {
    const repoKey = "owner/repo";
    const upstreamPath = await createUpstreamRepo(ctx.tmpDir, "upstream-clone");

    await configureProxy(ctx, {
      [repoKey]: createRepoConfig(upstreamPath),
    });

    const localBareRepoPath = join(ctx.reposDir, `${repoKey}.git`);
    expect(existsSync(localBareRepoPath)).toBe(false);

    const cloneDir = join(ctx.tmpDir, "client-clone");
    const cloneResult = await cloneRepo(ctx.port, `${repoKey}.git`, cloneDir);

    expect(cloneResult.success).toBe(true);
    expect(existsSync(join(cloneDir, "README.md"))).toBe(true);
    expect(existsSync(localBareRepoPath)).toBe(true);
  });

  test("clone without .git suffix is supported", async () => {
    const repoKey = "owner/no-dot-git";
    const upstreamPath = await createUpstreamRepo(
      ctx.tmpDir,
      "upstream-no-dot-git",
    );

    await configureProxy(ctx, {
      [repoKey]: createRepoConfig(upstreamPath),
    });

    const cloneDir = join(ctx.tmpDir, "client-no-dot-git");
    const cloneResult = await cloneRepo(ctx.port, repoKey, cloneDir);

    expect(cloneResult.success).toBe(true);
    expect(existsSync(join(cloneDir, "README.md"))).toBe(true);
  });

  test("clone checks out configured base branch by default", async () => {
    const repoKey = "owner/custom-base";
    const upstreamPath = await createUpstreamRepo(
      ctx.tmpDir,
      "upstream-custom-base",
    );

    const upstreamSeedDir = join(ctx.tmpDir, "upstream-custom-base-seed");
    await runGitChecked(["clone", upstreamPath, upstreamSeedDir]);
    await configureGitIdentity(runGit, upstreamSeedDir, E2E_IDENTITY);
    await runGitChecked(["checkout", "-b", "develop"], {
      cwd: upstreamSeedDir,
    });
    await commitFile(
      upstreamSeedDir,
      "DEVELOP.md",
      "develop\n",
      "create develop branch",
    );
    await runGitChecked(["push", "-u", "origin", "develop"], {
      cwd: upstreamSeedDir,
    });
    await runGitChecked(["symbolic-ref", "HEAD", "refs/heads/develop"], {
      cwd: upstreamPath,
    });

    await configureProxy(ctx, {
      [repoKey]: createRepoConfig(upstreamPath, "develop"),
    });

    const cloneDir = join(ctx.tmpDir, "client-custom-base");
    const cloneResult = await cloneRepo(ctx.port, `${repoKey}.git`, cloneDir);

    expect(cloneResult.success).toBe(true);

    const currentBranch = await runGitChecked(["branch", "--show-current"], {
      cwd: cloneDir,
    });
    expect(currentBranch).toBe("develop");
  });

  test("fetch syncs latest upstream changes before serving", async () => {
    const repoKey = "owner/fetch-sync";
    const upstreamPath = await createUpstreamRepo(ctx.tmpDir, "upstream-fetch");

    await configureProxy(ctx, {
      [repoKey]: createRepoConfig(upstreamPath),
    });

    const cloneDir = join(ctx.tmpDir, "client-fetch");
    const cloneResult = await cloneRepo(ctx.port, `${repoKey}.git`, cloneDir);
    expect(cloneResult.success).toBe(true);

    const upstreamNewSha = await pushDirectlyToUpstream(
      ctx.tmpDir,
      upstreamPath,
      "CHANGELOG.md",
      "v2\n",
    );

    const fetchResult = await runGit(["fetch", "origin"], { cwd: cloneDir });
    expect(fetchResult.success).toBe(true);

    const fetchedSha = await runGitChecked(["rev-parse", "origin/main"], {
      cwd: cloneDir,
    });
    expect(fetchedSha).toBe(upstreamNewSha);
  });

  test("unknown repo is rejected", async () => {
    const upstreamPath = await createUpstreamRepo(ctx.tmpDir, "upstream-known");

    await configureProxy(ctx, {
      "owner/known": createRepoConfig(upstreamPath),
    });

    const cloneDir = join(ctx.tmpDir, "client-unknown");
    const cloneResult = await cloneRepo(
      ctx.port,
      "owner/unknown.git",
      cloneDir,
    );

    expect(cloneResult.success).toBe(false);
    expect(cloneResult.exitCode).toBe(128);
    expect(normalizeOutput(cloneResult.stderr, ctx)).toMatchInlineSnapshot(`
      "Cloning into '<TMP_DIR>/client-unknown'...
      remote: Not Found - Unknown repo: owner/unknown
      fatal: repository 'http://localhost:<PORT>/owner/unknown.git/' not found
      "
    `);
  });

  test("unknown repo can be approved for clone/fetch and persisted", async () => {
    const repoKey = "owner/newly-approved";
    const upstreamPath = await createUpstreamRepo(
      ctx.tmpDir,
      "upstream-approved-repo",
    );

    await configureProxy(ctx, {});

    let approvalCalls = 0;
    gitRequestDependencies = {
      requestReadApproval: async (host, requestedRepoKey) => {
        approvalCalls += 1;
        expect(host).toBe(ctx.host);
        expect(requestedRepoKey).toBe(repoKey);
        return { type: "allow-forever" };
      },
      createRepoConfigOnApproval: () => createRepoConfig(upstreamPath),
    };

    const cloneDir = join(ctx.tmpDir, "client-approved");
    const cloneResult = await cloneRepo(ctx.port, `${repoKey}.git`, cloneDir);

    expect(cloneResult.success).toBe(true);
    expect(approvalCalls).toBe(1);
    expect(existsSync(join(cloneDir, "README.md"))).toBe(true);
    expect(existsSync(join(ctx.reposDir, `${repoKey}.git`))).toBe(true);

    const savedConfig = (await Bun.file(ctx.configPath).json()) as {
      [host: string]: {
        git?: {
          repos?: Record<string, RepoConfig>;
        };
      };
    };

    expect(savedConfig[ctx.host]?.git?.repos?.[repoKey]).toEqual(
      createRepoConfig(upstreamPath),
    );
  });

  test("unknown repo approval reject-once blocks clone and does not persist", async () => {
    const repoKey = "owner/rejected";
    await configureProxy(ctx, {});

    gitRequestDependencies = {
      requestReadApproval: async () => ({ type: "reject-once" }),
    };

    const cloneDir = join(ctx.tmpDir, "client-rejected");
    const cloneResult = await cloneRepo(ctx.port, `${repoKey}.git`, cloneDir);

    expect(cloneResult.success).toBe(false);
    expect(normalizeOutput(cloneResult.stderr, ctx)).toMatchInlineSnapshot(`
      "Cloning into '<TMP_DIR>/client-rejected'...
      remote: Forbidden - Clone/fetch request rejected
      fatal: unable to access 'http://localhost:<PORT>/owner/rejected.git/': The requested URL returned error: 403
      "
    `);

    const savedConfig = (await Bun.file(ctx.configPath).json()) as {
      [host: string]: {
        git?: {
          repos?: Record<string, RepoConfig>;
        };
      };
    };

    expect(savedConfig[ctx.host]?.git?.repos?.[repoKey]).toBeUndefined();
  });

  test("push to unapproved branch can be allowed forever with pattern", async () => {
    const repoKey = "owner/push-pattern";
    const upstreamPath = await createUpstreamRepo(
      ctx.tmpDir,
      "upstream-push-pattern",
    );

    await configureProxy(ctx, {
      [repoKey]: createRepoConfig(upstreamPath),
    });

    let branchApprovalCalls = 0;
    hookApprovalHandler = async (request) => {
      expect(request.host).toBe(ctx.host);
      expect(request.repo).toBe(repoKey);

      if (request.type !== "branch") {
        throw new Error(`Unexpected approval request type: ${request.type}`);
      }

      branchApprovalCalls += 1;
      await addGitAllowedPushBranch(ctx.host, repoKey, "agent/*");
      return {
        allowed: true,
        addAllowedPatterns: ["agent/*"],
      };
    };

    const cloneDir = await cloneRepoAndConfigureIdentity(
      ctx,
      `${repoKey}.git`,
      "client-push-pattern",
    );

    await runGitChecked(["checkout", "-b", "agent/feature-x"], {
      cwd: cloneDir,
    });

    await commitFile(cloneDir, "feature.txt", "first\n", "first commit");

    const firstPush = await runGit(["push", "origin", "agent/feature-x"], {
      cwd: cloneDir,
    });
    expect(firstPush.success).toBe(true);
    expect(branchApprovalCalls).toBe(1);

    const configAfterFirstPush = (await Bun.file(ctx.configPath).json()) as {
      [host: string]: {
        git?: {
          repos?: Record<string, RepoConfig>;
        };
      };
    };

    expect(
      configAfterFirstPush[ctx.host]?.git?.repos?.[repoKey]?.allowed_push_branches,
    ).toMatchInlineSnapshot(`
      [
        "agent/*",
      ]
    `);

    await commitFile(cloneDir, "feature.txt", "second\n", "second commit");

    const secondPush = await runGit(["push", "origin", "agent/feature-x"], {
      cwd: cloneDir,
    });
    expect(secondPush.success).toBe(true);
    expect(branchApprovalCalls).toBe(1);
  });

  test("push to permanently rejected branch is blocked without approval", async () => {
    const repoKey = "owner/rejected-main";
    const upstreamPath = await createUpstreamRepo(
      ctx.tmpDir,
      "upstream-rejected-main",
    );

    await configureProxy(ctx, {
      [repoKey]: {
        ...createRepoConfig(upstreamPath),
        rejected_push_branches: ["main"],
      },
    });

    let approvalCalls = 0;
    hookApprovalHandler = async () => {
      approvalCalls += 1;
      return { allowed: true };
    };

    const cloneDir = await cloneRepoAndConfigureIdentity(
      ctx,
      `${repoKey}.git`,
      "client-rejected-main",
    );

    await commitFile(cloneDir, "blocked.txt", "blocked\n", "blocked commit");

    const upstreamMainBeforePush = await getRefShaOrNull(
      upstreamPath,
      "refs/heads/main",
    );
    if (!upstreamMainBeforePush) {
      throw new Error("Expected upstream main to exist before rejected push");
    }

    const pushResult = await runGit(["push", "origin", "main"], {
      cwd: cloneDir,
    });

    expect(pushResult.success).toBe(false);
    expect(normalizeOutput(pushResult.stderr, ctx)).toMatchInlineSnapshot(`
      "remote: 
      remote: ==================================================        
      remote: PUSH REJECTED        
      remote: ==================================================        
      remote: Branch 'main' is permanently blocked for pushes        
      remote: ==================================================        
      remote: 
      To http://localhost:<PORT>/owner/rejected-main.git
       ! [remote rejected] main -> main (pre-receive hook declined)
      error: failed to push some refs to 'http://localhost:<PORT>/owner/rejected-main.git'
      "
    `);

    const upstreamMainAfterPush = await getRefShaOrNull(
      upstreamPath,
      "refs/heads/main",
    );
    expect(upstreamMainAfterPush).toBe(upstreamMainBeforePush);

    expect(approvalCalls).toBe(0);
  });

  test("tag pushes always request one-time approval", async () => {
    const repoKey = "owner/tag-approval";
    const upstreamPath = await createUpstreamRepo(
      ctx.tmpDir,
      "upstream-tag-approval",
    );

    await configureProxy(ctx, {
      [repoKey]: createRepoConfig(upstreamPath),
    });

    let tagApprovalCalls = 0;
    hookApprovalHandler = async (request) => {
      if (request.type !== "tag") {
        throw new Error(`Unexpected approval request type: ${request.type}`);
      }
      tagApprovalCalls += 1;
      return { allowed: true };
    };

    const cloneDir = await cloneRepoAndConfigureIdentity(
      ctx,
      `${repoKey}.git`,
      "client-tag-approval",
    );

    await runGitChecked(["tag", "v1.0.0"], { cwd: cloneDir });
    const firstPush = await runGit(["push", "origin", "v1.0.0"], {
      cwd: cloneDir,
    });
    expect(firstPush.success).toBe(true);

    await runGitChecked(["tag", "v1.0.1"], { cwd: cloneDir });
    const secondPush = await runGit(["push", "origin", "v1.0.1"], {
      cwd: cloneDir,
    });
    expect(secondPush.success).toBe(true);

    expect(tagApprovalCalls).toBe(2);
  });

  test("push touching protected paths is rejected without approval", async () => {
    const repoKey = "owner/protected-paths";
    const upstreamPath = await createUpstreamRepo(
      ctx.tmpDir,
      "upstream-protected-paths",
    );

    await configureProxy(ctx, {
      [repoKey]: {
        ...createRepoConfig(upstreamPath),
        allowed_push_branches: ["agent/*"],
        protected_paths: [".github/**"],
      },
    });

    let approvalCalls = 0;
    hookApprovalHandler = async () => {
      approvalCalls += 1;
      return { allowed: true };
    };

    const cloneDir = await cloneRepoAndConfigureIdentity(
      ctx,
      `${repoKey}.git`,
      "client-protected-paths",
    );

    await runGitChecked(["checkout", "-b", "agent/protected"], {
      cwd: cloneDir,
    });

    await commitFile(
      cloneDir,
      ".github/workflows/ci.yml",
      "name: blocked\n",
      "modify protected workflow",
    );

    const upstreamMainBeforePush = await getRefShaOrNull(
      upstreamPath,
      "refs/heads/main",
    );
    if (!upstreamMainBeforePush) {
      throw new Error("Expected upstream main to exist before rejected protected-path push");
    }

    const pushResult = await runGit(["push", "origin", "agent/protected"], {
      cwd: cloneDir,
    });

    expect(pushResult.success).toBe(false);
    expect(normalizeOutput(pushResult.stderr, ctx)).toMatchInlineSnapshot(`
      "remote: 
      remote: ==================================================        
      remote: PUSH REJECTED        
      remote: ==================================================        
      remote: Changes to protected paths detected:        
      remote:   - .github/workflows/ci.yml        
      remote: ==================================================        
      remote: 
      To http://localhost:<PORT>/owner/protected-paths.git
       ! [remote rejected] agent/protected -> agent/protected (pre-receive hook declined)
      error: failed to push some refs to 'http://localhost:<PORT>/owner/protected-paths.git'
      "
    `);

    const upstreamProtectedBranchAfterPush = await getRefShaOrNull(
      upstreamPath,
      "refs/heads/agent/protected",
    );
    expect(upstreamProtectedBranchAfterPush).toBeNull();

    const upstreamMainAfterPush = await getRefShaOrNull(
      upstreamPath,
      "refs/heads/main",
    );
    expect(upstreamMainAfterPush).toBe(upstreamMainBeforePush);

    expect(approvalCalls).toBe(0);
  });

  test("push touching protected paths then reverting is allowed", async () => {
    const repoKey = "owner/protected-revert";
    const upstreamPath = await createUpstreamRepo(
      ctx.tmpDir,
      "upstream-protected-revert",
    );

    await configureProxy(ctx, {
      [repoKey]: {
        ...createRepoConfig(upstreamPath),
        allowed_push_branches: ["agent/*"],
        protected_paths: [".github/**"],
      },
    });

    let approvalCalls = 0;
    hookApprovalHandler = async () => {
      approvalCalls += 1;
      return { allowed: true };
    };

    const cloneDir = await cloneRepoAndConfigureIdentity(
      ctx,
      `${repoKey}.git`,
      "client-protected-revert",
    );

    await runGitChecked(["checkout", "-b", "agent/revert-protected"], {
      cwd: cloneDir,
    });

    await commitFile(
      cloneDir,
      ".github/workflows/ci.yml",
      "name: blocked\n",
      "add protected workflow",
    );

    const upstreamMainBeforeFirstPush = await getRefShaOrNull(
      upstreamPath,
      "refs/heads/main",
    );
    if (!upstreamMainBeforeFirstPush) {
      throw new Error("Expected upstream main to exist before rejected protected-path push");
    }

    const firstPush = await runGit(["push", "origin", "agent/revert-protected"], {
      cwd: cloneDir,
    });
    expect(firstPush.success).toBe(false);
    expect(normalizeOutput(firstPush.stderr, ctx)).toMatchInlineSnapshot(`
      "remote: 
      remote: ==================================================        
      remote: PUSH REJECTED        
      remote: ==================================================        
      remote: Changes to protected paths detected:        
      remote:   - .github/workflows/ci.yml        
      remote: ==================================================        
      remote: 
      To http://localhost:<PORT>/owner/protected-revert.git
       ! [remote rejected] agent/revert-protected -> agent/revert-protected (pre-receive hook declined)
      error: failed to push some refs to 'http://localhost:<PORT>/owner/protected-revert.git'
      "
    `);

    const upstreamBranchAfterRejectedPush = await getRefShaOrNull(
      upstreamPath,
      "refs/heads/agent/revert-protected",
    );
    expect(upstreamBranchAfterRejectedPush).toBeNull();

    const upstreamMainAfterRejectedPush = await getRefShaOrNull(
      upstreamPath,
      "refs/heads/main",
    );
    expect(upstreamMainAfterRejectedPush).toBe(upstreamMainBeforeFirstPush);

    await runGitChecked(["rm", "-r", ".github"], { cwd: cloneDir });
    await runGitChecked(["commit", "-m", "remove protected workflow"], {
      cwd: cloneDir,
    });

    await commitFile(cloneDir, "safe.txt", "safe\n", "add safe file");

    const secondPush = await runGit(["push", "origin", "agent/revert-protected"], {
      cwd: cloneDir,
    });
    expect(secondPush.success).toBe(true);

    const upstreamBranchSha = await runGitChecked(
      ["rev-parse", "--verify", "refs/heads/agent/revert-protected"],
      {
        cwd: upstreamPath,
      },
    );
    expect(upstreamBranchSha.length).toBeGreaterThan(0);
    expect(approvalCalls).toBe(0);
  });

  test("force push requires one-time approval every time", async () => {
    const repoKey = "owner/force-approval";
    const upstreamPath = await createUpstreamRepo(
      ctx.tmpDir,
      "upstream-force-approval",
    );

    await configureProxy(ctx, {
      [repoKey]: {
        ...createRepoConfig(upstreamPath),
        allowed_push_branches: ["agent/*"],
      },
    });

    let forceApprovalCalls = 0;
    hookApprovalHandler = async (request) => {
      if (request.type !== "force-push") {
        throw new Error(`Unexpected approval request type: ${request.type}`);
      }

      forceApprovalCalls += 1;
      return { allowed: forceApprovalCalls > 1 };
    };

    const cloneDir = await cloneRepoAndConfigureIdentity(
      ctx,
      `${repoKey}.git`,
      "client-force-approval",
    );

    await runGitChecked(["checkout", "-b", "agent/force"], { cwd: cloneDir });

    await commitFile(cloneDir, "force.txt", "1\n", "force 1");
    expect((await runGit(["push", "origin", "agent/force"], { cwd: cloneDir })).success).toBe(true);

    await commitFile(cloneDir, "force.txt", "2\n", "force 2");
    expect((await runGit(["push", "origin", "agent/force"], { cwd: cloneDir })).success).toBe(true);

    await runGitChecked(["reset", "--hard", "HEAD~1"], { cwd: cloneDir });
    await commitFile(cloneDir, "force.txt", "alternate\n", "force rewrite");

    const upstreamBranchBeforeRejectedForcePush = await getRefShaOrNull(
      upstreamPath,
      "refs/heads/agent/force",
    );
    if (!upstreamBranchBeforeRejectedForcePush) {
      throw new Error("Expected upstream force branch to exist before rejected force push");
    }

    const firstForcePush = await runGit(
      ["push", "--force", "origin", "agent/force"],
      {
        cwd: cloneDir,
      },
    );
    expect(firstForcePush.success).toBe(false);
    expect(normalizeOutput(firstForcePush.stderr, ctx)).toMatchInlineSnapshot(`
      "remote: 
      remote: ==================================================        
      remote: PUSH REJECTED        
      remote: ==================================================        
      remote: Force push rejected for branch agent/force        
      remote: ==================================================        
      remote: 
      To http://localhost:<PORT>/owner/force-approval.git
       ! [remote rejected] agent/force -> agent/force (pre-receive hook declined)
      error: failed to push some refs to 'http://localhost:<PORT>/owner/force-approval.git'
      "
    `);

    const upstreamBranchAfterRejectedForcePush = await getRefShaOrNull(
      upstreamPath,
      "refs/heads/agent/force",
    );
    expect(upstreamBranchAfterRejectedForcePush).toBe(
      upstreamBranchBeforeRejectedForcePush,
    );

    const secondForcePush = await runGit(
      ["push", "--force", "origin", "agent/force"],
      {
        cwd: cloneDir,
      },
    );
    expect(secondForcePush.success).toBe(true);

    expect(forceApprovalCalls).toBe(2);
  });

  test("branch deletion requires one-time approval", async () => {
    const repoKey = "owner/delete-approval";
    const upstreamPath = await createUpstreamRepo(
      ctx.tmpDir,
      "upstream-delete-approval",
    );

    await configureProxy(ctx, {
      [repoKey]: {
        ...createRepoConfig(upstreamPath),
        allowed_push_branches: ["agent/*"],
      },
    });

    let deletionApprovalCalls = 0;
    hookApprovalHandler = async (request) => {
      if (request.type !== "branch-deletion") {
        throw new Error(`Unexpected approval request type: ${request.type}`);
      }
      deletionApprovalCalls += 1;
      return { allowed: deletionApprovalCalls > 1 };
    };

    const cloneDir = await cloneRepoAndConfigureIdentity(
      ctx,
      `${repoKey}.git`,
      "client-delete-approval",
    );

    await runGitChecked(["checkout", "-b", "agent/delete-me"], { cwd: cloneDir });
    await commitFile(cloneDir, "delete.txt", "delete me\n", "add delete branch");

    const branchPush = await runGit(["push", "origin", "agent/delete-me"], {
      cwd: cloneDir,
    });
    expect(branchPush.success).toBe(true);

    const upstreamBranchBeforeRejectedDelete = await getRefShaOrNull(
      upstreamPath,
      "refs/heads/agent/delete-me",
    );
    if (!upstreamBranchBeforeRejectedDelete) {
      throw new Error("Expected upstream delete branch to exist before rejected deletion");
    }

    const firstDelete = await runGit(["push", "origin", ":agent/delete-me"], {
      cwd: cloneDir,
    });
    expect(firstDelete.success).toBe(false);
    expect(normalizeOutput(firstDelete.stderr, ctx)).toMatchInlineSnapshot(`
      "remote: 
      remote: ==================================================        
      remote: PUSH REJECTED        
      remote: ==================================================        
      remote: Branch deletion rejected for agent/delete-me        
      remote: ==================================================        
      remote: 
      To http://localhost:<PORT>/owner/delete-approval.git
       ! [remote rejected] agent/delete-me (pre-receive hook declined)
      error: failed to push some refs to 'http://localhost:<PORT>/owner/delete-approval.git'
      "
    `);

    const upstreamBranchAfterRejectedDelete = await getRefShaOrNull(
      upstreamPath,
      "refs/heads/agent/delete-me",
    );
    expect(upstreamBranchAfterRejectedDelete).toBe(
      upstreamBranchBeforeRejectedDelete,
    );

    const secondDelete = await runGit(
      ["push", "origin", ":agent/delete-me"],
      {
        cwd: cloneDir,
      },
    );
    expect(secondDelete.success).toBe(true);

    expect(deletionApprovalCalls).toBe(2);
  });
});
