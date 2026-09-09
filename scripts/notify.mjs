import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadDotEnv } from "../src/config.mjs";
import { TelegramClient } from "../src/telegram-client.mjs";
import { claimNotification, deliverNotification } from "../src/notification-delivery.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
try {
  if (process.env.TELEGRAM_CODEX_BRIDGE_CHILD !== "1") {
    let input = "";
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) {
      input += chunk;
      if (Buffer.byteLength(input) > 2 * 1024 * 1024) throw new Error("payload too large");
    }
    const event = JSON.parse(input);
    loadDotEnv(path.join(root, ".env"));
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.ALLOWED_CHAT_ID;
    if (token && chatId) {
      const telegram = new TelegramClient(token, { requestTimeoutMs: 4000 });
      try {
        await deliverNotification({ event, telegram, chatId,
          claim: () => claimNotification({ directory: path.join(root, ".notify-dedup"), token, chatId, event }) });
      } finally { telegram.stop(); }
    }
  }
} catch {
  console.error("Telegram 알림 전달을 확인하지 못했습니다. PC의 원래 Codex 대화에서 결과를 확인하세요.");
  process.exitCode = 1;
}
