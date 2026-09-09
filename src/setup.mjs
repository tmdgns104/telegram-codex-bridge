import fs from "node:fs";
import path from "node:path";
import { TelegramClient } from "./telegram-client.mjs";

export async function discoverPersonalChats(token) {
  const telegram = new TelegramClient(token, { requestTimeoutMs: 5000 });
  try {
    const updates = await telegram.call("getUpdates", { timeout: 0 });
    const chats = new Map();
    for (const update of updates) {
      const chat = update.message?.chat;
      if (chat?.type === "private") chats.set(String(chat.id), chat);
    }
    return [...chats.keys()];
  } finally { telegram.stop(); }
}

export function envFileValues(file) {
  const values = {};
  if (!fs.existsSync(file)) return values;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.trim().match(/^([A-Z_][A-Z_0-9]*)=(.*)$/);
    if (match) values[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
  return values;
}

export function writeSettings(file, values) {
  if (Object.values(values).some((v) => /[\r\n\0]/.test(v))) throw new Error("설정 값에 줄바꿈을 넣을 수 없습니다.");
  const lines = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split(/\r?\n/) : [];
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak-${Date.now()}`);
  for (const [key, value] of Object.entries(values)) {
    const index = lines.findIndex((line) => line.startsWith(`${key}=`));
    if (index < 0) lines.push(`${key}=${value}`);
    else lines[index] = `${key}=${value}`;
  }
  fs.writeFileSync(file, lines.join("\n").trim() + "\n", { mode: 0o600 });
}

export function installPermissionHook({ codexHome, bridgeRoot }) {
  const file = path.join(codexHome, "hooks.json");
  const script = path.join(bridgeRoot, "scripts/permission-hook.mjs");
  if (!fs.existsSync(script) || /["\r\n`$]/.test(script)) throw new Error("승인 hook 스크립트 경로를 확인하세요.");
  const value = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")) : {};
  if (!value || typeof value !== "object" || Array.isArray(value) || (value.hooks && (typeof value.hooks !== "object" || Array.isArray(value.hooks)))) throw new Error("기존 hooks.json 형식을 확인하세요.");
  value.hooks ||= {};
  const groups = value.hooks.PermissionRequest || [];
  if (!Array.isArray(groups)) throw new Error("기존 PermissionRequest 설정을 확인하세요.");
  const command = `node "${script.replaceAll("\\", "/")}"`;
  if (groups.some((group) => group.hooks?.some((hook) => hook.command === command))) return { changed: false, file };
  groups.push({ hooks: [{ type: "command", command, timeout: 310, statusMessage: "Telegram에서 승인 응답을 기다립니다 (최대 5분)." }] });
  value.hooks.PermissionRequest = groups;
  fs.mkdirSync(codexHome, { recursive: true });
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak-${Date.now()}`);
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  return { changed: true, file };
}
