import { loadDotEnv, readConfig } from "../src/config.mjs";
import { getLocalTask, submitLocalTask } from "../src/local-control.mjs";

const args = process.argv.slice(2);
const help = [
  '작업 보내기: codex-tg "테스트하고 오류를 수정해줘"',
  "접수 확인:   codex-tg --status",
  "특정 접수:   codex-tg --status <접수 번호>",
  "",
  "승인·질문·완료 결과는 Telegram에서 확인합니다.",
  "놓친 승인·질문은 /pending, 연결 복구는 /reconnect를 사용하세요.",
].join("\n");

if (!args.length || args[0] === "--help" || args[0] === "-h") {
  console.log(help);
} else if ((args[0] === "--status" && args.length > 2) || (args[0].startsWith("--") && args[0] !== "--status")) {
  console.error(help);
  process.exitCode = 2;
} else {
  try {
    loadDotEnv();
    const config = readConfig();
    const connection = { token: config.telegramToken, chatId: config.allowedChatId };
    const result = args[0] === "--status"
      ? await getLocalTask({ ...connection, requestId: args[1] })
      : await submitLocalTask({ ...connection, text: args.join(" ").trim() });
    console.log(result.message);
    if (result.requestId) {
      console.log(`접수 번호: ${result.requestId}`);
      console.log(`확인 명령: codex-tg --status ${result.requestId}`);
    }
    if (result.status === "rejected") process.exitCode = 1;
    else if (result.status === "unknown" || result.status === "not_found") process.exitCode = 3;
  } catch (error) {
    console.error(error.message);
    if (error.requestId) {
      console.error(`접수 확인: codex-tg --status ${error.requestId}`);
      console.error("같은 작업을 새 요청으로 다시 보내기 전에 접수 상태를 확인하세요.");
    }
    process.exitCode = error.transport ? 3 : 1;
  }
}
