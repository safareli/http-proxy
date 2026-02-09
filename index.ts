import { Bot, InlineKeyboard } from "grammy";
import {
  startProxy,
  setRequestApprovalHandler,
  type ApprovalResponse,
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
  host: string;
  method: string;
  path: string;
  timeout: Timer;
}

const pendingRequests = new Map<string, PendingRequest>();
let requestIdCounter = 0;

const bot = new Bot(token);

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

bot.callbackQuery(/^approve:(.+):(.+)$/, async (ctx) => {
  const match = ctx.match;
  if (!match || !match[1] || !match[2]) {
    await ctx.answerCallbackQuery({ text: "Invalid callback data" });
    return;
  }
  const requestId = match[1];
  const action = match[2] as ApprovalResponse;

  const pending = pendingRequests.get(requestId);
  if (!pending) {
    await ctx.answerCallbackQuery({
      text: "Request expired or already handled",
    });
    return;
  }

  clearTimeout(pending.timeout);
  pendingRequests.delete(requestId);
  pending.resolve(action);

  const actionLabels: Record<ApprovalResponse, string> = {
    "allow-once": "Allowed (once)",
    "allow-forever": "Allowed (forever)",
    "reject-once": "Rejected (once)",
    "reject-forever": "Rejected (forever)",
  };

  await ctx.answerCallbackQuery({ text: actionLabels[action] });
  await ctx.editMessageText(
    `${pending.method} ${pending.host}${pending.path}\n\n✓ ${actionLabels[action]}`,
  );
});

bot.on("message", (ctx) => {
  console.log("Received message:", ctx.message.text);
});

function requestApproval(
  host: string,
  method: string,
  path: string,
): Promise<ApprovalResponse> {
  return new Promise((resolve) => {
    const requestId = String(++requestIdCounter);

    const timeout = setTimeout(() => {
      pendingRequests.delete(requestId);
      console.log(`Request ${requestId} timed out`);
      resolve("reject-once");
    }, APPROVAL_TIMEOUT_MS);

    pendingRequests.set(requestId, {
      resolve,
      host,
      method,
      path,
      timeout,
    });

    const keyboard = new InlineKeyboard()
      .text("✓ Once", `approve:${requestId}:allow-once`)
      .text("✓ Forever", `approve:${requestId}:allow-forever`)
      .row()
      .text("✗ Once", `approve:${requestId}:reject-once`)
      .text("✗ Forever", `approve:${requestId}:reject-forever`);

    bot.api
      .sendMessage(
        Number(ownerId),
        `🔒 Approval needed:\n\n${method} ${host}${path}`,
        { reply_markup: keyboard },
      )
      .catch((err) => {
        console.error("Failed to send approval request:", err);
        pendingRequests.delete(requestId);
        clearTimeout(timeout);
        resolve("reject-once");
      });
  });
}

const shutdown = () => {
  console.log("Shutting down gracefully...");
  for (const [, pending] of pendingRequests) {
    clearTimeout(pending.timeout);
    pending.resolve("reject-once");
  }
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
