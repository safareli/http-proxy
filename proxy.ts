import {
  loadConfig,
  getConfig,
  getHostConfig,
  getRequestKey,
  findMatchingGrant,
  findMatchingRejection,
  addGrant,
  addRejection,
  addGitAllowedPushBranch,
  addGitRejectedPushBranch,
  getGitRepoConfig,
  getRealSecret,
  findSecretConfigFromHeaders,
  substituteSecretInHeaders,
  isGraphQLEndpoint,
  type SecretConfig,
} from "./config";
import { ensureAllDomainCerts } from "./certs";
import {
  parseGraphQLRequest,
  parseGraphQLFromSearchParams,
  getGraphQLRequestKeys,
  getGraphQLDescription,
  formatGraphQLField,
  generateGraphQLFieldPatternOptions,
  type ParsedGraphQLRequest,
  type GraphQLField,
} from "./graphql";
import {
  matchPathToTemplate,
  generatePatternOptions,
  type PatternOption,
} from "./openapi";
import { isGitRequest } from "./git-config";
import {
  handleGitRequest as handleGitProxyRequest,
  type GitReadApprovalFn,
  type GitReadApprovalResponse,
} from "./git/handler";
import {
  getHookSocketPath,
  startHookSocketServer,
  type HookApprovalRequest,
  type HookApprovalResponse,
  type HookSocketServer,
} from "./git/hook-socket";

export type ApprovalResponse =
  | { type: "allow-once" }
  | { type: "allow-forever"; pattern: string }
  | { type: "reject-once" }
  | { type: "reject-forever"; pattern: string };

export interface GitPushApprovalRequest {
  host: string;
  repo: string;
  type: HookApprovalRequest["type"];
  ref: string;
  baseBranch?: string;
}

export type GitPushApprovalResponse =
  | { type: "allow-once" }
  | { type: "allow-pattern"; pattern: string; rejectBaseBranch?: string }
  | { type: "reject-once" }
  | { type: "reject-pattern"; pattern: string };

export type { PatternOption, GitReadApprovalResponse };

export type RequestApprovalFn = (
  host: string,
  method: string,
  path: string,
  patternOptions: PatternOption[],
  signal: AbortSignal,
) => Promise<ApprovalResponse>;

export type GitPushApprovalFn = (
  request: GitPushApprovalRequest,
  signal: AbortSignal,
) => Promise<GitPushApprovalResponse>;

let requestApprovalFn: RequestApprovalFn | null = null;
let requestGitReadApprovalFn: GitReadApprovalFn | null = null;
let requestGitPushApprovalFn: GitPushApprovalFn | null = null;

const gitHookSocketServers = new Map<string, HookSocketServer>();

export function setRequestApprovalHandler(fn: RequestApprovalFn): void {
  requestApprovalFn = fn;
}

export function setGitReadApprovalHandler(fn: GitReadApprovalFn): void {
  requestGitReadApprovalFn = fn;
}

export function setGitPushApprovalHandler(fn: GitPushApprovalFn): void {
  requestGitPushApprovalFn = fn;
}

type RequestLoaded = {
  url: URL;
  method: string;
  headers: Headers;
  body: ArrayBuffer | null;
  signal: AbortSignal;
};

function getCanonicalUrl(req: Request): URL {
  const url = new URL(req.url);
  const host = req.headers.get("host") || url.host;
  url.host = host;
  return url;
}

const loadRequest = async (req: Request): Promise<RequestLoaded> => {
  const url = getCanonicalUrl(req);

  const headers = new Headers(req.headers);
  headers.delete("host");

  const body =
    req.method !== "GET" && req.method !== "HEAD"
      ? await req.arrayBuffer()
      : null;
  return { url, method: req.method, headers, body, signal: req.signal };
};

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

async function handleGitHookSocketApproval(
  request: HookApprovalRequest,
  signal: AbortSignal,
): Promise<HookApprovalResponse> {
  const repoConfig = getGitRepoConfig(request.host, request.repo);
  if (!repoConfig) {
    return {
      allowed: false,
      error: `Unknown git repo ${request.repo} for host ${request.host}`,
    };
  }

  if (!requestGitPushApprovalFn) {
    return {
      allowed: false,
      error: "No git push approval handler configured",
    };
  }

  let decision: GitPushApprovalResponse;
  try {
    decision = await requestGitPushApprovalFn(
      {
        host: request.host,
        repo: request.repo,
        type: request.type,
        ref: request.ref,
        baseBranch: request.baseBranch,
      },
      signal,
    );
  } catch (error) {
    return {
      allowed: false,
      error: `Push approval failed: ${toErrorMessage(error)}`,
    };
  }

  switch (decision.type) {
    case "allow-once":
      return { allowed: true };

    case "reject-once":
      return { allowed: false };

    case "allow-pattern": {
      const addAllowedPatterns = [decision.pattern];
      const addRejectedPatterns: string[] = [];

      try {
        await addGitAllowedPushBranch(request.host, request.repo, decision.pattern);

        if (decision.rejectBaseBranch) {
          await addGitRejectedPushBranch(
            request.host,
            request.repo,
            decision.rejectBaseBranch,
          );
          addRejectedPatterns.push(decision.rejectBaseBranch);
        }
      } catch (error) {
        return {
          allowed: false,
          error: `Failed to persist branch approval: ${toErrorMessage(error)}`,
        };
      }

      return {
        allowed: true,
        addAllowedPatterns,
        ...(addRejectedPatterns.length > 0 ? { addRejectedPatterns } : {}),
      };
    }

    case "reject-pattern": {
      try {
        await addGitRejectedPushBranch(request.host, request.repo, decision.pattern);
      } catch (error) {
        return {
          allowed: false,
          error: `Failed to persist branch rejection: ${toErrorMessage(error)}`,
        };
      }

      return {
        allowed: false,
        addRejectedPatterns: [decision.pattern],
      };
    }
  }
}

async function stopGitHookSocketServers(): Promise<void> {
  const closeTasks = [...gitHookSocketServers.entries()].map(
    async ([socketPath, server]) => {
      try {
        await server.close();
      } catch (error) {
        console.error(
          `Failed to close git hook socket ${socketPath}: ${toErrorMessage(error)}`,
        );
      }
    },
  );

  await Promise.all(closeTasks);
  gitHookSocketServers.clear();
}

async function startGitHookSocketServers(): Promise<void> {
  await stopGitHookSocketServers();

  const config = getConfig();

  for (const [host, hostConfig] of Object.entries(config)) {
    if (!hostConfig.git) {
      continue;
    }

    const socketPath = getHookSocketPath(hostConfig.git);
    if (gitHookSocketServers.has(socketPath)) {
      continue;
    }

    const socketServer = await startHookSocketServer(
      socketPath,
      handleGitHookSocketApproval,
    );

    gitHookSocketServers.set(socketPath, socketServer);
    console.log(
      `Git hook approval socket listening for ${host} at ${socketServer.socketPath}`,
    );
  }
}

async function handleRequest(reqOriginal: Request): Promise<Response> {
  const requestUrl = getCanonicalUrl(reqOriginal);

  console.log(
    `\n[${new Date().toISOString()}] ${reqOriginal.method} ${requestUrl.host}${requestUrl.pathname}`,
  );

  for (const [key, value] of requestUrl.searchParams) {
    console.log(`  ? ${key}=${value}`);
  }

  // console.log(" HEADERS");
  // for (const [key, value] of req.headers) {
  //   console.log(`    ${key}=${value}`);
  // }

  const hostConfig = getHostConfig(requestUrl.host);
  if (hostConfig?.git && isGitRequest(requestUrl)) {
    console.log("  → Git request detected, routing to git handler");
    try {
      return await handleGitProxyRequest(reqOriginal, {
        requestReadApproval: requestGitReadApprovalFn,
      });
    } catch (error) {
      console.error(`  → Git handler error: ${error}`);
      return new Response("Internal Server Error - Git request failed", {
        status: 500,
      });
    }
  }

  const req = await loadRequest(reqOriginal);

  const secretConfig = findSecretConfigFromHeaders(req);

  if (!secretConfig) {
    console.log(`  → Request without secrets forwarding`);
    return forwardRequest(req);
  }

  if (req.body != null && req.body.byteLength > 0) {
    console.log(`  body: ${new TextDecoder().decode(req.body)}`);
  }

  const path = req.url.pathname + req.url.search;

  // Check if this is a GraphQL endpoint
  if (isGraphQLEndpoint(req.url.host, req.url.pathname)) {
    return handleGraphQLRequest(req, secretConfig);
  }

  return handleHttpRequest(req, secretConfig, path);
}

async function handleHttpRequest(
  req: RequestLoaded,
  secretConfig: SecretConfig,
  path: string,
): Promise<Response> {
  const requestKey = getRequestKey(req.method, path);

  const matchingRejection = findMatchingRejection(secretConfig, requestKey);
  if (matchingRejection) {
    console.log(
      `  → Permanent rejection exists for pattern: ${matchingRejection}`,
    );
    return new Response("Forbidden - Request permanently rejected", {
      status: 403,
    });
  }

  const matchingGrant = findMatchingGrant(secretConfig, requestKey);
  if (matchingGrant) {
    console.log(`  → Permanent grant exists for pattern: ${matchingGrant}`);
    return forwardRequestWithSecretSubstitution(req, secretConfig);
  }

  if (!requestApprovalFn) {
    console.log(`  → No approval handler configured, rejecting`);
    return new Response("Forbidden - No approval handler", { status: 403 });
  }

  console.log(`  → Requesting approval via Telegram...`);

  // Generate pattern options for smart approval
  const template = matchPathToTemplate(req.url.host, req.method, path);
  const patternOptions = generatePatternOptions(req.method, path, template);

  try {
    const approval = await requestApprovalFn(
      req.url.host,
      req.method,
      path,
      patternOptions,
      req.signal,
    );

    switch (approval.type) {
      case "allow-once":
        console.log(`  → Approved once`);
        return forwardRequestWithSecretSubstitution(req, secretConfig);

      case "allow-forever":
        console.log(`  → Approved forever with pattern: ${approval.pattern}`);
        await addGrant(secretConfig, approval.pattern);
        return forwardRequestWithSecretSubstitution(req, secretConfig);

      case "reject-once":
        console.log(`  → Rejected once`);
        return new Response("Forbidden - Request rejected", { status: 403 });

      case "reject-forever":
        console.log(`  → Rejected forever with pattern: ${approval.pattern}`);
        await addRejection(secretConfig, approval.pattern);
        return new Response("Forbidden - Request permanently rejected", {
          status: 403,
        });
    }
  } catch (error) {
    console.log(`  → Approval timeout or error: ${error}`);
    return new Response("Forbidden - Approval timeout", { status: 403 });
  }
}

async function handleGraphQLRequest(
  req: RequestLoaded,
  secretConfig: SecretConfig,
): Promise<Response> {
  // Parse GraphQL request
  let parsed: ParsedGraphQLRequest | null = null;

  if (req.method === "GET") {
    parsed = parseGraphQLFromSearchParams(req.url.searchParams);
  } else if (req.body) {
    const bodyStr = new TextDecoder().decode(req.body);
    parsed = parseGraphQLRequest(bodyStr);
  }

  // If we can't parse GraphQL, reject the request
  if (!parsed) {
    console.log(`  → Could not parse GraphQL request body`);
    return new Response("Bad Request - Invalid GraphQL request", {
      status: 400,
    });
  }

  const keys = getGraphQLRequestKeys(parsed);

  console.log(`  → GraphQL: ${getGraphQLDescription(parsed)}`);

  // Check for rejections first
  for (const key of keys) {
    const matchingRejection = findMatchingRejection(secretConfig, key);
    if (matchingRejection) {
      console.log(
        `  → Permanent rejection exists for pattern: ${matchingRejection}`,
      );
      return new Response("Forbidden - Request permanently rejected", {
        status: 403,
      });
    }
  }

  // Check which fields are already granted vs need approval
  const grantedPatterns: string[] = [];
  const needsApproval: { key: string; opType: string; field: GraphQLField }[] =
    [];

  for (const field of parsed.queries) {
    const key = `GRAPHQL query ${formatGraphQLField(field)}`;
    const matchingGrant = findMatchingGrant(secretConfig, key);
    if (matchingGrant) {
      grantedPatterns.push(matchingGrant);
    } else {
      needsApproval.push({ key, opType: "query", field });
    }
  }

  for (const field of parsed.mutations) {
    const key = `GRAPHQL mutation ${formatGraphQLField(field)}`;
    const matchingGrant = findMatchingGrant(secretConfig, key);
    if (matchingGrant) {
      grantedPatterns.push(matchingGrant);
    } else {
      needsApproval.push({ key, opType: "mutation", field });
    }
  }

  // If all operations are granted, forward the request
  if (needsApproval.length === 0) {
    console.log(`  → All GraphQL operations are granted`);
    return forwardRequestWithSecretSubstitution(req, secretConfig);
  }

  // Log which operations are already granted
  for (const pattern of grantedPatterns) {
    console.log(`  → Permanent grant exists for pattern: ${pattern}`);
  }

  if (!requestApprovalFn) {
    console.log(`  → No approval handler configured, rejecting`);
    return new Response("Forbidden - No approval handler", { status: 403 });
  }

  // Abort all pending approvals on client disconnect OR any rejection
  const abort = new AbortController();
  req.signal.addEventListener("abort", () => abort.abort(), { once: true });

  // Request approval for each field in parallel
  try {
    const approvalResults = await Promise.all(
      needsApproval.map(async ({ key, opType, field }) => {
        const description = key.replace("GRAPHQL ", "");
        console.log(`  → Requesting approval for: ${description}`);
        const patternOptions = generateGraphQLFieldPatternOptions(
          opType,
          field,
        );
        const approval = await requestApprovalFn!(
          req.url.host,
          "GRAPHQL",
          description,
          patternOptions,
          abort.signal,
        );
        if (
          approval.type === "reject-once" ||
          approval.type === "reject-forever"
        ) {
          abort.abort();
        }
        return { key, approval };
      }),
    );

    // Save forever patterns (grants and rejections)
    for (const { key, approval } of approvalResults) {
      if (approval.type === "allow-forever") {
        console.log(`  → Approved forever with pattern: ${approval.pattern}`);
        await addGrant(secretConfig, approval.pattern);
      } else if (approval.type === "reject-forever") {
        console.log(`  → Rejected forever with pattern: ${approval.pattern}`);
        await addRejection(secretConfig, approval.pattern);
      } else if (approval.type === "allow-once") {
        console.log(`  → Approved once: ${key}`);
      } else {
        console.log(`  → Rejected once: ${key}`);
      }
    }

    // Forward only if ALL are approved
    const allApproved = approvalResults.every(
      ({ approval }) =>
        approval.type === "allow-once" || approval.type === "allow-forever",
    );

    if (!allApproved) {
      return new Response("Forbidden - Request rejected", { status: 403 });
    }

    return forwardRequestWithSecretSubstitution(req, secretConfig);
  } catch (error) {
    console.log(`  → Approval timeout or error: ${error}`);
    return new Response("Forbidden - Approval timeout", { status: 403 });
  }
}

async function forwardRequest(req: RequestLoaded): Promise<Response> {
  try {
    const response = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      decompress: false,
    });
    return response;
  } catch (error) {
    console.error(`  → Error forwarding request: ${error}`);
    return new Response(`Bad Gateway: ${error}`, { status: 502 });
  }
}

async function forwardRequestWithSecretSubstitution(
  req: RequestLoaded,
  secretConfig: SecretConfig,
): Promise<Response> {
  const realSecret = getRealSecret(secretConfig);
  if (!realSecret) {
    console.error(
      `  → No real secret configured for ${req.url.host}: ${secretConfig.secretEnvVarName}`,
    );
    return new Response("Internal Server Error - No real secret configured", {
      status: 500,
    });
  }

  try {
    const response = await fetch(req.url, {
      method: req.method,
      headers: substituteSecretInHeaders(
        req.headers,
        secretConfig.secret,
        realSecret,
      ),
      body: req.body,
      decompress: false,
    });
    return response;
  } catch (error) {
    console.error(`  → Error forwarding request: ${error}`);
    return new Response(`Bad Gateway: ${error}`, { status: 502 });
  }
}

export async function startProxy(): Promise<void> {
  await loadConfig();
  await startGitHookSocketServers();

  const config = getConfig();
  const domains = Object.keys(config);

  if (domains.length === 0) {
    console.error("No domains configured in proxy-config.json");
    process.exit(1);
  }

  console.log(`Ensuring certificates for domains: ${domains.join(", ")}`);
  const domainCerts = await ensureAllDomainCerts(domains);

  // Build TLS array with serverName for each domain (SNI)
  const tlsConfigs = Object.entries(domainCerts).map(([domain, cert]) => ({
    serverName: domain,
    cert: cert.cert,
    key: cert.key,
  }));

  const httpServer = Bun.serve({
    port: 80,
    idleTimeout: 255,
    fetch: handleRequest,
  });

  const httpsServer = Bun.serve({
    port: 443,
    idleTimeout: 255,
    tls: tlsConfigs,
    fetch: handleRequest,
  });

  console.log(`HTTP proxy listening on port ${httpServer.port}`);
  console.log(`HTTPS proxy listening on port ${httpsServer.port}`);
  console.log(`Serving TLS for: ${domains.join(", ")}`);
}
