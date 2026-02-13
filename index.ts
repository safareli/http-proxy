import { Bot, InlineKeyboard } from "grammy";
import {
  startProxy,
  setRequestApprovalHandler,
  type ApprovalResponse,
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

interface PendingRequest {
  resolve: (response: ApprovalResponse) => void;
  timeout: Timer;
  callbackKeys: string[];
}

const pendingRequests = new Map<string, PendingRequest>();
let requestIdCounter = 0;

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
): Promise<ApprovalResponse> {
  return new Promise<ApprovalResponse>((resolveRaw) => {
    const requestId = String(++requestIdCounter);

    const pendingRequest: PendingRequest = {
      callbackKeys: [],
      resolve: (res: ApprovalResponse) => {
        cleanupRequest(requestId);
        resolveRaw(res);
      },
      timeout: setTimeout(() => {
        console.log(`Request ${requestId} timed out`);
        pendingRequest.resolve({ type: "reject-once" });
      }, APPROVAL_TIMEOUT_MS),
    };
    pendingRequests.set(requestId, pendingRequest);

    const reg = (key: string, handler: (ctx: any) => Promise<void>): string => {
      pendingRequest.callbackKeys.push(key);

      return registerCallback(key, handler);
    };

    const msg = `🔒 Approval needed:\n\n${method} ${host} ${path}`;
    const onOnceAllow = reg(`once:allow:${requestId}`, async (ctx) => {
      pendingRequest.resolve({ type: "allow-once" });
      await ctx.answerCallbackQuery({ text: "Allowed (once)" });
      await ctx.editMessageText(
        `✓ Approved (once): ${method} ${host} ${path}\n\n`,
      );
    });
    const onOnceReject = reg(`once:reject:${requestId}`, async (ctx) => {
      pendingRequest.resolve({ type: "reject-once" });
      await ctx.answerCallbackQuery({ text: "Rejected (once)" });
      await ctx.editMessageText(
        `✗ Rejected (once): ${method} ${host} ${path}\n\n`,
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
                    `🔒 Rejected (forever) ✗: ${method} ${host} ${path}\n ${opt.description}\n`,
                  );
                }),
              )
              .row();
          });
          await ctx.editMessageText(
            `✗ Reject (forever):\n\n${method} ${host} ${path}`,
            { reply_markup: rejectKeyboard },
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
              `✓ Approved (forever): ${method} ${host} ${path}\n ${opt.description}\n`,
            );
          }),
        )
        .row();
    });

    bot.api
      .sendMessage(Number(ownerId), msg, { reply_markup: keyboard })
      .catch((err) => {
        console.error("Failed to send approval request:", err);
        pendingRequest.resolve({ type: "reject-once" });
      });
  });
}

const shutdown = () => {
  console.log("Shutting down gracefully...");
  for (const [, pending] of pendingRequests) {
    clearTimeout(pending.timeout);
    pending.resolve({ type: "reject-once" });
  }
  callbackHandlers.clear();
  pendingRequests.clear();
  bot.stop();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

setRequestApprovalHandler(requestApproval);

console.log("Starting bot and proxy...");

bot.start({
  onStart: () => console.log("Bot is now polling for updates"),
});

startProxy();
