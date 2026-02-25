import { z } from "zod";
import { loadOpenApiSpec, type OpenApiSpecConfig } from "./openapi";
import { matchesGraphQLFieldPattern } from "./graphql";
import {
  GitHostConfigSchema,
  RepoConfigSchema,
  type GitHostConfig,
  type RepoConfig,
  type RepoConfigInput,
} from "./git-config";

const DEFAULT_CONFIG_FILE = "./proxy-config.json";

function getConfigFilePath(): string {
  return process.env.PROXY_CONFIG_PATH ?? DEFAULT_CONFIG_FILE;
}

const SecretConfigSchema = z.object({
  secret: z.string().min(1),
  secretEnvVarName: z.string().min(1),
  grants: z.array(z.string()).default([]),
  rejections: z.array(z.string()).default([]),
});

// TODO move to openapi.ts and derive OpenApiSpecConfig from schema
const OpenApiSpecConfigSchema: z.ZodType<OpenApiSpecConfig> = z
  .object({
    url: z.string().min(1).optional(),
    path: z.string().min(1).optional(),
  })
  .refine((value) => value.url || value.path, {
    message: "openApiSpec requires either url or path",
  });

const HostConfigSchema = z.object({
  secrets: z.array(SecretConfigSchema).default([]),
  graphqlEndpoints: z.array(z.string()).optional(),
  openApiSpec: OpenApiSpecConfigSchema.optional(),
  git: GitHostConfigSchema.optional(),
});

const ProxyConfigSchema = z.record(z.string(), HostConfigSchema);

export type SecretConfig = z.infer<typeof SecretConfigSchema>;
export type HostConfig = z.infer<typeof HostConfigSchema>;
export type ProxyConfig = z.infer<typeof ProxyConfigSchema>;

let config: ProxyConfig = {};

function formatZodErrors(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "root";
      return `  - ${path}: ${issue.message}`;
    })
    .join("\n");
}

export async function loadConfig(): Promise<void> {
  const configFilePath = getConfigFilePath();
  const file = Bun.file(configFilePath);
  if (await file.exists()) {
    const rawConfig = await file.json();
    const parsed = ProxyConfigSchema.safeParse(rawConfig);
    if (!parsed.success) {
      throw new Error(
        `Invalid ${configFilePath}:\n${formatZodErrors(parsed.error)}`,
      );
    }
    config = parsed.data;
  } else {
    config = {};
  }

  // Load OpenAPI specs for all configured hosts
  for (const [host, hostConfig] of Object.entries(config)) {
    if (hostConfig.openApiSpec) {
      await loadOpenApiSpec(host, hostConfig.openApiSpec);
    }
  }
}

export async function saveConfig(): Promise<void> {
  await Bun.write(getConfigFilePath(), JSON.stringify(config, null, 2) + "\n");
}

export function getConfig(): ProxyConfig {
  return config;
}

export function getHostConfig(host: string): HostConfig | null {
  return config[host] ?? null;
}

export function getGitHostConfig(host: string): GitHostConfig | null {
  return config[host]?.git ?? null;
}

export function getGitRepoConfig(
  host: string,
  repoKey: string,
): RepoConfig | null {
  return config[host]?.git?.repos[repoKey] ?? null;
}

export async function setGitRepoConfig(
  host: string,
  repoKey: string,
  repoConfig: RepoConfigInput,
): Promise<void> {
  const hostGitConfig = config[host]?.git;
  if (!hostGitConfig) {
    throw new Error(`Host ${host} does not have git configuration`);
  }

  hostGitConfig.repos[repoKey] = RepoConfigSchema.parse(repoConfig);
  await saveConfig();
}

export async function addGitAllowedPushBranch(
  host: string,
  repoKey: string,
  pattern: string,
): Promise<void> {
  const repoConfig = config[host]?.git?.repos[repoKey];
  if (!repoConfig) {
    throw new Error(`Repo ${repoKey} is not configured for host ${host}`);
  }

  if (repoConfig.allowed_push_branches.includes(pattern)) {
    return;
  }

  repoConfig.allowed_push_branches.push(pattern);
  await saveConfig();
}

export async function addGitRejectedPushBranch(
  host: string,
  repoKey: string,
  pattern: string,
): Promise<void> {
  const repoConfig = config[host]?.git?.repos[repoKey];
  if (!repoConfig) {
    throw new Error(`Repo ${repoKey} is not configured for host ${host}`);
  }

  if (repoConfig.rejected_push_branches.includes(pattern)) {
    return;
  }

  repoConfig.rejected_push_branches.push(pattern);
  await saveConfig();
}

export function getRequestKey(method: string, path: string): string {
  const pathWithoutQuery = path.split("?")[0];
  return `${method} ${pathWithoutQuery}`;
}

export function isGraphQLEndpoint(host: string, path: string): boolean {
  const hostConfig = config[host];
  if (!hostConfig?.graphqlEndpoints) {
    return false;
  }
  const pathWithoutQuery = path.split("?")[0] ?? path;
  return hostConfig.graphqlEndpoints.includes(pathWithoutQuery);
}

export function matchesPattern(pattern: string, requestKey: string): boolean {
  // Exact match fast path
  if (pattern === requestKey) {
    return true;
  }

  const patternSpaceIdx = pattern.indexOf(" ");
  const requestSpaceIdx = requestKey.indexOf(" ");

  if (patternSpaceIdx === -1 || requestSpaceIdx === -1) {
    return false;
  }

  const patternMethod = pattern.slice(0, patternSpaceIdx);
  const requestMethod = requestKey.slice(0, requestSpaceIdx);

  if (patternMethod !== requestMethod) {
    return false;
  }

  const patternRest = pattern.slice(patternSpaceIdx + 1);
  const requestRest = requestKey.slice(requestSpaceIdx + 1);

  // Handle "METHOD *" - matches everything
  if (patternRest === "*") {
    return true;
  }

  // Handle GraphQL: "GRAPHQL query *" or "GRAPHQL mutation *"
  if (patternMethod === "GRAPHQL") {
    if (patternRest === "query *") {
      return requestRest.startsWith("query ");
    }
    if (patternRest === "mutation *") {
      return requestRest.startsWith("mutation ");
    }
    // Split "query fieldName(args)" into op type + field string
    const patternOpIdx = patternRest.indexOf(" ");
    const requestOpIdx = requestRest.indexOf(" ");
    if (patternOpIdx === -1 || requestOpIdx === -1) return false;

    if (
      patternRest.slice(0, patternOpIdx) !== requestRest.slice(0, requestOpIdx)
    ) {
      return false;
    }
    return matchesGraphQLFieldPattern(
      patternRest.slice(patternOpIdx + 1),
      requestRest.slice(requestOpIdx + 1),
    );
  }

  // Handle HTTP path patterns with * wildcards using Bun's Glob
  // * matches a single path segment (anything except /)
  const glob = new Bun.Glob(patternRest);
  return glob.match(requestRest);
}

export function findMatchingGrant(
  secretC: SecretConfig,
  requestKey: string,
): string | null {
  return (
    secretC.grants.find((pattern) => matchesPattern(pattern, requestKey)) ??
    null
  );
}

export function findMatchingRejection(
  secretC: SecretConfig,
  requestKey: string,
): string | null {
  return (
    secretC.rejections.find((pattern) => matchesPattern(pattern, requestKey)) ??
    null
  );
}

export async function addGrant(
  secretC: SecretConfig,
  requestKey: string,
): Promise<void> {
  if (secretC.grants.includes(requestKey)) {
    return;
  }
  secretC.grants.push(requestKey);
  await saveConfig();
}

export async function addRejection(
  secretC: SecretConfig,
  requestKey: string,
): Promise<void> {
  if (secretC.rejections.includes(requestKey)) {
    return;
  }
  secretC.rejections.push(requestKey);
  await saveConfig();
}

export function getRealSecret(secretC: SecretConfig): string | undefined {
  return process.env[secretC.secretEnvVarName];
}

export function findSecretConfigFromHeaders(req: {
  headers: Headers;
  url: URL;
}): SecretConfig | null {
  const hostConfig = config[req.url.host];
  if (!hostConfig) {
    return null;
  }

  for (const secretC of hostConfig.secrets) {
    for (const [, value] of req.headers) {
      if (value.includes(secretC.secret)) {
        return secretC;
      }
    }
  }
  return null;
}

export function substituteSecretInHeaders(
  headers: Headers,
  fakeSecret: string,
  realSecret: string,
): Headers {
  const newHeaders = new Headers();
  for (const [key, value] of headers) {
    newHeaders.set(key, value.replaceAll(fakeSecret, realSecret));
  }
  return newHeaders;
}
