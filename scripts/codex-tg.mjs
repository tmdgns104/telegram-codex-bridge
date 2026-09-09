import { loadDotEnv, readConfig } from "../src/config.mjs";
import { sendLocalPrompt } from "../src/local-control.mjs";

loadDotEnv();

const text = process.argv.slice(2).join(" ").trim();
if (!text) {
  console.error('Usage: codex-tg "your task"');
  process.exitCode = 2;
} else {
  try {
    const config = readConfig();
    const result = await sendLocalPrompt({
      token: config.telegramToken,
      chatId: config.allowedChatId,
      text,
    });
    console.log(result.message || "Task sent. Approvals and results will arrive in Telegram.");
  } catch (error) {
    console.error(`Failed to send task: ${error.message}`);
    process.exitCode = 1;
  }
}
