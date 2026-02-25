import { createConnection, createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { z } from "zod";
import type { GitHostConfig } from "../git-config";

const DEFAULT_SOCKET_TIMEOUT_MS = 255 * 1000;

export const HookApprovalTypeSchema = z.enum([
  "branch",
  "tag",
  "branch-deletion",
  "force-push",
]);

export type HookApprovalType = z.infer<typeof HookApprovalTypeSchema>;

export const HookApprovalRequestSchema = z.object({
  host: z.string().min(1),
  repo: z.string().min(1),
  type: HookApprovalTypeSchema,
  ref: z.string().min(1),
  baseBranch: z.string().min(1).optional(),
});

export type HookApprovalRequest = z.infer<typeof HookApprovalRequestSchema>;

export const HookApprovalResponseSchema = z.object({
  allowed: z.boolean(),
  addAllowedPatterns: z.array(z.string()).optional(),
  addRejectedPatterns: z.array(z.string()).optional(),
  error: z.string().optional(),
});

export type HookApprovalResponse = z.infer<typeof HookApprovalResponseSchema>;

export interface HookSocketServer {
  socketPath: string;
  close: () => Promise<void>;
}

export function getHookSocketPath(gitConfig: GitHostConfig): string {
  return join(resolve(gitConfig.repos_dir), ".hook.sock");
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.join(".") || "root";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

export async function startHookSocketServer(
  socketPath: string,
  onRequest: (
    request: HookApprovalRequest,
    signal: AbortSignal,
  ) => Promise<HookApprovalResponse>,
): Promise<HookSocketServer> {
  const resolvedSocketPath = resolve(socketPath);

  mkdirSync(dirname(resolvedSocketPath), { recursive: true });

  if (existsSync(resolvedSocketPath)) {
    rmSync(resolvedSocketPath, { force: true });
  }

  const server = createServer((socket) => {
    let buffer = "";
    let handled = false;
    const abortController = new AbortController();

    const respond = (response: HookApprovalResponse): void => {
      const payload = `${JSON.stringify(response)}\n`;
      socket.write(payload, () => {
        socket.end();
      });
    };

    socket.on("close", () => {
      abortController.abort();
    });

    socket.on("error", (error) => {
      if (!handled) {
        console.error(`[git-hook-socket] Socket error: ${toErrorMessage(error)}`);
      }
      abortController.abort();
    });

    socket.on("data", async (chunk) => {
      if (handled) {
        return;
      }

      buffer += chunk.toString("utf8");
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) {
        return;
      }

      handled = true;
      const line = buffer.slice(0, newlineIndex).trim();

      let request: HookApprovalRequest;
      try {
        request = HookApprovalRequestSchema.parse(JSON.parse(line));
      } catch (error) {
        const message =
          error instanceof z.ZodError
            ? formatZodError(error)
            : toErrorMessage(error);
        respond({
          allowed: false,
          error: `Invalid hook approval request: ${message}`,
        });
        return;
      }

      try {
        const rawResponse = await onRequest(request, abortController.signal);
        const response = HookApprovalResponseSchema.parse(rawResponse);
        respond(response);
      } catch (error) {
        respond({
          allowed: false,
          error: `Hook approval handler error: ${toErrorMessage(error)}`,
        });
      }
    });
  });

  await new Promise<void>((resolveServer, rejectServer) => {
    server.once("error", rejectServer);
    server.listen(resolvedSocketPath, () => {
      server.off("error", rejectServer);
      resolveServer();
    });
  });

  return {
    socketPath: resolvedSocketPath,
    close: async () => {
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => {
          if (error) {
            rejectClose(error);
            return;
          }
          resolveClose();
        });
      });

      if (existsSync(resolvedSocketPath)) {
        rmSync(resolvedSocketPath, { force: true });
      }
    },
  };
}

export function requestHookApproval(
  socketPath: string,
  request: HookApprovalRequest,
  options: {
    signal?: AbortSignal;
    timeoutMs?: number;
  } = {},
): Promise<HookApprovalResponse> {
  const resolvedSocketPath = resolve(socketPath);
  const validatedRequest = HookApprovalRequestSchema.parse(request);
  const timeoutMs = options.timeoutMs ?? DEFAULT_SOCKET_TIMEOUT_MS;

  return new Promise<HookApprovalResponse>((resolveResult, rejectResult) => {
    const socket = createConnection(resolvedSocketPath);
    let buffer = "";
    let settled = false;

    const settle = (fn: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (options.signal) {
        options.signal.removeEventListener("abort", onAbort);
      }
      fn();
    };

    const onAbort = () => {
      settle(() => {
        socket.destroy();
        rejectResult(new Error("Hook approval request aborted"));
      });
    };

    const timeout = setTimeout(() => {
      settle(() => {
        socket.destroy();
        rejectResult(new Error("Hook approval request timed out"));
      });
    }, timeoutMs);

    if (options.signal) {
      if (options.signal.aborted) {
        onAbort();
        return;
      }
      options.signal.addEventListener("abort", onAbort, { once: true });
    }

    socket.once("connect", () => {
      socket.write(`${JSON.stringify(validatedRequest)}\n`);
    });

    socket.on("data", (chunk) => {
      if (settled) {
        return;
      }

      buffer += chunk.toString("utf8");
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) {
        return;
      }

      const line = buffer.slice(0, newlineIndex).trim();

      try {
        const response = HookApprovalResponseSchema.parse(JSON.parse(line));
        settle(() => {
          socket.end();
          resolveResult(response);
        });
      } catch (error) {
        settle(() => {
          socket.destroy();
          rejectResult(
            new Error(`Invalid hook approval response: ${toErrorMessage(error)}`),
          );
        });
      }
    });

    socket.once("error", (error) => {
      settle(() => {
        rejectResult(error);
      });
    });

    socket.once("close", () => {
      if (!settled) {
        settle(() => {
          rejectResult(new Error("Hook approval socket closed before response"));
        });
      }
    });
  });
}
