import { existsSync } from "node:fs";
import {
  getCanonicalGitPath,
  getRepoKey,
  parseGitRequest,
} from "../git-config";
import { getGitHostConfig, getGitRepoConfig } from "../config";
import { createGitBackendRequest, executeGitHttpBackend } from "./backend";
import {
  getBareRepoPath,
  initializeRepo,
  resolveReposRoot,
  setupSshEnv,
} from "./repo";
import { withLock } from "./utils";

export interface LoadedRequest {
  url: URL;
  method: string;
  headers: Headers;
  body: ArrayBuffer | null;
  signal: AbortSignal;
}

export async function handleGitRequest(req: LoadedRequest): Promise<Response> {
  const parsed = parseGitRequest(req.url);
  if (!parsed) {
    return new Response("Not Found - Invalid git request\n", { status: 404 });
  }

  const host = req.url.host;
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
    const repoPath = getBareRepoPath(gitConfig, repoKey);

    // Initialize lazily on first access (or update remote/fetch settings on repeat access)
    await initializeRepo(repoKey, repoConfig, gitConfig, sshEnv);

    if (!existsSync(repoPath)) {
      return new Response(`Internal Error - Missing local repo: ${repoKey}\n`, {
        status: 500,
      });
    }

    const backendUrl = new URL(req.url.toString());
    backendUrl.pathname = getCanonicalGitPath(parsed);

    const backendRequest = createGitBackendRequest(
      {
        method: req.method,
        url: backendUrl,
        headers: req.headers,
        body: req.body,
      },
      resolveReposRoot(gitConfig),
      backendUrl.pathname,
    );

    return executeGitHttpBackend(backendRequest);
  });
}
