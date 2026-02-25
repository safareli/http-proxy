import { dirname, join, resolve } from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { GitHostConfig, RepoConfig } from "../git-config";
import { git } from "./utils";

export interface RepoHookOptions {
  host: string;
  socketPath: string;
}

export interface InitializeRepoOptions {
  hook?: RepoHookOptions;
}

export function resolveReposRoot(gitConfig: GitHostConfig): string {
  return resolve(gitConfig.repos_dir);
}

export function getBareRepoPath(
  gitConfig: GitHostConfig,
  repoKey: string,
): string {
  return join(resolveReposRoot(gitConfig), `${repoKey}.git`);
}

export function setupSshEnv(gitConfig: GitHostConfig): Record<string, string> {
  const sshKeyPath = gitConfig.ssh_key_path;

  if (!sshKeyPath) {
    return {};
  }

  const sshCommand =
    `ssh -i ${sshKeyPath} ` +
    "-o StrictHostKeyChecking=accept-new " +
    "-o UserKnownHostsFile=/dev/null";

  return { GIT_SSH_COMMAND: sshCommand };
}

function getHookRunnerPath(): string {
  if (process.env.GIT_PROXY_HOOK_RUNNER_PATH) {
    return resolve(process.env.GIT_PROXY_HOOK_RUNNER_PATH);
  }

  return join(dirname(fileURLToPath(import.meta.url)), "hooks.ts");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function getProxyConfigPathForHook(): string {
  return resolve(process.env.PROXY_CONFIG_PATH ?? "./proxy-config.json");
}

function installPreReceiveHook(
  repoPath: string,
  repoKey: string,
  hookOptions: RepoHookOptions,
): void {
  const hooksDir = join(repoPath, "hooks");
  if (!existsSync(hooksDir)) {
    mkdirSync(hooksDir, { recursive: true });
  }

  const hookPath = join(hooksDir, "pre-receive");

  const hookScript = `#!/bin/sh
set -eu

export PROXY_CONFIG_PATH=${shellQuote(getProxyConfigPathForHook())}
export GIT_PROXY_SOCK=${shellQuote(resolve(hookOptions.socketPath))}

exec bun run ${shellQuote(getHookRunnerPath())} ${shellQuote(hookOptions.host)} ${shellQuote(repoKey)}
`;

  writeFileSync(hookPath, hookScript, { mode: 0o755 });
}

async function ensureOriginRemote(
  repoPath: string,
  upstream: string,
): Promise<void> {
  const setUrlResult = await git(["remote", "set-url", "origin", upstream], {
    cwd: repoPath,
  });

  if (setUrlResult.success) {
    return;
  }

  const addRemoteResult = await git(["remote", "add", "origin", upstream], {
    cwd: repoPath,
  });

  if (!addRemoteResult.success) {
    throw new Error(
      `Failed to configure origin remote: ${addRemoteResult.stderr}`,
    );
  }
}

async function ensureFetchRefspec(repoPath: string): Promise<void> {
  const existingRefspecsResult = await git(
    ["config", "--get-all", "remote.origin.fetch"],
    {
      cwd: repoPath,
    },
  );

  const requiredRefspec = "+refs/heads/*:refs/heads/*";

  if (
    existingRefspecsResult.success &&
    existingRefspecsResult.stdout
      .split("\n")
      .map((line) => line.trim())
      .includes(requiredRefspec)
  ) {
    return;
  }

  const addRefspecResult = await git(
    ["config", "--add", "remote.origin.fetch", requiredRefspec],
    {
      cwd: repoPath,
    },
  );

  if (!addRefspecResult.success) {
    throw new Error(
      `Failed to configure fetch refspec: ${addRefspecResult.stderr}`,
    );
  }
}

export async function initializeRepo(
  repoKey: string,
  repoConfig: RepoConfig,
  gitConfig: GitHostConfig,
  sshEnv: Record<string, string>,
  // TODO should be required
  options: InitializeRepoOptions = {},
): Promise<string> {
  const repoPath = getBareRepoPath(gitConfig, repoKey);
  const parentDir = dirname(repoPath);

  if (!existsSync(parentDir)) {
    mkdirSync(parentDir, { recursive: true });
  }

  if (!existsSync(repoPath)) {
    const initResult = await git(["init", "--bare", repoPath]);
    if (!initResult.success) {
      throw new Error(
        `Failed to init bare repo ${repoKey}: ${initResult.stderr}`,
      );
    }
  }

  await ensureOriginRemote(repoPath, repoConfig.upstream);
  await ensureFetchRefspec(repoPath);

  const receivePackResult = await git(["config", "http.receivepack", "true"], {
    cwd: repoPath,
  });
  if (!receivePackResult.success) {
    throw new Error(
      `Failed to enable receive-pack: ${receivePackResult.stderr}`,
    );
  }

  const quarantineResult = await git(
    ["config", "receive.quarantine", "false"],
    {
      cwd: repoPath,
    },
  );
  if (!quarantineResult.success) {
    throw new Error(
      `Failed to disable receive.quarantine: ${quarantineResult.stderr}`,
    );
  }

  if (options.hook) {
    installPreReceiveHook(repoPath, repoKey, options.hook);
  }

  await syncRepoFromUpstream(repoPath, sshEnv);

  const setHeadResult = await git(
    ["symbolic-ref", "HEAD", `refs/heads/${repoConfig.base_branch}`],
    {
      cwd: repoPath,
    },
  );
  if (!setHeadResult.success) {
    throw new Error(
      `Failed to set default HEAD branch: ${setHeadResult.stderr}`,
    );
  }

  return repoPath;
}

export async function syncRepoFromUpstream(
  repoPath: string,
  sshEnv: Record<string, string>,
): Promise<void> {
  const fetchResult = await git(["fetch", "origin", "--prune"], {
    cwd: repoPath,
    env: sshEnv,
  });

  if (!fetchResult.success) {
    throw new Error(`Failed to fetch from upstream: ${fetchResult.stderr}`);
  }
}
