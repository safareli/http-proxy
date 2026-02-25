import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  getHookSocketPath,
  requestHookApproval,
  startHookSocketServer,
  type HookApprovalRequest,
  type HookSocketServer,
} from "./hook-socket";

describe("git/hook-socket.ts", () => {
  let tmpDir = "";
  let server: HookSocketServer | null = null;

  afterEach(async () => {
    if (server) {
      await server.close();
      server = null;
    }
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = "";
    }
  });

  test("getHookSocketPath resolves to <repos_dir>/.hook.sock", () => {
    const socketPath = getHookSocketPath({
      repos_dir: "./tmp/repos",
      repos: {},
    });

    expect(socketPath).toContain("tmp/repos/.hook.sock");
  });

  test("socket request/response roundtrip works", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "http-proxy-hook-socket-test-"));
    const socketPath = join(tmpDir, ".hook.sock");

    const req: HookApprovalRequest = {
      host: "github.com",
      repo: "owner/repo",
      type: "branch",
      ref: "agent/feature",
      baseBranch: "main",
    };
    const res = {
      allowed: true,
      addAllowedPatterns: ["agent/*"],
    };
    server = await startHookSocketServer(socketPath, async (reqActual) => {
      expect(reqActual).toEqual(req);

      return res;
    });

    const responseActual = await requestHookApproval(socketPath, {
      host: "github.com",
      repo: "owner/repo",
      type: "branch",
      ref: "agent/feature",
      baseBranch: "main",
    });

    expect(responseActual).toEqual(res);
  });

  test("requestHookApproval rejects on timeout", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "http-proxy-hook-socket-timeout-"));
    const socketPath = join(tmpDir, ".hook.sock");

    server = await startHookSocketServer(socketPath, async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return { allowed: true };
    });

    await expect(
      requestHookApproval(
        socketPath,
        {
          host: "github.com",
          repo: "owner/repo",
          type: "tag",
          ref: "v1.0.0",
        },
        { timeoutMs: 10 },
      ),
    ).rejects.toThrow("timed out");
  });

  test("requestHookApproval rejects when socket is missing", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "http-proxy-hook-socket-missing-"));
    const socketPath = join(tmpDir, "missing.sock");

    await expect(
      requestHookApproval(socketPath, {
        host: "github.com",
        repo: "owner/repo",
        type: "tag",
        ref: "v1.0.0",
      }),
    ).rejects.toThrow();
  });
});
