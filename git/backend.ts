import { join } from "node:path";
import {
  getCanonicalGitPath,
  parseGitRequest,
  type ParsedGitRequest,
} from "../git-config";

export interface GitBackendRequest {
  method: string;
  url: URL;
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
  reposRoot: string;
  canonicalPath: string;
}

export function extractScriptName(canonicalPath: string): string {
  const scriptNameMatch = canonicalPath.match(/^(.+?\.git)(?:\/|$)/);
  return scriptNameMatch?.[1] ?? canonicalPath;
}

export function getRepoPathFromCanonicalPath(
  reposRoot: string,
  canonicalPath: string,
): string {
  const scriptName = extractScriptName(canonicalPath).replace(/^\//, "");
  return join(reposRoot, scriptName);
}

export function getServerPort(url: URL): string {
  if (url.port) {
    return url.port;
  }
  return url.protocol === "https:" ? "443" : "80";
}

export function buildCgiEnv(req: GitBackendRequest): Record<string, string> {
  const env: Record<string, string> = {
    REQUEST_METHOD: req.method,
    QUERY_STRING: req.url.search.slice(1),
    CONTENT_TYPE: req.headers.get("content-type") ?? "",
    CONTENT_LENGTH: req.headers.get("content-length") ?? "",
    PATH_INFO: req.canonicalPath,
    SCRIPT_NAME: extractScriptName(req.canonicalPath),
    SERVER_NAME: req.url.hostname,
    SERVER_PORT: getServerPort(req.url),
    SERVER_PROTOCOL: "HTTP/1.1",
    SERVER_SOFTWARE: "http-proxy/0.1",
    GATEWAY_INTERFACE: "CGI/1.1",

    // git-http-backend specific
    // Keep this at repos root because PATH_INFO includes /owner/repo.git/...
    GIT_PROJECT_ROOT: req.reposRoot,
    GIT_HTTP_EXPORT_ALL: "1",

    // Enable receive-pack (push)
    GIT_HTTP_RECEIVE_PACK: "true",
    // Enable upload-pack (fetch/clone)
    GIT_HTTP_UPLOAD_PACK: "true",
  };

  req.headers.forEach((value, key) => {
    env[`HTTP_${key.toUpperCase().replace(/-/g, "_")}`] = value;
  });

  return env;
}

interface CgiResponse {
  status: number;
  statusText: string;
  headers: Headers;
  body: Uint8Array;
}

function parseCgiResponse(output: Uint8Array): CgiResponse {
  // Find the header/body separator (double CRLF or double LF)
  let separatorIndex = -1;
  let separatorLength = 0;

  for (let i = 0; i < output.length - 1; i++) {
    // Check for \r\n\r\n
    if (
      output[i] === 0x0d &&
      output[i + 1] === 0x0a &&
      output[i + 2] === 0x0d &&
      output[i + 3] === 0x0a
    ) {
      separatorIndex = i;
      separatorLength = 4;
      break;
    }
    // Check for \n\n
    if (output[i] === 0x0a && output[i + 1] === 0x0a) {
      separatorIndex = i;
      separatorLength = 2;
      break;
    }
  }

  if (separatorIndex === -1) {
    // No body, all headers
    separatorIndex = output.length;
    separatorLength = 0;
  }

  const headerBytes = output.slice(0, separatorIndex);
  const bodyBytes = output.slice(separatorIndex + separatorLength);

  const headerText = new TextDecoder().decode(headerBytes);
  const headerLines = headerText.split(/\r?\n/);

  const headers = new Headers();
  let status = 200;
  let statusText = "OK";

  for (const line of headerLines) {
    if (line.length === 0) continue;

    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) continue;

    const name = line.slice(0, colonIndex).trim().toLowerCase();
    const value = line.slice(colonIndex + 1).trim();

    if (name === "status") {
      // CGI Status header: "Status: 404 Not Found"
      const [statusCode, ...rest] = value.split(" ");
      if (statusCode) {
        status = parseInt(statusCode, 10);
      }
      statusText = rest.join(" ") || "OK";
    } else {
      headers.set(name, value);
    }
  }

  return {
    status,
    statusText,
    headers,
    body: bodyBytes,
  };
}

export async function executeGitHttpBackend(
  req: GitBackendRequest,
): Promise<Response> {
  const env = buildCgiEnv(req);

  const gitHttpBackendPath = await findGitHttpBackend();
  const repoPath = getRepoPathFromCanonicalPath(req.reposRoot, req.canonicalPath);
  const proc = Bun.spawn([gitHttpBackendPath], {
    env: { ...process.env, ...env },
    cwd: repoPath,
    stdin: req.body ?? undefined,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).arrayBuffer().then((b) => new Uint8Array(b)),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (stderr) {
    console.log(`[git-backend] stderr: ${stderr}`);
  }

  if (exitCode !== 0) {
    console.error(
      `[git-backend] git-http-backend exited with code ${exitCode}`,
    );
  }

  const cgiResponse = parseCgiResponse(stdout);

  return new Response(cgiResponse.body, {
    status: cgiResponse.status,
    statusText: cgiResponse.statusText,
    headers: cgiResponse.headers,
  });
}

let cachedGitHttpBackendPath: string | undefined;

async function findGitHttpBackend(): Promise<string> {
  if (cachedGitHttpBackendPath) {
    return cachedGitHttpBackendPath;
  }

  // Common locations for git-http-backend
  const candidates = [
    "/usr/lib/git-core/git-http-backend",
    "/usr/libexec/git-core/git-http-backend",
    "/usr/local/libexec/git-core/git-http-backend",
    "/opt/homebrew/opt/git/libexec/git-core/git-http-backend",
  ];

  // Also try to find via git --exec-path
  const proc = Bun.spawn(["git", "--exec-path"], {
    stdout: "pipe",
    stderr: "ignore",
  });

  const execPath = (await new Response(proc.stdout).text()).trim();
  await proc.exited;

  if (execPath) {
    candidates.unshift(`${execPath}/git-http-backend`);
  }

  for (const candidate of candidates) {
    const file = Bun.file(candidate);
    if (await file.exists()) {
      cachedGitHttpBackendPath = candidate;
      console.log(`Found git-http-backend at: ${candidate}`);
      return candidate;
    }
  }

  throw new Error(
    "Could not find git-http-backend executable. Install git with CGI backend support. Searched:\n" +
      candidates.join("\n"),
  );
}

export interface CanonicalizedGitRequest {
  method: string;
  url: URL;
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
  parsed: ParsedGitRequest;
  canonicalPath: string;
}

export function canonicalizeIncomingRequest(
  request: Request,
): CanonicalizedGitRequest | null {
  const url = new URL(request.url);
  const host = request.headers.get("host") || url.host;
  url.host = host;

  const headers = new Headers(request.headers);
  headers.delete("host");

  const parsed = parseGitRequest(url);
  if (!parsed) {
    return null;
  }

  return {
    method: request.method,
    url,
    headers,
    body: request.body,
    parsed,
    canonicalPath: getCanonicalGitPath(parsed),
  };
}

export function createGitBackendRequest(
  request: CanonicalizedGitRequest,
  reposRoot: string,
): GitBackendRequest {
  return {
    method: request.method,
    url: request.url,
    headers: request.headers,
    body: request.body,
    reposRoot,
    canonicalPath: request.canonicalPath,
  };
}
