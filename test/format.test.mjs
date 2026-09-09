import test from "node:test";
import assert from "node:assert/strict";
import { finalAgentMessage, formatApproval } from "../src/format.mjs";
import { splitTelegramText } from "../src/telegram-client.mjs";

test("Telegram 길이에 맞춰 메시지를 분할한다", () => {
  const chunks = splitTelegramText("a".repeat(9000), 4000);
  assert.deepEqual(chunks.map((chunk) => chunk.length), [4000, 4000, 1000]);
});

test("명령 승인에는 명령과 작업 경로가 표시된다", () => {
  const text = formatApproval("item/commandExecution/requestApproval", {
    command: "npm test",
    cwd: "C:\\work",
    reason: "테스트 실행",
  });
  assert.match(text, /npm test/);
  assert.match(text, /C:\\work/);
});

test("샌드박스 재시도 사유를 한국어로 설명한다", () => {
  const text = formatApproval("item/commandExecution/requestApproval", {
    command: "Get-CimInstance Win32_Process",
    cwd: "C:\\work",
    reason: "command failed; retry without sandbox",
  });
  assert.match(text, /샌드박스 안에서 명령이 실패/);
  assert.doesNotMatch(text, /command failed/);
});

test("완료 turn의 마지막 agentMessage를 선택한다", () => {
  const result = finalAgentMessage({ items: [
    { type: "agentMessage", text: "첫 번째" },
    { type: "commandExecution" },
    { type: "agentMessage", text: "최종" },
  ]});
  assert.equal(result, "최종");
});
