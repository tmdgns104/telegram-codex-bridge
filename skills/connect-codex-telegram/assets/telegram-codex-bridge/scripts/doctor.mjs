import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { loadDotEnv, readConfig } from "../src/config.mjs";
import { TelegramClient } from "../src/telegram-client.mjs";
import { sendLocalRequest } from "../src/local-control.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);
loadDotEnv(path.join(root, ".env"));
const checks = [];
const add = (name, status, detail) => checks.push({ name, status, detail });
let config;
try { config = readConfig(); add("브리지 설정", "PASS", "토큰·채팅·경로·승인 정책 확인 (값 비공개)"); }
catch (error) { add("브리지 설정", "FAIL", error.message); }
function command(args) {
  const bin = config?.codexBin || (process.platform === "win32" ? "codex.cmd" : "codex");
  if (process.platform === "win32" && /[\s&|<>^%"]/.test(bin)) return { status: 1 };
  return spawnSync(process.platform === "win32" ? "cmd.exe" : bin, process.platform === "win32" ? ["/d", "/s", "/c", `${bin} ${args.join(" ")}`] : args,
    { encoding: "utf8", timeout: 10_000, windowsHide: true });
}
add("Node", Number(process.versions.node.split(".")[0]) >= 20 ? "PASS" : "FAIL", process.version);
const version = command(["--version"]);
add("Codex", version.status === 0 ? "PASS" : "FAIL", version.status === 0 ? version.stdout.trim() : "Codex 설치와 PATH를 확인하세요.");
const auth = command(["login", "status"]);
add("Codex 로그인", auth.status === 0 ? "PASS" : "FAIL", auth.status === 0 ? "로그인 상태 확인" : "PC에서 codex login을 실행하세요.");
const hookFile = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "hooks.json");
let hookFound = false;
try {
  const settings = JSON.parse(fs.readFileSync(hookFile, "utf8").replace(/^\uFEFF/, ""));
  const expected = `node "${path.join(root, "scripts/permission-hook.mjs").replaceAll("\\", "/")}"`;
  hookFound = settings.hooks?.PermissionRequest?.some((group) => group.hooks?.some((hook) => hook.command === expected && hook.async !== true));
} catch {}
add("PC 승인 hook", hookFound ? "PASS" : "ACTION", hookFound ? "정의 설치됨. 신뢰 상태는 Codex /hooks에서 확인하세요." : "npm run setup -- --install-hook --non-interactive 후 Codex /hooks에서 신뢰하세요.");
if (config) {
  try {
    const hello = await sendLocalRequest({ token: config.telegramToken, chatId: config.allowedChatId, timeoutMs: 1500, request: { action: "hello" } });
    add("실행 중 브리지", hello.nativeApprovals ? "PASS" : "ACTION", hello.nativeApprovals ? `버전 ${hello.version} · PC 승인 지원` : "이전 브리지입니다. 현재 작업 종료 후 재시작하세요.");
  } catch { add("실행 중 브리지", "ACTION", "start.cmd로 실행하세요."); }
  if (!process.argv.includes("--offline")) {
    const telegram = new TelegramClient(config.telegramToken, { requestTimeoutMs: 5000 });
    try { await telegram.call("getMe"); await telegram.call("getChat", { chat_id: config.allowedChatId }); add("Telegram 연결", "PASS", "봇 인증·채팅 조회 성공 (메시지 전송 없음)"); }
    catch { add("Telegram 연결", "FAIL", "봇 토큰·개인 chat ID·인터넷 연결을 확인하세요."); }
    finally { telegram.stop(); }
  }
}
if (process.argv.includes("--json")) console.log(JSON.stringify(checks, null, 2));
else for (const check of checks) console.log(`${check.status} · ${check.name}: ${check.detail}`);
process.exitCode = checks.some((check) => check.status === "FAIL") ? 1 : 0;
