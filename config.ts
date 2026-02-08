const CONFIG_FILE = "./proxy-config.json";

export interface HostConfig {
  secret: string;
  secretEnvVarName: string;
  grants: string[];
  rejections: string[];
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

export function hasGrant(host: string, requestKey: string): boolean {
  const hostConfig = config[host];
  if (!hostConfig) {
    return false;
  }
  return hostConfig.grants.includes(requestKey);
}

export function hasRejection(host: string, requestKey: string): boolean {
  const hostConfig = config[host];
  if (!hostConfig) {
    return false;
  }
  return hostConfig.rejections.includes(requestKey);
}

export async function addGrant(
  host: string,
  requestKey: string,
): Promise<void> {
  const hostConfig = config[host];
  if (!hostConfig) {
    return;
  }
  if (!hostConfig.grants.includes(requestKey)) {
    hostConfig.grants.push(requestKey);
    await saveConfig();
  }
}

export async function addRejection(
  host: string,
  requestKey: string,
): Promise<void> {
  const hostConfig = config[host];
  if (!hostConfig) {
    return;
  }
  if (!hostConfig.rejections.includes(requestKey)) {
    hostConfig.rejections.push(requestKey);
    await saveConfig();
  }
}

export function getRealSecret(host: string): string | undefined {
  const hostConfig = config[host];
  if (!hostConfig) {
    return undefined;
  }
  return process.env[hostConfig.secretEnvVarName];
}

export function findSecretInHeaders(req: { headers: Headers; url: URL }): {
  found: boolean;
  fakeSecret?: string;
} {
  const hostConfig = config[req.url.host];
  if (!hostConfig) {
    return { found: false };
  }

  const fakeSecret = hostConfig.secret;
  for (const [, value] of req.headers) {
    if (value.includes(fakeSecret)) {
      return { found: true, fakeSecret };
    }
  }
  return { found: false };
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
