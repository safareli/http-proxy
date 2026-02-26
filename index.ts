import { Bot, InlineKeyboard } from "grammy";
import {
  startProxy,
  setRequestApprovalHandler,
  setGitReadApprovalHandler,
  setGitPushApprovalHandler,
  type ApprovalResponse,
  type GitReadApprovalResponse,
  type GitPushApprovalRequest,
  type GitPushApprovalResponse,
  type PatternOption,
} from "./proxy";

const token = process.env.TELEGRAM_API_TOKEN;
if (!token) {
  throw new Error("TELEGRAM_API_TOKEN is not set");
}

const ownerId = process.env.TELEGRAM_OWNER_ID;
if (!ownerId) {
  throw new Error("TELEGRAM_OWNER_ID is not set");
}

const APPROVAL_TIMEOUT_MS = 255 * 1000; // ~4 minutes (Bun max idleTimeout)

interface PendingRequest<TResponse extends { type: string }> {
  resolve: (response: TResponse) => void;
  timeout: Timer;
  callbackKeys: string[];
  rejectOnce: Extract<TResponse, { type: "reject-once" }>;
  messageId?: number;
  abortedByClient?: boolean;
}

type AnyPendingRequest =
  | PendingRequest<ApprovalResponse>
  | PendingRequest<GitReadApprovalResponse>
  | PendingRequest<GitPushApprovalResponse>;

const pendingRequests = new Map<string, AnyPendingRequest>();
let requestIdCounter = 0;

function code(text: string): string {
  return `<code>${text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</code>`;
}

const bot = new Bot(token);

const callbackHandlers = new Map<string, (ctx: any) => Promise<void>>();

function registerCallback(
  key: string,
  handler: (ctx: any) => Promise<void>,
): string {
  callbackHandlers.set(key, handler);
  return key;
}

bot.use((ctx, next) => {
  if (ctx.from?.id !== Number(ownerId)) {
    console.log(`Ignoring message from non-owner: ${ctx.from?.id}`);
    return;
  }
  return next();
});

bot.command("start", (ctx) =>
  ctx.reply("Welcome! I'm monitoring proxy requests."),
);

bot.command("help", (ctx) =>
  ctx.reply(
    "Available commands:\n/start - Start the bot\n/help - Show help\n\nI will send you approval requests for proxy traffic.",
  ),
);

bot.on("callback_query:data", async (ctx) => {
  const handler = callbackHandlers.get(ctx.callbackQuery.data);
  if (!handler) {
    await ctx.answerCallbackQuery({
      text: "Request expired or already handled",
    });
    return;
  }
  await handler(ctx);
});

bot.on("message", (ctx) => {
  console.log("Received message:", ctx.message.text);
});

function cleanupRequest(requestId: string) {
  const pending = pendingRequests.get(requestId);
  if (!pending) return;
  clearTimeout(pending.timeout);
  for (const key of pending.callbackKeys) {
    callbackHandlers.delete(key);
  }
  pendingRequests.delete(requestId);
}

function requestApproval(
  host: string,
  method: string,
  path: string,
  patternOptions: PatternOption[],
  signal: AbortSignal,
): Promise<ApprovalResponse> {
  return new Promise<ApprovalResponse>((resolveRaw) => {
    const requestId = String(++requestIdCounter);

    const pendingRequest: PendingRequest<ApprovalResponse> = {
      callbackKeys: [],
      rejectOnce: { type: "reject-once" },
      resolve: (res) => {
        cleanupRequest(requestId);
        resolveRaw(res);
      },
      timeout: setTimeout(() => {
        console.log(`Request ${requestId} timed out`);
        pendingRequest.resolve(pendingRequest.rejectOnce);
      }, APPROVAL_TIMEOUT_MS),
    };
    pendingRequests.set(requestId, pendingRequest);

    // Handle client disconnect
    const onAbort = () => {
      if (!pendingRequests.has(requestId)) return;
      console.log(`Request ${requestId} aborted (client disconnected)`);
      pendingRequest.abortedByClient = true;
      pendingRequest.resolve(pendingRequest.rejectOnce);
      if (pendingRequest.messageId) {
        bot.api
          .editMessageText(
            Number(ownerId),
            pendingRequest.messageId,
            `⊘ Auto-closed (client disconnected):\n\n${method} ${host}\n${code(path)}`,
            { parse_mode: "HTML" },
          )
          .catch(() => {});
      }
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });

    const reg = (key: string, handler: (ctx: any) => Promise<void>): string => {
      pendingRequest.callbackKeys.push(key);

      return registerCallback(key, handler);
    };

    const msg = `🔒 Approval needed:\n\n${method} ${host}\n${code(path)}`;
    const onOnceAllow = reg(`once:allow:${requestId}`, async (ctx) => {
      pendingRequest.resolve({ type: "allow-once" });
      await ctx.answerCallbackQuery({ text: "Allowed (once)" });
      await ctx.editMessageText(
        `✓ Approved (once):\n\n${method} ${host}\n${code(path)}`,
        { parse_mode: "HTML" },
      );
    });
    const onOnceReject = reg(`once:reject:${requestId}`, async (ctx) => {
      pendingRequest.resolve(pendingRequest.rejectOnce);
      await ctx.answerCallbackQuery({ text: "Rejected (once)" });
      await ctx.editMessageText(
        `✗ Rejected (once):\n\n${method} ${host}\n${code(path)}`,
        { parse_mode: "HTML" },
      );
    });

    const keyboard = new InlineKeyboard()
      .text("✓ Once", onOnceAllow)
      .text("✗ Once", onOnceReject)
      .text(
        "✗ Forever",
        reg(`reject-forever:${requestId}`, async (ctx) => {
          await ctx.answerCallbackQuery();
          const rejectKeyboard = new InlineKeyboard()
            .text("✓ Once", onOnceAllow)
            .text("✗ Once", onOnceReject)
            .row();
          patternOptions.forEach((opt, i) => {
            rejectKeyboard
              .text(
                `✗ ${opt.description}`,
                reg(`pat:reject:${requestId}:${i}`, async (ctx) => {
                  pendingRequest.resolve({
                    type: "reject-forever",
                    pattern: opt.pattern,
                  });
                  await ctx.answerCallbackQuery({ text: "Rejected forever" });
                  await ctx.editMessageText(
                    `🔒 Rejected (forever) ✗:\n\n${method} ${host}\n${code(path)}\n${code(opt.description)}`,
                    { parse_mode: "HTML" },
                  );
                }),
              )
              .row();
          });
          await ctx.editMessageText(
            `✗ Reject (forever):\n\n${method} ${host}\n${code(path)}`,
            { reply_markup: rejectKeyboard, parse_mode: "HTML" },
          );
        }),
      )
      .row();

    patternOptions.forEach((opt, i) => {
      keyboard
        .text(
          `✓ ${opt.description}`,
          reg(`pat:allow:${requestId}:${i}`, async (ctx) => {
            pendingRequest.resolve({
              type: "allow-forever",
              pattern: opt.pattern,
            });
            await ctx.answerCallbackQuery({ text: "Allowed forever" });
            await ctx.editMessageText(
              `✓ Approved (forever):\n\n${method} ${host}\n${code(path)}\n${code(opt.description)}`,
              { parse_mode: "HTML" },
            );
          }),
        )
        .row();
    });

    bot.api
      .sendMessage(Number(ownerId), msg, { reply_markup: keyboard, parse_mode: "HTML" })
      .then((sent) => {
        pendingRequest.messageId = sent.message_id;
        // If aborted before sendMessage completed, edit now
        if (pendingRequest.abortedByClient) {
          bot.api
            .editMessageText(
              Number(ownerId),
              sent.message_id,
              `⊘ Auto-closed (client disconnected):\n\n${method} ${host}\n${code(path)}`,
              { parse_mode: "HTML" },
            )
            .catch(() => {});
        }
      })
      .catch((err) => {
        console.error("Failed to send approval request:", err);
        pendingRequest.resolve(pendingRequest.rejectOnce);
      });
  });
}

function requestGitReadApproval(
  host: string,
  repoKey: string,
  signal: AbortSignal,
): Promise<GitReadApprovalResponse> {
  return new Promise<GitReadApprovalResponse>((resolveRaw) => {
    const requestId = String(++requestIdCounter);

    const pendingRequest: PendingRequest<GitReadApprovalResponse> = {
      callbackKeys: [],
      rejectOnce: { type: "reject-once" },
      resolve: (res) => {
        cleanupRequest(requestId);
        resolveRaw(res);
      },
      timeout: setTimeout(() => {
        console.log(`Git read request ${requestId} timed out`);
        pendingRequest.resolve(pendingRequest.rejectOnce);
      }, APPROVAL_TIMEOUT_MS),
    };

    pendingRequests.set(requestId, pendingRequest);

    const onAbort = () => {
      if (!pendingRequests.has(requestId)) return;
      console.log(`Git read request ${requestId} aborted (client disconnected)`);
      pendingRequest.abortedByClient = true;
      pendingRequest.resolve(pendingRequest.rejectOnce);
      if (pendingRequest.messageId) {
        bot.api
          .editMessageText(
            Number(ownerId),
            pendingRequest.messageId,
            `⊘ Auto-closed (client disconnected):\n\nClone/fetch ${code(repoKey)}\nHost: ${code(host)}`,
            { parse_mode: "HTML" },
          )
          .catch(() => {});
      }
    };

    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });

    const reg = (key: string, handler: (ctx: any) => Promise<void>): string => {
      pendingRequest.callbackKeys.push(key);
      return registerCallback(key, handler);
    };

    const onAllowForever = reg(`git:allow:${requestId}`, async (ctx) => {
      pendingRequest.resolve({ type: "allow-forever" });
      await ctx.answerCallbackQuery({ text: "Clone/fetch allowed forever" });
      await ctx.editMessageText(
        `✓ Clone/fetch approved forever:\n\n${code(repoKey)}\nHost: ${code(host)}`,
        { parse_mode: "HTML" },
      );
    });

    const onRejectOnce = reg(`git:reject:${requestId}`, async (ctx) => {
      pendingRequest.resolve(pendingRequest.rejectOnce);
      await ctx.answerCallbackQuery({ text: "Clone/fetch rejected" });
      await ctx.editMessageText(
        `✗ Clone/fetch rejected:\n\n${code(repoKey)}\nHost: ${code(host)}`,
        { parse_mode: "HTML" },
      );
    });

    const keyboard = new InlineKeyboard()
      .text("✓ Allow forever", onAllowForever)
      .text("✗ Reject once", onRejectOnce);

    const msg = `🔒 Allow cloning ${code(repoKey)}?\n\nHost: ${code(host)}`;

    bot.api
      .sendMessage(Number(ownerId), msg, {
        reply_markup: keyboard,
        parse_mode: "HTML",
      })
      .then((sent) => {
        pendingRequest.messageId = sent.message_id;
        if (pendingRequest.abortedByClient) {
          bot.api
            .editMessageText(
              Number(ownerId),
              sent.message_id,
              `⊘ Auto-closed (client disconnected):\n\nClone/fetch ${code(repoKey)}\nHost: ${code(host)}`,
              { parse_mode: "HTML" },
            )
            .catch(() => {});
        }
      })
      .catch((err) => {
        console.error("Failed to send git read approval request:", err);
        pendingRequest.resolve(pendingRequest.rejectOnce);
      });
  });
}

interface BranchPatternOption {
  description: string;
  pattern: string;
  rejectBaseBranch?: string;
}

function generateBranchPatternOptions(
  branch: string,
  baseBranch: string,
): BranchPatternOption[] {
  const options: BranchPatternOption[] = [];
  const seen = new Set<string>();

  const addOption = (option: BranchPatternOption) => {
    const key = `${option.pattern}::${option.rejectBaseBranch ?? ""}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    options.push(option);
  };

  addOption({
    description: branch,
    pattern: branch,
  });

  const segments = branch.split("/").filter((segment) => segment.length > 0);
  if (segments.length > 1) {
    for (let end = segments.length - 1; end >= 1; end -= 1) {
      const prefix = segments.slice(0, end).join("/");
      addOption({
        description: `${prefix}/*`,
        pattern: `${prefix}/*`,
      });
    }
  }

  addOption({
    description: `* (except ${baseBranch})`,
    pattern: "*",
    rejectBaseBranch: baseBranch,
  });

  addOption({
    description: "*",
    pattern: "*",
  });

  return options;
}

function generateRejectPatternOptions(
  options: readonly BranchPatternOption[],
): Array<{ description: string; pattern: string }> {
  const rejectOptions: Array<{ description: string; pattern: string }> = [];
  const seenPatterns = new Set<string>();

  for (const option of options) {
    if (option.rejectBaseBranch) {
      continue;
    }

    if (seenPatterns.has(option.pattern)) {
      continue;
    }

    seenPatterns.add(option.pattern);
    rejectOptions.push({
      description: option.pattern,
      pattern: option.pattern,
    });
  }

  if (!seenPatterns.has("*")) {
    rejectOptions.push({
      description: "*",
      pattern: "*",
    });
  }

  return rejectOptions;
}

function describeGitPushApprovalRequest(
  request: GitPushApprovalRequest,
): {
  prompt: string;
  onceAllowed: string;
  onceRejected: string;
  autoClosed: string;
  onceAllowLabel: string;
  onceRejectLabel: string;
  isBranchApproval: boolean;
} {
  switch (request.type) {
    case "branch":
      return {
        prompt: `🔒 Allow pushing branch ${code(request.ref)} to ${code(request.repo)}?\n\nHost: ${code(request.host)}`,
        onceAllowed: `✓ Branch push approved (once):\n\n${code(request.ref)} → ${code(request.repo)}\nHost: ${code(request.host)}`,
        onceRejected: `✗ Branch push rejected:\n\n${code(request.ref)} → ${code(request.repo)}\nHost: ${code(request.host)}`,
        autoClosed: `⊘ Auto-closed (client disconnected):\n\nPush branch ${code(request.ref)} to ${code(request.repo)}\nHost: ${code(request.host)}`,
        onceAllowLabel: "Branch push allowed once",
        onceRejectLabel: "Branch push rejected",
        isBranchApproval: true,
      };

    case "tag":
      return {
        prompt: `🔒 Allow pushing tag ${code(request.ref)} to ${code(request.repo)}?\n\nHost: ${code(request.host)}`,
        onceAllowed: `✓ Tag push approved (once):\n\n${code(request.ref)} → ${code(request.repo)}\nHost: ${code(request.host)}`,
        onceRejected: `✗ Tag push rejected:\n\n${code(request.ref)} → ${code(request.repo)}\nHost: ${code(request.host)}`,
        autoClosed: `⊘ Auto-closed (client disconnected):\n\nPush tag ${code(request.ref)} to ${code(request.repo)}\nHost: ${code(request.host)}`,
        onceAllowLabel: "Tag push allowed once",
        onceRejectLabel: "Tag push rejected",
        isBranchApproval: false,
      };

    case "branch-deletion":
      return {
        prompt: `🔒 Allow deleting branch ${code(request.ref)} from ${code(request.repo)}?\n\nHost: ${code(request.host)}`,
        onceAllowed: `✓ Branch deletion approved (once):\n\n${code(request.ref)} from ${code(request.repo)}\nHost: ${code(request.host)}`,
        onceRejected: `✗ Branch deletion rejected:\n\n${code(request.ref)} from ${code(request.repo)}\nHost: ${code(request.host)}`,
        autoClosed: `⊘ Auto-closed (client disconnected):\n\nDelete branch ${code(request.ref)} from ${code(request.repo)}\nHost: ${code(request.host)}`,
        onceAllowLabel: "Branch deletion allowed once",
        onceRejectLabel: "Branch deletion rejected",
        isBranchApproval: false,
      };

    case "force-push":
      return {
        prompt: `🔒 Allow force push to branch ${code(request.ref)} in ${code(request.repo)}?\n\nHost: ${code(request.host)}`,
        onceAllowed: `✓ Force push approved (once):\n\n${code(request.ref)} in ${code(request.repo)}\nHost: ${code(request.host)}`,
        onceRejected: `✗ Force push rejected:\n\n${code(request.ref)} in ${code(request.repo)}\nHost: ${code(request.host)}`,
        autoClosed: `⊘ Auto-closed (client disconnected):\n\nForce push ${code(request.ref)} in ${code(request.repo)}\nHost: ${code(request.host)}`,
        onceAllowLabel: "Force push allowed once",
        onceRejectLabel: "Force push rejected",
        isBranchApproval: false,
      };
  }
}

function requestGitPushApproval(
  request: GitPushApprovalRequest,
  signal: AbortSignal,
): Promise<GitPushApprovalResponse> {
  return new Promise<GitPushApprovalResponse>((resolveRaw) => {
    const requestId = String(++requestIdCounter);
    const messages = describeGitPushApprovalRequest(request);

    const pendingRequest: PendingRequest<GitPushApprovalResponse> = {
      callbackKeys: [],
      rejectOnce: { type: "reject-once" },
      resolve: (res) => {
        cleanupRequest(requestId);
        resolveRaw(res);
      },
      timeout: setTimeout(() => {
        console.log(`Git push approval ${requestId} timed out`);
        pendingRequest.resolve(pendingRequest.rejectOnce);
      }, APPROVAL_TIMEOUT_MS),
    };

    pendingRequests.set(requestId, pendingRequest);

    const onAbort = () => {
      if (!pendingRequests.has(requestId)) {
        return;
      }

      console.log(`Git push approval ${requestId} aborted`);
      pendingRequest.abortedByClient = true;
      pendingRequest.resolve(pendingRequest.rejectOnce);

      if (pendingRequest.messageId) {
        bot.api
          .editMessageText(
            Number(ownerId),
            pendingRequest.messageId,
            messages.autoClosed,
            { parse_mode: "HTML" },
          )
          .catch(() => {});
      }
    };

    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });

    const reg = (key: string, handler: (ctx: any) => Promise<void>): string => {
      pendingRequest.callbackKeys.push(key);
      return registerCallback(key, handler);
    };

    const onAllowOnce = reg(`git-push:allow-once:${requestId}`, async (ctx) => {
      pendingRequest.resolve({ type: "allow-once" });
      await ctx.answerCallbackQuery({ text: messages.onceAllowLabel });
      await ctx.editMessageText(messages.onceAllowed, { parse_mode: "HTML" });
    });

    const onRejectOnce = reg(`git-push:reject-once:${requestId}`, async (ctx) => {
      pendingRequest.resolve(pendingRequest.rejectOnce);
      await ctx.answerCallbackQuery({ text: messages.onceRejectLabel });
      await ctx.editMessageText(messages.onceRejected, { parse_mode: "HTML" });
    });

    const keyboard = new InlineKeyboard()
      .text("✓ Once", onAllowOnce)
      .text("✗ Once", onRejectOnce);

    if (messages.isBranchApproval) {
      const baseBranch = request.baseBranch ?? "main";
      const allowPatternOptions = generateBranchPatternOptions(
        request.ref,
        baseBranch,
      );
      const rejectPatternOptions = generateRejectPatternOptions(allowPatternOptions);

      keyboard
        .text(
          "✗ Forever ▸",
          reg(`git-push:reject-menu:${requestId}`, async (ctx) => {
            await ctx.answerCallbackQuery();

            const rejectKeyboard = new InlineKeyboard()
              .text("✓ Once", onAllowOnce)
              .text("✗ Once", onRejectOnce)
              .row();

            rejectPatternOptions.forEach((option, index) => {
              rejectKeyboard
                .text(
                  `✗ ${option.description}`,
                  reg(`git-push:reject:${requestId}:${index}`, async (ctx) => {
                    pendingRequest.resolve({
                      type: "reject-pattern",
                      pattern: option.pattern,
                    });
                    await ctx.answerCallbackQuery({ text: "Rejected forever" });
                    await ctx.editMessageText(
                      `🔒 Branch push rejected forever:\n\n${code(request.ref)} → ${code(request.repo)}\nPattern: ${code(option.description)}\nHost: ${code(request.host)}`,
                      { parse_mode: "HTML" },
                    );
                  }),
                )
                .row();
            });

            await ctx.editMessageText(
              `✗ Reject branch push forever:\n\n${code(request.ref)} → ${code(request.repo)}\nHost: ${code(request.host)}`,
              {
                parse_mode: "HTML",
                reply_markup: rejectKeyboard,
              },
            );
          }),
        )
        .row();

      allowPatternOptions.forEach((option, index) => {
        keyboard
          .text(
            `✓ ${option.description}`,
            reg(`git-push:allow:${requestId}:${index}`, async (ctx) => {
              pendingRequest.resolve({
                type: "allow-pattern",
                pattern: option.pattern,
                ...(option.rejectBaseBranch
                  ? { rejectBaseBranch: option.rejectBaseBranch }
                  : {}),
              });
              await ctx.answerCallbackQuery({ text: "Approved forever" });
              await ctx.editMessageText(
                `✓ Branch push approved forever:\n\n${code(request.ref)} → ${code(request.repo)}\nPattern: ${code(option.description)}\nHost: ${code(request.host)}`,
                { parse_mode: "HTML" },
              );
            }),
          )
          .row();
      });
    }

    bot.api
      .sendMessage(Number(ownerId), messages.prompt, {
        reply_markup: keyboard,
        parse_mode: "HTML",
      })
      .then((sent) => {
        pendingRequest.messageId = sent.message_id;

        if (pendingRequest.abortedByClient) {
          bot.api
            .editMessageText(
              Number(ownerId),
              sent.message_id,
              messages.autoClosed,
              { parse_mode: "HTML" },
            )
            .catch(() => {});
        }
      })
      .catch((error) => {
        console.error("Failed to send git push approval request:", error);
        pendingRequest.resolve(pendingRequest.rejectOnce);
      });
  });
}

const shutdown = () => {
  console.log("Shutting down gracefully...");
  for (const [, pending] of pendingRequests) {
    clearTimeout(pending.timeout);
    pending.resolve(pending.rejectOnce);
  }
  callbackHandlers.clear();
  pendingRequests.clear();
  bot.stop();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

setRequestApprovalHandler(requestApproval);
setGitReadApprovalHandler(requestGitReadApproval);
setGitPushApprovalHandler(requestGitPushApproval);

console.log("Starting bot and proxy...");

bot.start({
  onStart: () => console.log("Bot is now polling for updates"),
});

startProxy();
