import {
  loadConfig,
  getRequestKey,
  hasGrant,
  hasRejection,
  addGrant,
  addRejection,
  getRealSecret,
  findSecretConfigFromHeaders,
  substituteSecretInHeaders,
  isGraphQLEndpoint,
  type SecretConfig,
} from "./config";
import {
  parseGraphQLRequest,
  parseGraphQLFromSearchParams,
  getGraphQLRequestKey,
  type GraphQLOperation,
} from "./graphql";

export type ApprovalResponse =
  | "allow-once"
  | "allow-forever"
  | "reject-once"
  | "reject-forever";

export type RequestApprovalFn = (
  host: string,
  method: string,
  path: string,
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
    `[${new Date().toISOString()}] ${req.method} ${req.url.host}${req.url.pathname}`,
  );

  for (const [key, value] of req.url.searchParams) {
    console.log(`  ? ${key}=${value}`);
  }

  if (req.body != null && req.body.byteLength > 0) {
    console.log(`  body: ${new TextDecoder().decode(req.body)}`);
  }

  const secretConfig = findSecretConfigFromHeaders(req);

  if (!secretConfig) {
    return forwardRequest(req);
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

  if (hasGrant(secretConfig, requestKey)) {
    console.log(`  → Permanent grant exists for ${requestKey}`);
    return forwardRequestWithSecretSubstitution(req, secretConfig);
  }

  if (hasRejection(secretConfig, requestKey)) {
    console.log(`  → Permanent rejection exists for ${requestKey}`);
    return new Response("Forbidden - Request permanently rejected", {
      status: 403,
    });
  }

  if (!requestApprovalFn) {
    console.log(`  → No approval handler configured, rejecting`);
    return new Response("Forbidden - No approval handler", { status: 403 });
  }

  console.log(`  → Requesting approval via Telegram...`);

  try {
    const approval = await requestApprovalFn(req.url.host, req.method, path);

    switch (approval) {
      case "allow-once":
        console.log(`  → Approved once`);
        return forwardRequestWithSecretSubstitution(req, secretConfig);

      case "allow-forever":
        console.log(`  → Approved forever`);
        await addGrant(secretConfig, requestKey);
        return forwardRequestWithSecretSubstitution(req, secretConfig);

      case "reject-once":
        console.log(`  → Rejected once`);
        return new Response("Forbidden - Request rejected", { status: 403 });

      case "reject-forever":
        console.log(`  → Rejected forever`);
        await addRejection(secretConfig, requestKey);
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
  // Parse GraphQL operations
  let operations: GraphQLOperation[] | null = null;

  if (req.method === "GET") {
    operations = parseGraphQLFromSearchParams(req.url.searchParams);
  } else if (req.body) {
    const bodyStr = new TextDecoder().decode(req.body);
    operations = parseGraphQLRequest(bodyStr);
  }

  // If we can't parse GraphQL, reject the request
  if (!operations || operations.length === 0) {
    console.log(`  → Could not parse GraphQL request body`);
    return new Response("Bad Request - Invalid GraphQL request", {
      status: 400,
    });
  }

  // Generate request keys for each operation
  const operationKeys = operations.map((op) => ({
    operation: op,
    key: getGraphQLRequestKey(op),
  }));

  console.log(
    `  → GraphQL operations: ${operationKeys.map((ok) => ok.key).join(", ")}`,
  );

  // Check for rejections first - if any operation is rejected, reject the whole request
  for (const { key } of operationKeys) {
    if (hasRejection(secretConfig, key)) {
      console.log(`  → Permanent rejection exists for ${key}`);
      return new Response("Forbidden - Request permanently rejected", {
        status: 403,
      });
    }
  }

  // Find operations that need approval (not already granted)
  const needsApproval = operationKeys.filter(
    ({ key }) => !hasGrant(secretConfig, key),
  );

  // If all operations are granted, forward the request
  if (needsApproval.length === 0) {
    console.log(`  → All GraphQL operations are granted`);
    return forwardRequestWithSecretSubstitution(req, secretConfig);
  }

  // Log which operations are already granted
  const alreadyGranted = operationKeys.filter(({ key }) =>
    hasGrant(secretConfig, key),
  );
  for (const { key } of alreadyGranted) {
    console.log(`  → Permanent grant exists for ${key}`);
  }

  if (!requestApprovalFn) {
    console.log(`  → No approval handler configured, rejecting`);
    return new Response("Forbidden - No approval handler", { status: 403 });
  }

  // Request approval for operations that need it
  const keysNeedingApproval = needsApproval.map(({ key }) => key).join(", ");
  console.log(`  → Requesting approval for: ${keysNeedingApproval}`);

  try {
    const approval = await requestApprovalFn(
      req.url.host,
      "GRAPHQL",
      keysNeedingApproval,
    );

    switch (approval) {
      case "allow-once":
        console.log(`  → Approved once`);
        return forwardRequestWithSecretSubstitution(req, secretConfig);

      case "allow-forever":
        console.log(`  → Approved forever`);
        // Add grant for each operation that needed approval
        for (const { key } of needsApproval) {
          await addGrant(secretConfig, key);
        }
        return forwardRequestWithSecretSubstitution(req, secretConfig);

      case "reject-once":
        console.log(`  → Rejected once`);
        return new Response("Forbidden - Request rejected", { status: 403 });

      case "reject-forever":
        console.log(`  → Rejected forever`);
        // Add rejection for each operation that needed approval
        for (const { key } of needsApproval) {
          await addRejection(secretConfig, key);
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
    return await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
    });
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
    return await fetch(req.url, {
      method: req.method,
      headers: substituteSecretInHeaders(
        req.headers,
        secretConfig.secret,
        realSecret,
      ),
      body: req.body,
    });
  } catch (error) {
    console.error(`  → Error forwarding request: ${error}`);
    return new Response(`Bad Gateway: ${error}`, { status: 502 });
  }
}

export async function startProxy(): Promise<void> {
  await loadConfig();

  const certFile = Bun.file("./certs/server.crt");
  const keyFile = Bun.file("./certs/server.key");

  if (!(await certFile.exists()) || !(await keyFile.exists())) {
    console.error("Certificates not found. Run: bun run generate-certs.ts");
    process.exit(1);
  }

  const httpServer = Bun.serve({
    port: 80,
    idleTimeout: 255,
    fetch: handleRequest,
  });

  const httpsServer = Bun.serve({
    port: 443,
    idleTimeout: 255,
    tls: {
      cert: certFile,
      key: keyFile,
    },
    fetch: handleRequest,
  });

  console.log(`HTTP proxy listening on port ${httpServer.port}`);
  console.log(`HTTPS proxy listening on port ${httpsServer.port}`);
}
