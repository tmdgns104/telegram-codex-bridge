import test from "node:test";
import assert from "node:assert/strict";
import { TelegramClient } from "../src/telegram-client.mjs";

const response = (status, payload) => new Response(JSON.stringify(payload), { status });

test("429 respects retry_after and retries only when requested", async () => {
  const delays = [];
  const bodies = [];
  const client = new TelegramClient("synthetic", {
    sleepImpl: async (ms) => { delays.push(ms); },
    fetchImpl: async (url, init) => {
      bodies.push(JSON.parse(init.body));
      return bodies.length === 1 ? response(429, { ok: false, parameters: { retry_after: 2 } })
        : response(200, { ok: true, result: { message_id: 7 } });
    },
  });
  assert.equal((await client.sendMessage("123", "질문", { retry: true })).message_id, 7);
  assert.deepEqual(delays, [2000]);
  assert.ok(bodies.every((body) => !Object.hasOwn(body, "retry")));
});

test("temporary failures have a bounded retry count and redact token-bearing errors", async () => {
  let attempts = 0;
  const client = new TelegramClient("synthetic", {
    sleepImpl: async () => {},
    fetchImpl: async () => { attempts += 1; throw new Error("https://api.telegram.org/botSYNTHETIC_SECRET/sendMessage"); },
  });
  await assert.rejects(client.sendMessage("123", "승인", { retry: true }), (error) => !error.message.includes("SYNTHETIC_SECRET"));
  assert.equal(attempts, 3);
});

test("permanent errors and excessive retry delays return promptly", async () => {
  for (const [code, retryAfter] of [[400, 0], [429, 120]]) {
    let attempts = 0;
    const client = new TelegramClient("synthetic", {
      sleepImpl: async () => assert.fail("must not wait"),
      fetchImpl: async () => { attempts += 1; return response(code, { ok: false, parameters: { retry_after: retryAfter } }); },
    });
    await assert.rejects(client.sendMessage("123", "승인", { retry: true }));
    assert.equal(attempts, 1);
  }
});

function hangingFetch(url, { signal }) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error("aborted"));
    signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
}

test("request timeout aborts fetch", async () => {
  const client = new TelegramClient("synthetic", { requestTimeoutMs: 10, fetchImpl: hangingFetch });
  await assert.rejects(client.sendMessage("123", "상태"));
});

test("stop aborts long polling instead of waiting for the Telegram timeout", async () => {
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  const client = new TelegramClient("synthetic", {
    fetchImpl: (...args) => { started(); return hangingFetch(...args); },
  });
  const polling = client.poll(() => assert.fail("no update expected"), 30);
  await ready;
  client.stop();
  await polling;
});

test("generated text documents use multipart with exact Unicode and no JSON content-type", async () => {
  const source = "한글 😀\r\n:codex-file-citation{path=\"C:/synthetic/file.txt\"}";
  let calls = 0;
  const client = new TelegramClient("synthetic", { fetchImpl: async (url, init) => {
    calls++;
    assert.match(url, /\/sendDocument$/);
    assert.equal(init.headers, undefined);
    assert.ok(init.body instanceof FormData);
    assert.equal(await init.body.get("document").text(), source);
    assert.equal(init.body.get("document").name, "result.txt");
    assert.equal(init.body.get("chat_id"), "123");
    assert.equal(init.body.get("disable_notification"), "true");
    return response(200, { ok: true, result: { message_id: 8 } });
  } });
  assert.equal((await client.sendTextDocument("123", source, "result.txt", { disable_notification: true })).message_id, 8);
  assert.equal(calls, 1);
});
