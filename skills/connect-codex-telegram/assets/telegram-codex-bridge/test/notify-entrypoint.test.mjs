import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (data) => { stdout += data; });
    child.stderr.on("data", (data) => { stderr += data; });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "notify-entrypoint-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const relative of ["src/config.mjs", "src/telegram-client.mjs", "src/result-presentation.mjs",
    "src/notification-delivery.mjs", "src/singleton.mjs", "scripts/notify.mjs", "scripts/codex-telegram-notify.py"]) {
    const destination = path.join(directory, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(root, relative), destination);
  }
  const output = path.join(directory, "http.jsonl");
  const preload = path.join(directory, "mock-fetch.mjs");
  fs.writeFileSync(preload, `
    import fs from "node:fs";
    globalThis.fetch = async (url, init) => {
      if (!url.startsWith("https://api.telegram.org/botsynthetic-token/")) throw new Error("unexpected destination");
      const method = url.split("/").at(-1);
      let body;
      if (init.body instanceof FormData) {
        body = Object.fromEntries(init.body);
        body.document = await init.body.get("document").text();
      } else body = JSON.parse(init.body);
      fs.appendFileSync(process.env.SYNTHETIC_NOTIFY_HTTP, JSON.stringify({method,body}) + "\\n");
      return new Response(JSON.stringify({ok:true,result:{message_id:1}}), {status:200});
    };
  `);
  const env = { ...process.env, TELEGRAM_BOT_TOKEN: "synthetic-token", ALLOWED_CHAT_ID: "123",
    TELEGRAM_CODEX_BRIDGE_CHILD: "", NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
    SYNTHETIC_NOTIFY_HTTP: output };
  const event = { type: "agent-turn-complete", "thread-id": "synthetic-thread", "turn-id": "synthetic-turn",
    cwd: "C:/synthetic/project-a", "last-assistant-message": "한글 😀 결과\r\n".repeat(400) + "끝: 사용자 검토 필요" };
  const invoke = (payload = event, overrides = {}) => run(process.env.PYTHON || "python",
    [path.join(directory, "scripts/codex-telegram-notify.py"), JSON.stringify(payload)],
    { cwd: directory, env: { ...env, ...overrides } });
  const requests = () => fs.existsSync(output) ? fs.readFileSync(output, "utf8").trim().split("\n").map(JSON.parse) : [];
  return { directory, event, invoke, requests };
}

test("legacy Python argv reaches Node formatting and multipart delivery with exact Unicode", async (t) => {
  const f = fixture(t);
  const result = await f.invoke();
  assert.equal(result.code, 0, result.stderr);
  const requests = f.requests();
  assert.deepEqual(requests.map((r) => r.method), ["sendMessage", "sendDocument"]);
  assert.ok(requests[0].body.text.length < 1600);
  assert.match(requests[0].body.text, /PC 응답 도착/);
  assert.equal(requests[1].body.document, f.event["last-assistant-message"]);
  assert.equal((await f.invoke()).code, 0);
  assert.equal(f.requests().length, 2);
});

test("concurrent legacy hook processes attempt one delivery for the same event", async (t) => {
  const f = fixture(t);
  const results = await Promise.all(Array.from({ length: 4 }, () => f.invoke()));
  assert.ok(results.every((r) => r.code === 0));
  assert.deepEqual(f.requests().map((r) => r.method), ["sendMessage", "sendDocument"]);
  const receipts = fs.readdirSync(path.join(f.directory, ".notify-dedup"));
  assert.equal(receipts.length, 1);
});

test("bridge child events do not double-notify and malformed input never reaches HTTP", async (t) => {
  const f = fixture(t);
  assert.equal((await f.invoke(f.event, { TELEGRAM_CODEX_BRIDGE_CHILD: "1" })).code, 0);
  assert.equal((await f.invoke(null)).code, 0);
  assert.equal(f.requests().length, 0);
});
