import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { envFileValues, installPermissionHook, writeSettings, discoverPersonalChats } from "../src/setup.mjs";
import { readConfig } from "../src/config.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
try {
  if (args.includes("--help")) {
    console.log("설정: npm run setup\n기존 설정에 PC 승인 hook 추가: npm run setup -- --install-hook --non-interactive\n토큰은 숨겨 입력하며 출력하지 않습니다.");
  } else {
    const file = path.join(root, ".env");
    const values = envFileValues(file);
    if (!args.includes("--non-interactive")) {
      let muted = false;
      const output = new Writable({ write(chunk, encoding, callback) { if (!muted) process.stdout.write(chunk); callback(); } });
      const input = createInterface({ input: process.stdin, output, terminal: Boolean(process.stdin.isTTY) });
      try {
        process.stdout.write(values.TELEGRAM_BOT_TOKEN ? "봇 토큰 (Enter: 기존 값 유지): " : "BotFather의 봇 토큰: ");
        muted = true;
        const token = (await input.question("")).trim();
        muted = false;
        process.stdout.write("\n");
        if (token) values.TELEGRAM_BOT_TOKEN = token;
        values.ALLOWED_CHAT_ID = (await input.question("개인 chat ID (Enter: 기존 값 유지 / 처음이면 자동 조회): ")).trim() || values.ALLOWED_CHAT_ID;
        if (!values.ALLOWED_CHAT_ID && values.TELEGRAM_BOT_TOKEN) {
          const chats = await discoverPersonalChats(values.TELEGRAM_BOT_TOKEN);
          if (chats.length === 1) { values.ALLOWED_CHAT_ID = chats[0]; console.log("봇에 메시지를 보낸 개인 채팅을 찾았습니다."); }
          else {
            writeSettings(file, { TELEGRAM_BOT_TOKEN: values.TELEGRAM_BOT_TOKEN });
            throw new Error(chats.length ? "개인 채팅이 여러 개입니다. discover:chat-id로 확인한 ID를 입력하세요." : "토큰을 저장했습니다. 봇에 /start를 보낸 뒤 setup을 다시 실행하세요.");
          }
        }
        values.CODEX_WORKDIR = (await input.question(`프로젝트 절대 경로 (Enter: ${values.CODEX_WORKDIR || root}): `)).trim().replace(/^"|"$/g, "") || values.CODEX_WORKDIR || root;
        readConfig(values);
        writeSettings(file, values);
      } finally { input.close(); }
    } else readConfig(values);
    if (args.includes("--install-hook")) {
      const result = installPermissionHook({ codexHome: process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), bridgeRoot: root });
      console.log(result.changed ? "PC 승인 hook을 기존 설정에 추가했습니다. 기존 hook은 보존했습니다." : "PC 승인 hook이 이미 설치되어 있습니다.");
      console.log("Codex /hooks에서 새 hook을 검토·신뢰한 뒤 새 세션에서 사용하세요. 설치 프로그램은 신뢰 상태를 변경하지 않습니다.");
    }
    console.log("설정 확인 완료. npm run doctor → start.cmd → Telegram /menu 순서로 사용하세요.");
  }
} catch (error) { console.error(`설정을 완료하지 못했습니다. ${error.message}`); process.exitCode = 1; }
