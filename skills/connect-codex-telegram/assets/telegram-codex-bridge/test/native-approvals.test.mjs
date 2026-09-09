import test from "node:test";
import assert from "node:assert/strict";
import { NativeApprovals, permissionHookOutput, validatePermissionEvent } from "../src/native-approvals.mjs";
import { LocalControlServer, sendLocalRequest } from "../src/local-control.mjs";

const tick = () => new Promise((r) => setImmediate(r));
const event = () => ({ hook_event_name: "PermissionRequest", session_id: "session-a", turn_id: "turn-a", cwd: process.cwd(), tool_name: "Bash", tool_input: { command: "echo synthetic" } });
function fixture(t, options = {}) {
  const messages = [], documents = [], removed = [];
  const telegram = { async sendMessage(chat, text, options) { const item = { message_id: messages.length + 1, text, options }; messages.push(item); return item; },
    async answerCallbackQuery() {}, async removeKeyboard(chat, id) { removed.push(id); }, async sendTextDocument(chat, text) { documents.push(text); } };
  const approvals = new NativeApprovals({ telegram, chatId: "123", isAllowedProject: () => true, ...options });
  t.after(() => approvals.close());
  const callback = (action = "allow", index = 0) => ({ id: "callback", message: { chat: { id: 123 } },
    data: messages[index].options.reply_markup.inline_keyboard[0][0].callback_data.replace(/:allow$/, `:${action}`) });
  return { approvals, telegram, messages, documents, removed, callback };
}

test("native approval binds simultaneous PC requests, details and one-time decisions", async (t) => {
  const f = fixture(t);
  const first = f.approvals.request(event());
  const second = f.approvals.request({ ...event(), session_id: "session-b" });
  await tick();
  await f.approvals.handleCallback(f.callback("detail"));
  assert.match(f.documents[0], /echo synthetic/);
  assert.equal(f.approvals.pending.size, 2);
  await f.approvals.handleCallback({ ...f.callback(), message: { chat: { id: 999 } } });
  assert.equal(f.approvals.pending.size, 2);
  await f.approvals.handleCallback(f.callback("deny", 1));
  assert.equal((await second).decision, "deny");
  await f.approvals.handleCallback(f.callback());
  await f.approvals.handleCallback(f.callback());
  assert.equal((await first).decision, "allow");
  assert.equal(f.approvals.pending.size, 0);
  assert.equal(f.removed.length, 2);
});

test("expired, disconnected, unregistered and secret requests never return allow", async (t) => {
  const f = fixture(t, { timeoutMs: 10 });
  assert.equal((await f.approvals.request(event())).decision, "fallback");
  const controller = new AbortController();
  const result = f.approvals.request(event(), controller.signal);
  controller.abort();
  assert.equal((await result).decision, "fallback");
  const excluded = fixture(t, { isAllowedProject: () => false });
  assert.equal((await excluded.approvals.request(event())).reason, "unregistered_project");
  assert.equal(excluded.messages.length, 0);
  assert.equal((await f.approvals.request({ ...event(), tool_input: { command: "api_key=synthetic_secret_value" } })).reason, "sensitive_input");
  assert.throws(() => validatePermissionEvent({ ...event(), cwd: "relative" }));
  assert.deepEqual(permissionHookOutput("fallback"), {});
  assert.equal(permissionHookOutput("deny").hookSpecificOutput.decision.behavior, "deny");
});

test("native permission uses the authenticated existing loopback without starting a Codex task", async (t) => {
  const f = fixture(t);
  let prompts = 0;
  const server = new LocalControlServer({ token: "synthetic", chatId: "123", port: 0, onPrompt: () => prompts++,
    onPermission: (value, signal) => f.approvals.request(value, signal) });
  await server.start();
  t.after(() => server.close());
  const result = sendLocalRequest({ token: "synthetic", chatId: "123", port: server.port, request: { action: "permission", event: event() } });
  for (let i = 0; i < 30 && !f.messages.length; i++) await new Promise((r) => setTimeout(r, 5));
  await f.approvals.handleCallback(f.callback());
  assert.equal((await result).decision, "allow");
  assert.equal(prompts, 0);
  await assert.rejects(sendLocalRequest({ token: "wrong", chatId: "123", port: server.port, request: { action: "permission", event: event() } }));
  assert.equal(f.messages.length, 1);
});

test("late delivery after disconnect removes its keyboard and cannot authorize", async (t) => {
  const f = fixture(t);
  let release;
  const send = f.telegram.sendMessage;
  f.telegram.sendMessage = async (...args) => { await new Promise((r) => { release = r; }); return send(...args); };
  const controller = new AbortController();
  const result = f.approvals.request(event(), controller.signal);
  controller.abort();
  release();
  await tick();
  assert.equal((await result).decision, "fallback");
  assert.equal(f.removed.length, 1);
  await f.approvals.handleCallback(f.callback());
  assert.equal(f.approvals.pending.size, 0);
});

test("removing project authorization revokes an already delivered PC approval", async (t) => {
  let allowed = true;
  const f = fixture(t, { isAllowedProject: () => allowed });
  const request = f.approvals.request(event());
  await tick();
  allowed = false;
  await f.approvals.handleCallback(f.callback());
  assert.equal((await request).decision, "fallback");
  assert.equal(f.approvals.pending.size, 0);
});
