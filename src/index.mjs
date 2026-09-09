import { AppServerClient } from "./app-server-client.mjs";
import { CodexTelegramBridge } from "./bridge.mjs";
import { loadDotEnv, readConfig } from "./config.mjs";
import { LocalControlServer } from "./local-control.mjs";
import { acquireSingleton } from "./singleton.mjs";
import { TelegramClient } from "./telegram-client.mjs";

loadDotEnv();

let singletonLock;
let telegram;
let appServer;
let localControl;

try {
  const config = readConfig();
  singletonLock = await acquireSingleton({
    token: config.telegramToken,
    chatId: config.allowedChatId,
  });
  telegram = new TelegramClient(config.telegramToken);
  appServer = new AppServerClient({ codexBin: config.codexBin });
  const bridge = new CodexTelegramBridge({ appServer, telegram, config });
  localControl = new LocalControlServer({
    token: config.telegramToken,
    chatId: config.allowedChatId,
    onPrompt: (text) => bridge.submitLocalPrompt(text),
  });

  const shutdown = () => {
    telegram.stop();
    void localControl.close();
    appServer.close();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  await bridge.start();
  await localControl.start();
  console.log(`Telegram Codex Bridge 시작: ${config.workdir}`);
  await telegram.sendMessage(
    config.allowedChatId,
    `📂 Codex 작업 경로: ${config.workdir}\n\n🟢 Telegram Codex Bridge가 시작되었습니다. /help를 입력하세요.`,
  );
  await telegram.poll((update) => bridge.handleUpdate(update), config.pollTimeout);
} catch (error) {
  console.error(`시작 실패: ${error.message}`);
  process.exitCode = 1;
} finally {
  telegram?.stop();
  await localControl?.close();
  appServer?.close();
  await singletonLock?.close();
}
