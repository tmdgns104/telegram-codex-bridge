import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import { LocalControlServer } from "../src/local-control.mjs";
import { NativeApprovals } from "../src/native-approvals.mjs";

function invoke(event, token, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.resolve("scripts/permission-hook.mjs")], { windowsHide: true,
      env: { ...process.env, TELEGRAM_BOT_TOKEN: token, ALLOWED_CHAT_ID: "123", TELEGRAM_CODEX_BRIDGE_CHILD: "0", ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (v) => { stdout += v; }); child.stderr.on("data", (v) => { stderr += v; });
    child.once("error", reject); child.once("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(event));
  });
}

test("real Node hook stdin and authenticated transport return only the native decision contract", async (t) => {
  const token = `synthetic-${crypto.randomUUID()}`;
  const events = [];
  const messages = [];
  const approvals = new NativeApprovals({ chatId: "123", isAllowedProject: () => true, telegram: {
    async sendMessage(chat, text, options) { messages.push({ text, options }); return { message_id: messages.length }; },
    async answerCallbackQuery() {}, async removeKeyboard() {},
  } });
  t.after(() => approvals.close());
  const server = new LocalControlServer({ token, chatId: "123", onPrompt: () => { throw new Error("must not start a prompt"); },
    onPermission: async (event, signal) => { events.push(event); return approvals.request(event, signal); } });
  await server.start(); t.after(() => server.close());
  const event = { hook_event_name: "PermissionRequest", session_id: "s-1", turn_id: "t-1", cwd: process.cwd(), tool_name: "Bash",
    tool_input: { command: "echo 한글 🐈" }, transcript_path: "/synthetic/private/transcript.jsonl" };
  const pending = invoke(event, token);
  for (let i = 0; i < 200 && !messages.length; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(messages.length, 1);
  await approvals.handleCallback({ id: "synthetic-human", message: { chat: { id: 123 } }, data: messages[0].options.reply_markup.inline_keyboard[0][0].callback_data });
  const result = await pending;
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } });
  assert.equal(events[0].tool_input.command, event.tool_input.command);
  assert.equal(events[0].transcript_path, undefined);
  assert.equal(result.stderr, "");
  const malformed = await invoke({}, token);
  assert.deepEqual(JSON.parse(malformed.stdout), {});
  assert.equal(events.length, 1);
  const suppressed = await invoke(event, token, { TELEGRAM_CODEX_BRIDGE_CHILD: "1" });
  assert.deepEqual(JSON.parse(suppressed.stdout), {});
  assert.equal(events.length, 1);
});
