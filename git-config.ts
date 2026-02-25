import { z } from "zod";

export const GitOperationSchema = z.enum(["upload-pack", "receive-pack"]);
export type GitOperation = z.infer<typeof GitOperationSchema>;

export const GitPhaseSchema = z.enum(["discovery", "data"]);
export type GitPhase = z.infer<typeof GitPhaseSchema>;

export const RepoConfigSchema = z.object({
  upstream: z.string().min(1, "upstream URL is required"),
  base_branch: z.string().min(1).default("main"),
  allowed_push_branches: z.array(z.string()).default([]),
  rejected_push_branches: z.array(z.string()).default([]),
  protected_paths: z.array(z.string()).default([]),
});

export type RepoConfig = z.infer<typeof RepoConfigSchema>;
export type RepoConfigInput = z.input<typeof RepoConfigSchema>;

export const GitHostConfigSchema = z.object({
  ssh_key_path: z.string().min(1).optional(),
  repos_dir: z.string().min(1),
  repos: z.record(z.string(), RepoConfigSchema).default({}),
});

export type GitHostConfig = z.infer<typeof GitHostConfigSchema>;

export interface ParsedGitRequest {
  owner: string;
  repo: string;
  operation: GitOperation;
  phase: GitPhase;
}

export function getRepoKey(owner: string, repo: string): string {
  return `${owner}/${repo}`;
}

export function getCanonicalGitPath(parsed: ParsedGitRequest): string {
  if (parsed.phase === "discovery") {
    return `/${parsed.owner}/${parsed.repo}.git/info/refs`;
  }
  return `/${parsed.owner}/${parsed.repo}.git/git-${parsed.operation}`;
}

function safeDecode(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

function parseDiscoveryRequest(pathname: string, service: string | null): ParsedGitRequest | null {
  const match = pathname.match(/^\/([^/]+)\/([^/]+?)(?:\.git)?\/info\/refs$/);
  if (!match) {
    return null;
  }

  if (service !== "git-upload-pack" && service !== "git-receive-pack") {
    return null;
  }

  const [, ownerRaw, repoRaw] = match;
  if (!ownerRaw || !repoRaw) {
    return null;
  }

  const owner = safeDecode(ownerRaw);
  const repo = safeDecode(repoRaw);
  if (!owner || !repo) {
    return null;
  }

  return {
    owner,
    repo,
    operation: service === "git-upload-pack" ? "upload-pack" : "receive-pack",
    phase: "discovery",
  };
}

function parseDataRequest(pathname: string): ParsedGitRequest | null {
  const match = pathname.match(/^\/([^/]+)\/([^/]+?)(?:\.git)?\/git-(upload|receive)-pack$/);
  if (!match) {
    return null;
  }

  const [, ownerRaw, repoRaw, operation] = match;
  if (!ownerRaw || !repoRaw || !operation) {
    return null;
  }

  const owner = safeDecode(ownerRaw);
  const repo = safeDecode(repoRaw);
  if (!owner || !repo) {
    return null;
  }

  return {
    owner,
    repo,
    operation: operation === "upload" ? "upload-pack" : "receive-pack",
    phase: "data",
  };
}

export function parseGitRequest(url: URL): ParsedGitRequest | null {
  const discovery = parseDiscoveryRequest(
    url.pathname,
    url.searchParams.get("service"),
  );
  if (discovery) {
    return discovery;
  }

  return parseDataRequest(url.pathname);
}

export function isGitRequest(url: URL): boolean {
  return parseGitRequest(url) !== null;
}
