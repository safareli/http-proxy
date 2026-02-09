const CONFIG_FILE = "./proxy-config.json";

export interface SecretConfig {
  secret: string;
  secretEnvVarName: string;
  grants: string[];
  rejections: string[];
}

export interface HostConfig {
  secrets: SecretConfig[];
  graphqlEndpoints?: string[];
}

export interface ProxyConfig {
  [host: string]: HostConfig;
}

let config: ProxyConfig = {};

export async function loadConfig(): Promise<void> {
  const file = Bun.file(CONFIG_FILE);
  if (await file.exists()) {
    config = await file.json();
  } else {
    config = {};
  }
}

export async function saveConfig(): Promise<void> {
  await Bun.write(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n");
}

export function getConfig(): ProxyConfig {
  return config;
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
    // Exact match only for other GraphQL patterns
    return patternRest === requestRest;
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
