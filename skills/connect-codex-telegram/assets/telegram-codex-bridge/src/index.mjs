import { AppServerClient } from "./app-server-client.mjs";
import { CodexTelegramBridge } from "./bridge.mjs";
import { loadDotEnv, readConfig } from "./config.mjs";
import { acquireSingleton } from "./singleton.mjs";
import { TelegramClient } from "./telegram-client.mjs";

loadDotEnv();

let singletonLock;
let telegram;
let appServer;

try {
  const config = readConfig();
  singletonLock = await acquireSingleton({
    token: config.telegramToken,
    chatId: config.allowedChatId,
  });
  telegram = new TelegramClient(config.telegramToken);
  appServer = new AppServerClient({ codexBin: config.codexBin });
  const bridge = new CodexTelegramBridge({ appServer, telegram, config });

  const shutdown = () => {
    telegram.stop();
    appServer.close();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  await bridge.start();
  console.log(`Telegram Codex Bridge 시작: ${config.workdir}`);
  await telegram.sendMessage(config.allowedChatId, "🟢 Telegram Codex Bridge가 시작되었습니다. /help를 입력하세요.");
  await telegram.poll((update) => bridge.handleUpdate(update), config.pollTimeout);
} catch (error) {
  console.error(`시작 실패: ${error.message}`);
  process.exitCode = 1;
} finally {
  telegram?.stop();
  appServer?.close();
  await singletonLock?.close();
}
