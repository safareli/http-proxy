import { existsSync } from "node:fs";
import { getRepoKey } from "../git-config";
import { getGitHostConfig, getGitRepoConfig } from "../config";
import {
  canonicalizeIncomingRequest,
  createGitBackendRequest,
  executeGitHttpBackend,
} from "./backend";
import {
  initializeRepo,
  resolveReposRoot,
  setupSshEnv,
} from "./repo";
import { withLock } from "./utils";

export async function handleGitRequest(request: Request): Promise<Response> {
  const canonicalRequest = canonicalizeIncomingRequest(request);
  if (!canonicalRequest) {
    return new Response("Not Found - Invalid git request\n", { status: 404 });
  }

  const parsed = canonicalRequest.parsed;

  const host = canonicalRequest.url.host;
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
  const repoConfig = getGitRepoConfig(host, repoKey);
  if (!repoConfig) {
    return new Response(`Not Found - Unknown repo: ${repoKey}\n`, {
      status: 404,
    });
  }

  const lockKey = `${host}/${repoKey}`;
  const sshEnv = setupSshEnv(gitConfig);

  return withLock(lockKey, async () => {
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
