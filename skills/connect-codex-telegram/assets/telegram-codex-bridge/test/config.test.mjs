import test from "node:test";
import assert from "node:assert/strict";
import { readConfig } from "../src/config.mjs";

test("안전하지 않은 danger-full-access를 거부한다", () => {
  assert.throws(() => readConfig({
    TELEGRAM_BOT_TOKEN: "token",
    ALLOWED_CHAT_ID: "123",
    CODEX_WORKDIR: process.cwd(),
    CODEX_SANDBOX: "danger-full-access",
  }), /read-only 또는 workspace-write/);
});

test("기본 설정은 workspace-write와 on-request다", () => {
  const config = readConfig({
    TELEGRAM_BOT_TOKEN: "token",
    ALLOWED_CHAT_ID: "123",
    CODEX_WORKDIR: process.cwd(),
  });
  assert.equal(config.sandbox, "workspace-write");
  assert.equal(config.approvalPolicy, "on-request");
});

