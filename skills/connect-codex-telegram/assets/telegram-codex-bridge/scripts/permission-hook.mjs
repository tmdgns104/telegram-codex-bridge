import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadDotEnv } from "../src/config.mjs";
import { sendLocalRequest } from "../src/local-control.mjs";
import { permissionHookOutput, validatePermissionEvent } from "../src/native-approvals.mjs";

// stdout is the Codex hook protocol. Diagnostics and credentials never go there.
let output = {};
try {
  if (process.env.TELEGRAM_CODEX_BRIDGE_CHILD !== "1") {
    let text = "";
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) {
      text += chunk;
      if (Buffer.byteLength(text) > 48 * 1024) throw new Error("oversized");
    }
    const input = JSON.parse(text);
    validatePermissionEvent(input);
    // Only copy protocol fields needed for approval; never forward transcript paths/history.
    const event = Object.fromEntries(["hook_event_name", "session_id", "turn_id", "cwd", "tool_name", "tool_input"].map((key) => [key, input[key]]));
    loadDotEnv(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.env"));
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.ALLOWED_CHAT_ID;
    if (token && chatId) {
      const result = await sendLocalRequest({ token, chatId, timeoutMs: 305_000, request: { action: "permission", event } });
      output = permissionHookOutput(result.decision);
      if (result.decision === "fallback") process.stderr.write("Telegram 승인 연결을 사용할 수 없어 PC 승인 화면으로 돌아갑니다. 프로젝트 등록과 브리지 상태를 확인하세요.\n");
    }
  }
} catch { process.stderr.write("Telegram 승인을 확인하지 못했습니다. PC의 승인 화면에서 확인하세요.\n"); }
process.stdout.write(JSON.stringify(output) + "\n");
