import { Bot, InlineKeyboard } from "grammy";

const token = process.env.TELEGRAM_API_TOKEN;
if (!token) {
  throw new Error("TELEGRAM_API_TOKEN is not set");
}

const ownerId = process.env.TELEGRAM_OWNER_ID;
if (!ownerId) {
  throw new Error("TELEGRAM_OWNER_ID is not set");
}

const bot = new Bot(token);

bot.use((ctx, next) => {
  if (ctx.from?.id !== Number(ownerId)) {
    console.log(`Ignoring message from non-owner: ${ctx.from?.id}`);
    return;
  }
  return next();
});

bot.command("start", (ctx) => ctx.reply("Welcome!"));

bot.command("help", (ctx) =>
  ctx.reply(
    "Available commands:\n/start - Start the bot\n/help - Show help\n/question - Show a question with choices",
  ),
);

bot.command("question", (ctx) => {
  const keyboard = new InlineKeyboard()
    .text("Option A", "choice:a")
    .text("Option B", "choice:b")
    .row()
    .text("Option C", "choice:c")
    .text("Option D", "choice:d");

  return ctx.reply("Choose an option:", { reply_markup: keyboard });
});

bot.callbackQuery("choice:a", (ctx) => {
  ctx.answerCallbackQuery({ text: "You chose A!" });
  return ctx.editMessageText("You selected: Option A ✓");
});

bot.callbackQuery("choice:b", (ctx) => {
  ctx.answerCallbackQuery({ text: "You chose B!" });
  return ctx.editMessageText("You selected: Option B ✓");
});

bot.callbackQuery("choice:c", (ctx) => {
  ctx.answerCallbackQuery({ text: "You chose C!" });
  return ctx.editMessageText("You selected: Option C ✓");
});

bot.callbackQuery("choice:d", (ctx) => {
  ctx.answerCallbackQuery({ text: "You chose D!" });
  return ctx.editMessageText("You selected: Option D ✓");
});

bot.on("message", (ctx) => {
  console.log("Received message:", ctx.message.text);
});

const shutdown = () => {
  console.log("Shutting down gracefully...");
  bot.stop();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

console.log("Starting bot...");
bot.start({
  onStart: () => console.log("Bot is now polling for updates"),
});
