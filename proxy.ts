import {
  loadConfig,
  getConfig,
  getRequestKey,
  findMatchingGrant,
  findMatchingRejection,
  addGrant,
  addRejection,
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

export type ApprovalResponse =
  | { type: "allow-once" }
  | { type: "allow-forever"; pattern: string }
  | { type: "reject-once" }
  | { type: "reject-forever"; pattern: string };

export type { PatternOption };

export type RequestApprovalFn = (
  host: string,
  method: string,
  path: string,
  patternOptions: PatternOption[],
) => Promise<ApprovalResponse>;

let requestApprovalFn: RequestApprovalFn | null = null;

export function setRequestApprovalHandler(fn: RequestApprovalFn): void {
  requestApprovalFn = fn;
}

type RequestLoaded = {
  url: URL;
  method: string;
  headers: Headers;
  body: ArrayBuffer | null;
};

const loadRequest = async (req: Request): Promise<RequestLoaded> => {
  const url = new URL(req.url);
  const host = req.headers.get("host") || url.host;
  url.host = host;

  const headers = new Headers(req.headers);
  headers.delete("host");

  const body =
    req.method !== "GET" && req.method !== "HEAD"
      ? await req.arrayBuffer()
      : null;
  return { url, method: req.method, headers, body };
};

async function handleRequest(reqOriginal: Request): Promise<Response> {
  const req = await loadRequest(reqOriginal);

  console.log(
    `\n[${new Date().toISOString()}] ${req.method} ${req.url.host}${req.url.pathname}`,
  );

  for (const [key, value] of req.url.searchParams) {
    console.log(`  ? ${key}=${value}`);
  }

  // console.log(" HEADERS");
  // for (const [key, value] of req.headers) {
  //   console.log(`    ${key}=${value}`);
  // }

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
    return handleGraphQLRequest(req, secretConfig, path);
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
  path: string,
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

  // Build description for approval request
  const approvalDescription = needsApproval
    .map(({ key }) => key.replace("GRAPHQL ", ""))
    .join("; ");
  console.log(`  → Requesting approval for: ${approvalDescription}`);

  // Generate pattern options: smart patterns for single field, exact-only for multiple
  const patternOptions: PatternOption[] =
    needsApproval.length === 1
      ? generateGraphQLFieldPatternOptions(
          needsApproval[0]!.opType,
          needsApproval[0]!.field,
        )
      : [
          {
            pattern: "all",
            description: `Exact: ${approvalDescription}`,
          },
        ];

  try {
    const approval = await requestApprovalFn(
      req.url.host,
      "GRAPHQL",
      approvalDescription,
      patternOptions,
    );

    switch (approval.type) {
      case "allow-once":
        console.log(`  → Approved once`);
        return forwardRequestWithSecretSubstitution(req, secretConfig);

      case "allow-forever":
        if (needsApproval.length === 1) {
          console.log(
            `  → Approved forever with pattern: ${approval.pattern}`,
          );
          await addGrant(secretConfig, approval.pattern);
        } else {
          console.log(`  → Approved forever`);
          for (const { key } of needsApproval) {
            await addGrant(secretConfig, key);
          }
        }
        return forwardRequestWithSecretSubstitution(req, secretConfig);

      case "reject-once":
        console.log(`  → Rejected once`);
        return new Response("Forbidden - Request rejected", { status: 403 });

      case "reject-forever":
        if (needsApproval.length === 1) {
          console.log(
            `  → Rejected forever with pattern: ${approval.pattern}`,
          );
          await addRejection(secretConfig, approval.pattern);
        } else {
          console.log(`  → Rejected forever`);
          for (const { key } of needsApproval) {
            await addRejection(secretConfig, key);
          }
        }
        return new Response("Forbidden - Request permanently rejected", {
          status: 403,
        });
    }
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
