import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { notificationPresentation } from "./result-presentation.mjs";
import { acquireSingleton } from "./singleton.mjs";

const RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_MARKERS = 1000;

export async function claimNotification(options) {
  if (!options.event["thread-id"] || !options.event["turn-id"]) return { status: "unidentified" };
  let lock;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      // Reuse the OS-released loopback lock for a short disk transaction, never for delivery.
      lock = await acquireSingleton({ token: `notification-receipts:${path.resolve(options.directory)}`, chatId: "lock" });
      break;
    } catch (error) {
      if (error.code !== "BRIDGE_ALREADY_RUNNING" || attempt === 49) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  try { return claimUnderLock(options); }
  finally { await lock.close(); }
}

function claimUnderLock({ directory, token, chatId, event, now = Date.now() }) {
  if (!event["thread-id"] || !event["turn-id"]) return { status: "unidentified" };
  fs.mkdirSync(directory, { recursive: true });
  const retained = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
    const file = path.join(directory, entry.name);
    try {
      const modified = fs.statSync(file).mtimeMs;
      if (now - modified > RETENTION_MS) fs.unlinkSync(file);
      else retained.push({ file, modified });
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  const key = crypto.createHash("sha256").update(JSON.stringify([
    token, String(chatId), event.cwd || "", event["thread-id"], event["turn-id"],
  ])).digest("hex");
  const marker = path.join(directory, `${key}.json`);
  if (fs.existsSync(marker)) return { status: "duplicate" };
  if (retained.length >= MAX_MARKERS) {
    retained.sort((a, b) => a.modified - b.modified || a.file.localeCompare(b.file));
    for (const old of retained.slice(0, retained.length - MAX_MARKERS + 1)) fs.unlinkSync(old.file);
  }
  try {
    // Claim before any Telegram I/O. An uncertain send must not become an automatic retry.
    fs.writeFileSync(marker, JSON.stringify({ attemptedAt: now }), { flag: "wx", mode: 0o600 });
    return { status: "claimed" };
  } catch (error) {
    if (error.code === "EEXIST") return { status: "duplicate" };
    throw error;
  }
}

export async function deliverNotification({ event, telegram, chatId, claim = () => ({ status: "unidentified" }) }) {
  if (!event || event.type !== "agent-turn-complete") return { status: "ignored" };
  if (typeof event["last-assistant-message"] !== "string") return { status: "ignored" };
  const claimed = await claim();
  if (claimed.status === "duplicate") return claimed;
  const result = notificationPresentation(event);
  const options = { disable_notification: result.quiet };
  const suffix = result.needsDetail ? "\n\n전체 원문은 이어지는 텍스트 파일에서 확인하세요." : "";
  await telegram.sendMessage(chatId, result.text + suffix, options);
  if (result.needsDetail) {
    try {
      await telegram.sendTextDocument(chatId, result.body, result.filename,
        { caption: `📂 전체 결과 · #${result.id} · 알림 전용`, disable_notification: true });
    } catch (error) {
      await telegram.sendMessage(chatId,
        `⚠️ #${result.id} 전체 결과 파일을 전달하지 못했습니다. PC의 원래 Codex 대화에서 확인하세요.`,
        { disable_notification: true }).catch(() => {});
      throw error;
    }
  }
  return { status: "delivered", id: result.id, detail: result.needsDetail };
}
