import crypto from "node:crypto";
import path from "node:path";
import { clip } from "./format.mjs";
import { projectName, shortTaskId } from "./result-presentation.mjs";

export function validatePermissionEvent(event) {
  if (event?.hook_event_name !== "PermissionRequest" ||
      ![event.session_id, event.turn_id, event.cwd, event.tool_name].every((v) => typeof v === "string" && v.length > 0 && v.length < 4096) ||
      !path.isAbsolute(event.cwd) || !event.tool_input || typeof event.tool_input !== "object" || Array.isArray(event.tool_input)) {
    throw new Error("유효한 PC 승인 요청이 아닙니다.");
  }
  if (Buffer.byteLength(JSON.stringify(event)) > 48 * 1024) throw new Error("PC 승인 요청이 너무 큽니다. PC에서 확인하세요.");
}

export function permissionHookOutput(decision) {
  if (!new Set(["allow", "deny"]).has(decision)) return {};
  return { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: {
    behavior: decision, ...(decision === "deny" ? { message: "Telegram에서 요청을 거부했습니다." } : {}),
  } } };
}

// Only a live, delivered request can consume a human decision. No decisions survive restart.
export class NativeApprovals {
  constructor({ telegram, chatId, isAllowedProject = () => false, timeoutMs = 300_000, now = Date.now }) {
    Object.assign(this, { telegram, chatId, isAllowedProject, timeoutMs, now });
    this.pending = new Map();
  }

  request(event, signal) {
    validatePermissionEvent(event);
    if (!this.isAllowedProject(event.cwd)) return Promise.resolve({ decision: "fallback", reason: "unregistered_project" });
    if (signal?.aborted || this.pending.size >= 32) return Promise.resolve({ decision: "fallback", reason: "unavailable" });
    const token = crypto.randomBytes(12).toString("hex");
    const id = shortTaskId(event.cwd, event.session_id, event.turn_id);
    const original = JSON.stringify(event.tool_input, null, 2);
    // Never forward recognized credentials inside a command or MCP argument.
    if (/(?:\b(?:sk-proj-|ghp_|github_pat_)[\w-]{12,}|\b\d{8,12}:[\w-]{30,}|(?:password|api[_-]?key|authorization)\s*[=:]\s*["']?[^\s"']{8,})/i.test(original)) {
      return Promise.resolve({ decision: "fallback", reason: "sensitive_input" });
    }
    return new Promise((resolve) => {
      const entry = { token, event, id, original, resolve, ready: false, messageIds: new Set(),
        expiresAt: this.now() + this.timeoutMs };
      entry.abort = () => this.finish(token, "fallback", "disconnected");
      entry.signal = signal;
      signal?.addEventListener("abort", entry.abort, { once: true });
      entry.timer = setTimeout(() => this.finish(token, "fallback", "expired"), this.timeoutMs);
      this.pending.set(token, entry);
      void this.send(entry).catch(() => this.finish(token, "fallback", "delivery_failed"));
    });
  }

  async send(entry) {
    if (!this.isAllowedProject(entry.event.cwd)) { this.finish(entry.token, "fallback", "unregistered_project"); return; }
    if (entry.sending) return entry.sending;
    entry.sending = (async () => {
      const { event, id, token } = entry;
      const seconds = Math.max(0, Math.ceil((entry.expiresAt - this.now()) / 1000));
      const text = `🔐 PC 승인 요청\n📂 ${projectName(event.cwd)} · #${id}\n이 PC 요청에만 적용 · ${seconds}초 후 만료\n\n도구: ${event.tool_name}\n위치: ${event.cwd}\n\n${clip(entry.original, 1700)}`;
      const sent = await this.telegram.sendMessage(this.chatId, text, { retry: true,
        reply_markup: { inline_keyboard: [
          [{ text: "✅ 이번 요청 허용", callback_data: `n:${token}:allow` }, { text: "❌ 거부", callback_data: `n:${token}:deny` }],
          [{ text: "📄 요청 전체 내용", callback_data: `n:${token}:detail` }],
        ] } });
      if (this.pending.get(token) === entry) {
        entry.messageIds.add(sent.message_id);
        entry.ready = true;
      } else await this.telegram.removeKeyboard(this.chatId, sent.message_id).catch(() => {});
    })().finally(() => { entry.sending = null; });
    return entry.sending;
  }

  async handleCallback(query) {
    const [prefix, token, action, extra] = String(query.data || "").split(":");
    if (prefix !== "n") return false;
    if (String(query.message?.chat?.id) !== String(this.chatId)) return true;
    const entry = this.pending.get(token);
    if (entry && !this.isAllowedProject(entry.event.cwd)) this.finish(token, "fallback", "unregistered_project");
    if (extra || !this.pending.has(token) || !entry?.ready || !["allow", "deny", "detail"].includes(action) || this.now() >= entry.expiresAt) {
      await this.telegram.answerCallbackQuery(query.id, "처리되었거나 만료된 PC 요청입니다.");
      return true;
    }
    if (action === "detail") {
      await this.telegram.answerCallbackQuery(query.id, "요청 원문을 보내겠습니다.");
      await this.telegram.sendTextDocument(this.chatId, `도구: ${entry.event.tool_name}\n위치: ${entry.event.cwd}\n\n${entry.original}`,
        `approval-${entry.id}.txt`, { disable_notification: true });
    } else {
      this.finish(token, action, "human_decision");
      await this.telegram.answerCallbackQuery(query.id, action === "allow" ? "PC에 허용 결정을 전달했습니다." : "PC에 거부 결정을 전달했습니다.");
    }
    return true;
  }

  finish(token, decision, reason) {
    const entry = this.pending.get(token);
    if (!entry) return;
    this.pending.delete(token);
    clearTimeout(entry.timer);
    entry.signal?.removeEventListener("abort", entry.abort);
    entry.resolve({ decision, reason });
    for (const id of entry.messageIds) void this.telegram.removeKeyboard(this.chatId, id).catch(() => {});
  }

  async resend() { await Promise.allSettled([...this.pending.values()].map((entry) => this.send(entry))); }
  close() { for (const token of this.pending.keys()) this.finish(token, "fallback", "shutdown"); }
}
