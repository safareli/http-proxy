import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../config";
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
import { handleGitRequest } from "./handler";
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

describe("git e2e", () => {
  let ctx: E2EContext;

  beforeEach(async () => {
    const tmp = mkdtempSync(join(tmpdir(), "http-proxy-git-e2e-"));
    const reposDir = join(tmp, "repos");
    mkdirSync(reposDir, { recursive: true });

    const configPath = join(tmp, "proxy-config.json");
    const restoreEnv = setEnvVars({ PROXY_CONFIG_PATH: configPath });

    const server = Bun.serve({
      port: 0,
      fetch: handleGitRequest,
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
  });

  afterEach(async () => {
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

  test("push is currently rejected (receive-pack not enabled yet)", async () => {
    const repoKey = "owner/push-disabled";
    const upstreamPath = await createUpstreamRepo(ctx.tmpDir, "upstream-push");

    await configureProxy(ctx, {
      [repoKey]: createRepoConfig(upstreamPath),
    });

    const cloneDir = join(ctx.tmpDir, "client-push");
    const cloneResult = await cloneRepo(ctx.port, `${repoKey}.git`, cloneDir);
    expect(cloneResult.success).toBe(true);

    await configureGitIdentity(runGit, cloneDir, E2E_IDENTITY);

    writeFileSync(join(cloneDir, "feature.txt"), "feature work\n");
    await runGitChecked(["add", "feature.txt"], { cwd: cloneDir });
    await runGitChecked(["commit", "-m", "add feature"], { cwd: cloneDir });

    const pushResult = await runGit(["push", "origin", "main"], {
      cwd: cloneDir,
    });

    expect(pushResult.success).toBe(false);
    expect(normalizeOutput(pushResult.stderr, ctx)).toMatchInlineSnapshot(`
      "remote: Git push is not enabled yet
      fatal: unable to access 'http://localhost:<PORT>/owner/push-disabled.git/': The requested URL returned error: 501
      "
    `);
  });
});
