import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import os from "node:os";
import { LocalControlServer } from "../src/local-control.mjs";

const execute = promisify(execFile);
const script = fileURLToPath(new URL("../scripts/codex-tg.mjs", import.meta.url));

test("CLI help needs no bot configuration and explains recovery commands", async () => {
  const result = await execute(process.execPath, [script, "--help"], { cwd: os.tmpdir(), windowsHide: true });
  assert.match(result.stdout, /--status/);
  assert.match(result.stdout, /\/pending/);
  assert.match(result.stdout, /\/reconnect/);
});

test("CLI submission shows a receipt and status checks it without sending a second task", async (t) => {
  const token = `synthetic-${crypto.randomUUID()}`;
  let calls = 0;
  const server = new LocalControlServer({ token, chatId: "123", onPrompt: async () => {
    calls += 1;
    return { mode: "started", message: "Codex에 전달했습니다." };
  } });
  await server.start();
  t.after(() => server.close());
  const options = { cwd: os.tmpdir(), windowsHide: true, env: { ...process.env,
    TELEGRAM_BOT_TOKEN: token, ALLOWED_CHAT_ID: "123", CODEX_WORKDIR: os.tmpdir(),
    CODEX_SANDBOX: "read-only", CODEX_APPROVAL_POLICY: "on-request",
  } };
  const sent = await execute(process.execPath, [script, "synthetic task"], options);
  const id = sent.stdout.match(/접수 번호: ([a-zA-Z0-9-]+)/)?.[1];
  assert.ok(id);
  assert.match(sent.stdout, /Codex 접수 확인 중/);
  const status = await execute(process.execPath, [script, "--status", id], options);
  assert.match(status.stdout, /Codex에 전달했습니다/);
  assert.equal(calls, 1);
  assert.ok(!sent.stdout.includes(token));
});
