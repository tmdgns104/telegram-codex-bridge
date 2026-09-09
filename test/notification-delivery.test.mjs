import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { claimNotification, deliverNotification } from "../src/notification-delivery.mjs";

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "notify-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const event = { type: "agent-turn-complete", cwd: "C:/synthetic/project-a", "thread-id": "thread-a",
    "turn-id": "turn-a", "last-assistant-message": "원래 결과" };
  const options = { directory, token: "synthetic-token", chatId: "123", event };
  const messages = [], documents = [];
  const telegram = {
    async sendMessage(chatId, text, options) { messages.push({ chatId, text, options }); },
    async sendTextDocument(chatId, text, filename, options) { documents.push({ chatId, text, filename, options }); },
  };
  return { ...options, options, telegram, messages, documents };
}

test("same event is claimed once while different projects, turns, bots, and chats remain distinct", async (t) => {
  const f = fixture(t);
  assert.equal((await claimNotification(f.options)).status, "claimed");
  assert.equal((await claimNotification(f.options)).status, "duplicate");
  for (const options of [
    { ...f.options, token: "another-synthetic" }, { ...f.options, chatId: "456" },
    { ...f.options, event: { ...f.event, cwd: "C:/synthetic/project-b" } },
    { ...f.options, event: { ...f.event, "turn-id": "turn-b" } },
  ]) assert.equal((await claimNotification(options)).status, "claimed");
  for (const file of fs.readdirSync(f.directory)) {
    const value = JSON.parse(fs.readFileSync(path.join(f.directory, file), "utf8"));
    assert.deepEqual(Object.keys(value), ["attemptedAt"]);
  }
});

test("missing IDs are not deduplicated by text and expired receipts allow a new attempt", async (t) => {
  const f = fixture(t);
  const unknown = { ...f.options, event: { ...f.event, "turn-id": undefined } };
  assert.equal((await claimNotification(unknown)).status, "unidentified");
  assert.equal(fs.readdirSync(f.directory).length, 0);
  await claimNotification(f.options);
  const marker = path.join(f.directory, fs.readdirSync(f.directory)[0]);
  fs.utimesSync(marker, new Date(0), new Date(0));
  assert.equal((await claimNotification(f.options)).status, "claimed");
});

test("notification retention is bounded while new alerts continue at capacity", async (t) => {
  const f = fixture(t);
  for (let i = 0; i < 1000; i++) fs.writeFileSync(path.join(f.directory, `${i.toString(16).padStart(64, "0")}.json`), "{}");
  assert.equal((await claimNotification(f.options)).status, "claimed");
  assert.equal((await claimNotification(f.options)).status, "duplicate");
  assert.equal(fs.readdirSync(f.directory).length, 1000);
});

test("long output and JSON originals are delivered as exact generated text documents", async (t) => {
  const f = fixture(t);
  for (const body of ["한글 😀\r\n".repeat(500), '{"title":"정상 JSON 요청의 결과"}']) {
    await deliverNotification({ ...f, event: { ...f.event, "last-assistant-message": body } });
    assert.equal(f.documents.at(-1).text, body);
    assert.match(f.documents.at(-1).filename, /^codex-[a-f0-9]{10}\.txt$/);
    assert.equal(f.documents.at(-1).options.disable_notification, true);
  }
  assert.equal(f.messages.at(-1).options.disable_notification, true);
});

test("document failure is reported, and uncertain sends are not replayed", async (t) => {
  const f = fixture(t);
  f.event["last-assistant-message"] = "long text\n".repeat(400);
  f.telegram.sendTextDocument = async () => { throw new Error("synthetic failure"); };
  const options = { ...f, claim: () => claimNotification(f.options) };
  await assert.rejects(deliverNotification(options));
  assert.match(f.messages.at(-1).text, /전달하지 못했습니다/);
  const count = f.messages.length;
  assert.equal((await deliverNotification(options)).status, "duplicate");
  assert.equal(f.messages.length, count);
});

test("unsupported and malformed events do not claim or send anything", async (t) => {
  const f = fixture(t);
  for (const event of [null, {}, { ...f.event, type: "other" }, { ...f.event, "last-assistant-message": {} }]) {
    assert.equal((await deliverNotification({ ...f, event, claim: () => assert.fail("no claim") })).status, "ignored");
  }
  assert.equal(f.messages.length, 0);
});
