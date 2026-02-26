import { dirname, resolve } from "node:path";
import { z } from "zod";
import {
  GitHostConfigSchema,
  RepoConfigSchema,
  type GitHostConfig,
  type RepoConfig,
} from "../git-config";
import {
  requestHookApproval,
  type HookApprovalRequest,
  type HookApprovalResponse,
} from "./hook-socket";
import { getBareRepoPath, setupSshEnv } from "./repo";
import { branchMatchesPattern, git, matchesAnyPattern } from "./utils";

const ZERO_SHA = "0000000000000000000000000000000000000000";

export interface RefUpdate {
  oldSha: string;
  newSha: string;
  refName: string;
}

export interface ValidationResult {
  allowed: boolean;
  message: string;
}

interface ForcePushValidationResult extends ValidationResult {
  isForcePush: boolean;
}

type PushRefType = "branch" | "tag";

interface ParsedPushRef {
  type: PushRefType;
  name: string;
}

interface ValidatedUpdate {
  update: RefUpdate;
  refType: PushRefType;
  refName: string;
  isForcePush: boolean;
}

export type HookApprovalRequester = (
  request: HookApprovalRequest,
  signal?: AbortSignal,
) => Promise<HookApprovalResponse>;

export interface PreReceiveContext {
  host: string;
  repoKey: string;
  repoPath: string;
  repoConfig: RepoConfig;
  socketPath: string;
  sshEnv: Record<string, string>;
  requestApproval?: HookApprovalRequester;
}

function isZeroSha(sha: string): boolean {
  return sha === ZERO_SHA;
}

function parsePushRef(refName: string): ParsedPushRef | null {
  if (refName.startsWith("refs/heads/")) {
    return {
      type: "branch",
      name: refName.slice("refs/heads/".length),
    };
  }

  if (refName.startsWith("refs/tags/")) {
    return {
      type: "tag",
      name: refName.slice("refs/tags/".length),
    };
  }

  return null;
}

function appendUnique(target: string[], values: readonly string[]): void {
  for (const value of values) {
    if (!target.includes(value)) {
      target.push(value);
    }
  }
}

function applyApprovalPatternChanges(
  response: HookApprovalResponse,
  allowedBranchPatterns: string[],
  rejectedBranchPatterns: string[],
): void {
  if (response.addAllowedPatterns) {
    appendUnique(allowedBranchPatterns, response.addAllowedPatterns);
  }
  if (response.addRejectedPatterns) {
    appendUnique(rejectedBranchPatterns, response.addRejectedPatterns);
  }
}

function formatGitError(prefix: string, stderr: string, stdout: string): string {
  const details = [stderr.trim(), stdout.trim()].filter((value) => value.length > 0);
  if (details.length === 0) {
    return prefix;
  }
  return `${prefix}: ${details.join("\n")}`;
}

function checkChangedFiles(
  diffOutput: string,
  protectedPaths: readonly string[],
): ValidationResult {
  const changedFiles = diffOutput
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const violations = changedFiles.filter((file) =>
    matchesAnyPattern(file, protectedPaths),
  );

  if (violations.length > 0) {
    return {
      allowed: false,
      message:
        "Changes to protected paths detected:\n" +
        violations.map((file) => `  - ${file}`).join("\n"),
    };
  }

  return { allowed: true, message: "No protected path violations" };
}

async function validateProtectedPaths(
  update: RefUpdate,
  repoConfig: RepoConfig,
  repoPath: string,
): Promise<ValidationResult> {
  if (repoConfig.protected_paths.length === 0) {
    return { allowed: true, message: "No protected paths configured" };
  }

  if (!update.refName.startsWith("refs/heads/")) {
    return { allowed: true, message: "Protected paths apply to branches only" };
  }

  if (isZeroSha(update.newSha)) {
    return { allowed: true, message: "Branch deletion - no protected path check" };
  }

  const baseRef = `refs/remotes/origin/${repoConfig.base_branch}`;

  const baseCheck = await git(["rev-parse", "--verify", baseRef], { cwd: repoPath });
  if (!baseCheck.success) {
    return {
      allowed: false,
      message: formatGitError(
        `Base branch ${repoConfig.base_branch} not found; cannot validate protected paths`,
        baseCheck.stderr,
        baseCheck.stdout,
      ),
    };
  }

  const newCommitsResult = await git(
    ["rev-list", update.newSha, "--not", baseRef],
    {
      cwd: repoPath,
    },
  );

  if (!newCommitsResult.success) {
    return {
      allowed: false,
      message: formatGitError(
        "Failed to determine new commits for protected path validation",
        newCommitsResult.stderr,
        newCommitsResult.stdout,
      ),
    };
  }

  const newCommits = newCommitsResult.stdout
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (newCommits.length === 0) {
    return { allowed: true, message: "No new commits to validate" };
  }

  const diffResult = await git(["diff", "--name-only", baseRef, update.newSha], {
    cwd: repoPath,
  });

  if (!diffResult.success) {
    return {
      allowed: false,
      message: formatGitError(
        "Failed to compute diff for protected path validation",
        diffResult.stderr,
        diffResult.stdout,
      ),
    };
  }

  return checkChangedFiles(diffResult.stdout, repoConfig.protected_paths);
}

async function detectForcePush(
  update: RefUpdate,
  repoPath: string,
): Promise<ForcePushValidationResult> {
  if (isZeroSha(update.oldSha) || isZeroSha(update.newSha)) {
    return {
      allowed: true,
      isForcePush: false,
      message: "Branch create/delete is not force push",
    };
  }

  const result = await git(
    ["merge-base", "--is-ancestor", update.oldSha, update.newSha],
    {
      cwd: repoPath,
    },
  );

  if (result.success) {
    return {
      allowed: true,
      isForcePush: false,
      message: "Push is fast-forward",
    };
  }

  if (result.exitCode === 1) {
    return {
      allowed: true,
      isForcePush: true,
      message: "Force push detected",
    };
  }

  return {
    allowed: false,
    isForcePush: false,
    message: formatGitError(
      "Failed to determine whether push is force push",
      result.stderr,
      result.stdout,
    ),
  };
}

function formatRejectionMessage(errors: readonly string[]): string {
  const separator = "=".repeat(50);
  return [
    "",
    separator,
    "PUSH REJECTED",
    separator,
    ...errors,
    separator,
    "",
  ].join("\n");
}

function buildPushRefspec(validatedUpdate: ValidatedUpdate): string {
  const destination =
    validatedUpdate.refType === "branch"
      ? `refs/heads/${validatedUpdate.refName}`
      : `refs/tags/${validatedUpdate.refName}`;

  if (isZeroSha(validatedUpdate.update.newSha)) {
    return `:${destination}`;
  }

  const isTagUpdate =
    validatedUpdate.refType === "tag" &&
    !isZeroSha(validatedUpdate.update.oldSha) &&
    !isZeroSha(validatedUpdate.update.newSha);

  const forcePrefix = validatedUpdate.isForcePush || isTagUpdate ? "+" : "";

  return `${forcePrefix}${validatedUpdate.update.newSha}:${destination}`;
}

function buildPushEnv(sshEnv: Record<string, string>): Record<string, string> {
  const cleanEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key === "GIT_QUARANTINE_PATH") {
      continue;
    }
    if (value !== undefined) {
      cleanEnv[key] = value;
    }
  }
  Object.assign(cleanEnv, sshEnv);
  return cleanEnv;
}

async function pushToUpstream(
  validatedUpdates: readonly ValidatedUpdate[],
  repoPath: string,
  sshEnv: Record<string, string>,
): Promise<ValidationResult> {
  const args = ["push", "origin"];

  for (const validatedUpdate of validatedUpdates) {
    args.push(buildPushRefspec(validatedUpdate));
  }

  const result = await git(args, {
    cwd: repoPath,
    env: buildPushEnv(sshEnv),
    fullEnv: true,
  });

  if (!result.success) {
    return {
      allowed: false,
      message: formatGitError("Failed to push to upstream", result.stderr, result.stdout),
    };
  }

  return { allowed: true, message: "Push forwarded to upstream" };
}

async function validateUpdate(
  update: RefUpdate,
  ctx: PreReceiveContext,
  allowedBranchPatterns: string[],
  rejectedBranchPatterns: string[],
  requestApproval: HookApprovalRequester,
): Promise<{ ok: true; value: ValidatedUpdate } | { ok: false; error: string }> {
  const parsedRef = parsePushRef(update.refName);

  if (!parsedRef || parsedRef.name.length === 0) {
    return {
      ok: false,
      error: `Unsupported ref update: ${update.refName}. Only refs/heads/* and refs/tags/* are supported.`,
    };
  }

  if (parsedRef.type === "tag") {
    let approvalResponse: HookApprovalResponse;
    try {
      approvalResponse = await requestApproval({
        host: ctx.host,
        repo: ctx.repoKey,
        type: "tag",
        ref: parsedRef.name,
      });
    } catch (error) {
      return {
        ok: false,
        error: `Failed to request tag approval for ${parsedRef.name}: ${String(error)}`,
      };
    }

    if (!approvalResponse.allowed) {
      return {
        ok: false,
        error:
          approvalResponse.error ??
          `Tag push rejected for ${parsedRef.name}`,
      };
    }

    return {
      ok: true,
      value: {
        update,
        refType: "tag",
        refName: parsedRef.name,
        isForcePush: false,
      },
    };
  }

  const protectedPathsResult = await validateProtectedPaths(
    update,
    ctx.repoConfig,
    ctx.repoPath,
  );
  if (!protectedPathsResult.allowed) {
    return {
      ok: false,
      error: protectedPathsResult.message,
    };
  }

  const isBranchDeletion = isZeroSha(update.newSha);

  if (!isBranchDeletion) {
    const forcePushResult = await detectForcePush(update, ctx.repoPath);
    if (!forcePushResult.allowed) {
      return {
        ok: false,
        error: forcePushResult.message,
      };
    }

    if (forcePushResult.isForcePush) {
      let approvalResponse: HookApprovalResponse;
      try {
        approvalResponse = await requestApproval({
          host: ctx.host,
          repo: ctx.repoKey,
          type: "force-push",
          ref: parsedRef.name,
        });
      } catch (error) {
        return {
          ok: false,
          error: `Failed to request force-push approval for ${parsedRef.name}: ${String(error)}`,
        };
      }

      if (!approvalResponse.allowed) {
        return {
          ok: false,
          error:
            approvalResponse.error ??
            `Force push rejected for branch ${parsedRef.name}`,
        };
      }

      // Force push approved once. Continue to branch policy checks.
      if (branchMatchesPattern(parsedRef.name, rejectedBranchPatterns)) {
        return {
          ok: false,
          error: `Branch '${parsedRef.name}' is permanently blocked for pushes`,
        };
      }

      if (branchMatchesPattern(parsedRef.name, allowedBranchPatterns)) {
        return {
          ok: true,
          value: {
            update,
            refType: "branch",
            refName: parsedRef.name,
            isForcePush: true,
          },
        };
      }

      let branchApprovalResponse: HookApprovalResponse;
      try {
        branchApprovalResponse = await requestApproval({
          host: ctx.host,
          repo: ctx.repoKey,
          type: "branch",
          ref: parsedRef.name,
          baseBranch: ctx.repoConfig.base_branch,
        });
      } catch (error) {
        return {
          ok: false,
          error: `Failed to request branch approval for ${parsedRef.name}: ${String(error)}`,
        };
      }

      applyApprovalPatternChanges(
        branchApprovalResponse,
        allowedBranchPatterns,
        rejectedBranchPatterns,
      );

      if (!branchApprovalResponse.allowed) {
        return {
          ok: false,
          error:
            branchApprovalResponse.error ??
            `Branch push rejected for ${parsedRef.name}`,
        };
      }

      return {
        ok: true,
        value: {
          update,
          refType: "branch",
          refName: parsedRef.name,
          isForcePush: true,
        },
      };
    }
  }

  if (isBranchDeletion) {
    let approvalResponse: HookApprovalResponse;
    try {
      approvalResponse = await requestApproval({
        host: ctx.host,
        repo: ctx.repoKey,
        type: "branch-deletion",
        ref: parsedRef.name,
      });
    } catch (error) {
      return {
        ok: false,
        error: `Failed to request branch deletion approval for ${parsedRef.name}: ${String(error)}`,
      };
    }

    if (!approvalResponse.allowed) {
      return {
        ok: false,
        error:
          approvalResponse.error ??
          `Branch deletion rejected for ${parsedRef.name}`,
      };
    }

    return {
      ok: true,
      value: {
        update,
        refType: "branch",
        refName: parsedRef.name,
        isForcePush: false,
      },
    };
  }

  if (branchMatchesPattern(parsedRef.name, rejectedBranchPatterns)) {
    return {
      ok: false,
      error: `Branch '${parsedRef.name}' is permanently blocked for pushes`,
    };
  }

  if (branchMatchesPattern(parsedRef.name, allowedBranchPatterns)) {
    return {
      ok: true,
      value: {
        update,
        refType: "branch",
        refName: parsedRef.name,
        isForcePush: false,
      },
    };
  }

  let approvalResponse: HookApprovalResponse;
  try {
    approvalResponse = await requestApproval({
      host: ctx.host,
      repo: ctx.repoKey,
      type: "branch",
      ref: parsedRef.name,
      baseBranch: ctx.repoConfig.base_branch,
    });
  } catch (error) {
    return {
      ok: false,
      error: `Failed to request branch approval for ${parsedRef.name}: ${String(error)}`,
    };
  }

  applyApprovalPatternChanges(
    approvalResponse,
    allowedBranchPatterns,
    rejectedBranchPatterns,
  );

  if (!approvalResponse.allowed) {
    return {
      ok: false,
      error:
        approvalResponse.error ??
        `Branch push rejected for ${parsedRef.name}`,
    };
  }

  return {
    ok: true,
    value: {
      update,
      refType: "branch",
      refName: parsedRef.name,
      isForcePush: false,
    },
  };
}

export async function validateAndPush(
  updates: readonly RefUpdate[],
  ctx: PreReceiveContext,
): Promise<ValidationResult> {
  const errors: string[] = [];
  const validatedUpdates: ValidatedUpdate[] = [];

  const allowedBranchPatterns = [...ctx.repoConfig.allowed_push_branches];
  const rejectedBranchPatterns = [...ctx.repoConfig.rejected_push_branches];

  const requestApproval: HookApprovalRequester =
    ctx.requestApproval ??
    ((request) =>
      requestHookApproval(ctx.socketPath, request, {
        timeoutMs: 255 * 1000,
      }));

  for (const update of updates) {
    const validated = await validateUpdate(
      update,
      ctx,
      allowedBranchPatterns,
      rejectedBranchPatterns,
      requestApproval,
    );

    if (!validated.ok) {
      errors.push(validated.error);
      continue;
    }

    validatedUpdates.push(validated.value);
  }

  if (errors.length > 0) {
    return {
      allowed: false,
      message: formatRejectionMessage(errors),
    };
  }

  if (validatedUpdates.length === 0) {
    return {
      allowed: true,
      message: "No ref updates to process",
    };
  }

  const pushResult = await pushToUpstream(validatedUpdates, ctx.repoPath, ctx.sshEnv);
  if (!pushResult.allowed) {
    return {
      allowed: false,
      message: formatRejectionMessage([pushResult.message]),
    };
  }

  return {
    allowed: true,
    message: "All refs validated and pushed successfully",
  };
}

export function parsePreReceiveInput(input: string): RefUpdate[] {
  return input
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const parts = line.split(/\s+/);
      const oldSha = parts[0];
      const newSha = parts[1];
      const refName = parts[2];

      if (!oldSha || !newSha || !refName) {
        throw new Error(`Invalid pre-receive input line: ${line}`);
      }

      return {
        oldSha,
        newSha,
        refName,
      };
    });
}

interface HookRuntimeConfig {
  gitConfig: GitHostConfig;
  repoConfig: RepoConfig;
}

function getProxyConfigPath(): string {
  return resolve(process.env.PROXY_CONFIG_PATH ?? "./proxy-config.json");
}

async function loadHookRuntimeConfig(
  host: string,
  repoKey: string,
): Promise<HookRuntimeConfig> {
  const configPath = getProxyConfigPath();
  const configFile = Bun.file(configPath);

  if (!(await configFile.exists())) {
    throw new Error(`Proxy config not found: ${configPath}`);
  }

  const rawConfig = (await configFile.json()) as Record<string, unknown>;
  const hostConfig = rawConfig[host];

  if (!hostConfig || typeof hostConfig !== "object") {
    throw new Error(`Host is not configured for git hook approval: ${host}`);
  }

  const parsedGitConfig = GitHostConfigSchema.parse(
    (hostConfig as { git?: unknown }).git,
  );

  // Resolve repos_dir relative to the config file location, not the hook cwd.
  // Hooks run with cwd inside the bare repo, so plain "./git-repos" would
  // otherwise resolve to "<repo>.git/git-repos" and break git subprocesses.
  const gitConfig: GitHostConfig = {
    ...parsedGitConfig,
    repos_dir: resolve(dirname(configPath), parsedGitConfig.repos_dir),
  };

  const repoConfig = RepoConfigSchema.parse(gitConfig.repos[repoKey]);

  return {
    gitConfig,
    repoConfig,
  };
}

async function runPreReceiveHookCli(args: string[]): Promise<number> {
  const host = args[0];
  const repoKey = args[1];

  if (!host || !repoKey) {
    console.error("Usage: bun run git/hooks.ts <host> <owner/repo>");
    return 1;
  }

  const socketPath = process.env.GIT_PROXY_SOCK;
  if (!socketPath) {
    console.error("GIT_PROXY_SOCK is not set");
    return 1;
  }

  let runtimeConfig: HookRuntimeConfig;
  try {
    runtimeConfig = await loadHookRuntimeConfig(host, repoKey);
  } catch (error) {
    const message =
      error instanceof z.ZodError
        ? error.issues
            .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
            .join("; ")
        : String(error);
    console.error(`Failed to load hook runtime config: ${message}`);
    return 1;
  }

  const repoPath = getBareRepoPath(runtimeConfig.gitConfig, repoKey);

  const stdin = await Bun.stdin.text();
  if (!stdin.trim()) {
    return 0;
  }

  let updates: RefUpdate[];
  try {
    updates = parsePreReceiveInput(stdin);
  } catch (error) {
    console.error(`Failed to parse pre-receive input: ${String(error)}`);
    return 1;
  }

  const result = await validateAndPush(updates, {
    host,
    repoKey,
    repoPath,
    repoConfig: runtimeConfig.repoConfig,
    socketPath,
    sshEnv: setupSshEnv(runtimeConfig.gitConfig),
  });

  if (!result.allowed) {
    console.error(result.message);
    return 1;
  }

  return 0;
}

if (import.meta.main) {
  runPreReceiveHookCli(process.argv.slice(2))
    .then((code) => {
      process.exit(code);
    })
    .catch((error) => {
      console.error(`Pre-receive hook failed: ${String(error)}`);
      process.exit(1);
    });
}
