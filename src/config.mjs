import fs from "node:fs";
import path from "node:path";

export function loadDotEnv(filePath = path.resolve(".env")) {
  if (!fs.existsSync(filePath)) return;

  const text = fs.readFileSync(filePath, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

export function readConfig(env = process.env, { requireTelegram = true } = {}) {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  const chatIdText = env.ALLOWED_CHAT_ID?.trim();
  const workdirText = env.CODEX_WORKDIR?.trim();
  const sandbox = env.CODEX_SANDBOX?.trim() || "workspace-write";
  const approvalPolicy = env.CODEX_APPROVAL_POLICY?.trim() || "on-request";

  if (requireTelegram && !token) throw new Error("TELEGRAM_BOT_TOKEN이 필요합니다.");
  if (requireTelegram && !/^-?\d+$/.test(chatIdText || "")) {
    throw new Error("ALLOWED_CHAT_ID는 숫자 Telegram chat_id여야 합니다.");
  }
  if (!workdirText) throw new Error("CODEX_WORKDIR가 필요합니다.");

  const workdir = path.resolve(workdirText);
  if (!fs.existsSync(workdir) || !fs.statSync(workdir).isDirectory()) {
    throw new Error(`CODEX_WORKDIR 디렉터리를 찾을 수 없습니다: ${workdir}`);
  }
  if (!new Set(["read-only", "workspace-write"]).has(sandbox)) {
    throw new Error("CODEX_SANDBOX는 read-only 또는 workspace-write만 허용됩니다.");
  }
  if (!new Set(["untrusted", "on-request"]).has(approvalPolicy)) {
    throw new Error("CODEX_APPROVAL_POLICY는 untrusted 또는 on-request만 허용됩니다.");
  }

  const pollTimeout = Number(env.TELEGRAM_POLL_TIMEOUT_SECONDS || 30);
  if (!Number.isInteger(pollTimeout) || pollTimeout < 1 || pollTimeout > 50) {
    throw new Error("TELEGRAM_POLL_TIMEOUT_SECONDS는 1~50 사이 정수여야 합니다.");
  }

  return {
    telegramToken: token,
    allowedChatId: chatIdText,
    workdir,
    codexBin: env.CODEX_BIN?.trim() || (process.platform === "win32" ? "codex.cmd" : "codex"),
    sandbox,
    approvalPolicy,
    pollTimeout,
    statePath: path.resolve(".state.json"),
    dataPath: path.resolve(".bridge-data"),
  };
}
