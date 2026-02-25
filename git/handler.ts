import { existsSync } from "node:fs";
import { getRepoKey, type RepoConfigInput } from "../git-config";
import {
  getGitHostConfig,
  getGitRepoConfig,
  setGitRepoConfig,
} from "../config";
import {
  canonicalizeIncomingRequest,
  createGitBackendRequest,
  executeGitHttpBackend,
} from "./backend";
import { initializeRepo, resolveReposRoot, setupSshEnv } from "./repo";
import { withLock } from "./utils";

export type GitReadApprovalResponse =
  | { type: "allow-forever" }
  | { type: "reject-once" };

export type GitReadApprovalFn = (
  host: string,
  repoKey: string,
  signal: AbortSignal,
) => Promise<GitReadApprovalResponse>;

export interface GitRepoApprovalContext {
  host: string;
  hostname: string;
  owner: string;
  repo: string;
  repoKey: string;
}

export interface GitRequestDependencies {
  requestReadApproval?: GitReadApprovalFn | null;
  createRepoConfigOnApproval?: (
    context: GitRepoApprovalContext,
  ) => RepoConfigInput;
}

function createDefaultRepoConfigOnApproval(
  context: GitRepoApprovalContext,
): RepoConfigInput {
  return {
    upstream: `git@${context.hostname}:${context.repoKey}.git`,
    base_branch: "main",
    allowed_push_branches: [],
    rejected_push_branches: [],
    protected_paths: [],
  };
}

export async function handleGitRequest(
  request: Request,
  dependencies: GitRequestDependencies = {},
): Promise<Response> {
  const canonicalRequest = canonicalizeIncomingRequest(request);
  if (!canonicalRequest) {
    return new Response("Not Found - Invalid git request\n", { status: 404 });
  }

  const parsed = canonicalRequest.parsed;

  const host = canonicalRequest.url.host;
  const hostname = canonicalRequest.url.hostname;
  const gitConfig = getGitHostConfig(host);
  if (!gitConfig) {
    return new Response(`Git is not configured for host ${host}\n`, {
      status: 404,
    });
  }

  if (parsed.operation === "receive-pack") {
    return new Response("Git push is not enabled yet\n", { status: 501 });
  }

  const repoKey = getRepoKey(parsed.owner, parsed.repo);
  const lockKey = `${host}/${repoKey}`;
  const sshEnv = setupSshEnv(gitConfig);

  return withLock(lockKey, async () => {
    let repoConfig = getGitRepoConfig(host, repoKey);

    if (!repoConfig) {
      const requestReadApproval = dependencies.requestReadApproval;
      if (!requestReadApproval) {
        return new Response(`Not Found - Unknown repo: ${repoKey}\n`, {
          status: 404,
        });
      }

      console.log(`  → Requesting clone/fetch approval for ${repoKey}`);
      let approval: GitReadApprovalResponse;
      try {
        approval = await requestReadApproval(host, repoKey, request.signal);
      } catch (error) {
        console.error(`  → Clone/fetch approval failed for ${repoKey}: ${error}`);
        return new Response("Forbidden - Approval timeout\n", { status: 403 });
      }

      if (approval.type !== "allow-forever") {
        return new Response("Forbidden - Clone/fetch request rejected\n", {
          status: 403,
        });
      }

      const createRepoConfig =
        dependencies.createRepoConfigOnApproval ??
        createDefaultRepoConfigOnApproval;

      try {
        await setGitRepoConfig(
          host,
          repoKey,
          createRepoConfig({
            host,
            hostname,
            owner: parsed.owner,
            repo: parsed.repo,
            repoKey,
          }),
        );
      } catch (error) {
        console.error(
          `  → Failed to persist approved repo ${repoKey} for ${host}: ${error}`,
        );
        return new Response(
          "Internal Server Error - Failed to persist repo approval\n",
          { status: 500 },
        );
      }

      repoConfig = getGitRepoConfig(host, repoKey);
      if (!repoConfig) {
        return new Response(
          `Internal Error - Failed to load persisted repo config: ${repoKey}\n`,
          { status: 500 },
        );
      }
    }

    const repoPath = await initializeRepo(repoKey, repoConfig, gitConfig, sshEnv);

    if (!existsSync(repoPath)) {
      return new Response(`Internal Error - Missing local repo: ${repoKey}\n`, {
        status: 500,
      });
    }

    const backendRequest = createGitBackendRequest(
      canonicalRequest,
      resolveReposRoot(gitConfig),
    );

    return executeGitHttpBackend(backendRequest);
  });
}
