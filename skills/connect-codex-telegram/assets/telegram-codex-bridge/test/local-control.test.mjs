import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import {
  deriveLocalControlKey,
  deriveLocalControlPort,
  LocalControlServer,
  sendLocalPrompt,
  submitLocalTask,
  getLocalTask,
} from "../src/local-control.mjs";

function sendRawRequest(port, request) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let response = "";
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk) => { response += chunk; });
    socket.once("error", reject);
    socket.once("end", () => resolve(JSON.parse(response.trim())));
  });
}

test("local control address and key are deterministic per bot and chat", () => {
  assert.equal(
    deriveLocalControlPort("123:token", "456"),
    deriveLocalControlPort("123:token", "456"),
  );
  assert.equal(
    deriveLocalControlKey("123:token", "456"),
    deriveLocalControlKey("123:token", "456"),
  );
  assert.notEqual(
    deriveLocalControlKey("123:token", "456"),
    deriveLocalControlKey("789:other", "456"),
  );
});

test("receipt returns before Codex answers and duplicate IDs execute once", async (t) => {
  let finish;
  let calls = 0;
  const connection = { token: "123:token", chatId: "456" };
  const server = new LocalControlServer({ ...connection, port: 0,
    onPrompt: async () => { calls += 1; await new Promise((resolve) => { finish = resolve; }); return { mode: "started" }; },
  });
  connection.port = (await server.start()).port;
  t.after(() => server.close());
  const requestId = "same-request-123";
  const first = await submitLocalTask({ ...connection, requestId, text: "test" });
  const second = await submitLocalTask({ ...connection, requestId, text: "test" });
  assert.equal(first.status, "received");
  assert.equal(second.status, "received");
  assert.equal(calls, 1);
  await assert.rejects(submitLocalTask({ ...connection, requestId, text: "different" }), /다른 작업/);
  finish();
  await new Promise((resolve) => setImmediate(resolve));
  const status = await getLocalTask(connection);
  assert.equal(status.requestId, requestId);
  assert.equal(status.status, "accepted");
  assert.equal(status.mode, "started");
  assert.ok(!Object.hasOwn(status, "fingerprint"));
  assert.ok(!Object.hasOwn(server.receipts.get(requestId), "text"));
});

test("old-instance submissions and unknown receipt IDs never start a task", async (t) => {
  let calls = 0;
  const connection = { token: "123:token", chatId: "456" };
  const server = new LocalControlServer({ ...connection, port: 0, onPrompt: async () => { calls += 1; } });
  connection.port = (await server.start()).port;
  t.after(() => server.close());
  const result = await sendRawRequest(connection.port, {
    key: deriveLocalControlKey(connection.token, connection.chatId), action: "submit", text: "test",
    requestId: "old-request-123", instanceId: "previous-instance",
  });
  assert.equal(result.code, "STALE_INSTANCE");
  assert.equal((await getLocalTask({ ...connection, requestId: "old-request-123" })).status, "not_found");
  assert.equal(calls, 0);
});

test("receipt distinguishes explicit rejection from uncertain acceptance", async (t) => {
  for (const outcome of ["rejected", "unknown"]) {
    const connection = { token: "123:token", chatId: "456" };
    const server = new LocalControlServer({ ...connection, port: 0,
      onPrompt: async () => { const error = new Error("synthetic"); error.outcome = outcome; throw error; },
    });
    connection.port = (await server.start()).port;
    t.after(() => server.close());
    const receipt = await submitLocalTask({ ...connection, text: "test" });
    const status = await getLocalTask({ ...connection, requestId: receipt.requestId });
    assert.equal(status.status, outcome);
  }
});

test("receipt capacity never evicts an ID or replays it as a new task", async (t) => {
  let calls = 0;
  const connection = { token: "123:token", chatId: "456" };
  const server = new LocalControlServer({ ...connection, port: 0, maxReceipts: 1,
    onPrompt: async () => { calls += 1; return {}; },
  });
  connection.port = (await server.start()).port;
  t.after(() => server.close());
  await submitLocalTask({ ...connection, requestId: "first-task-id", text: "test" });
  await assert.rejects(submitLocalTask({ ...connection, requestId: "second-task-id", text: "test" }), /한도/);
  await submitLocalTask({ ...connection, requestId: "first-task-id", text: "test" });
  assert.equal(calls, 1);
});

test("new endpoints require authentication and malformed JSON values do not crash", async (t) => {
  const server = new LocalControlServer({ token: "123:token", chatId: "456", port: 0,
    onPrompt: async () => assert.fail("unauthorized"),
  });
  const { port } = await server.start();
  t.after(() => server.close());
  for (const request of [null, { action: "hello" }, { action: "status" }, { action: "submit", text: "test" }]) {
    assert.equal((await sendRawRequest(port, request)).ok, false);
  }
});

test("lost submit response retries the identical instance and request ID", async (t) => {
  const submits = [];
  const server = net.createServer((socket) => {
    socket.once("data", (data) => {
      const request = JSON.parse(String(data));
      if (request.action === "hello") socket.end(JSON.stringify({ ok: true, instanceId: "instance-before" }) + "\n");
      else {
        submits.push(request);
        if (submits.length === 1) socket.end();
        else socket.end(JSON.stringify({ ok: true, requestId: request.requestId, status: "received" }) + "\n");
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const result = await submitLocalTask({ token: "synthetic", chatId: "123", port: server.address().port, text: "test" });
  assert.equal(result.status, "received");
  assert.equal(submits.length, 2);
  assert.deepEqual(submits[0], submits[1]);
});

test("PC prompt is authenticated and forwarded to the bridge handler", async (t) => {
  const prompts = [];
  const server = new LocalControlServer({
    token: "123:token",
    chatId: "456",
    port: 0,
    onPrompt: async (text) => {
      prompts.push(text);
      return { mode: "started", message: "sent" };
    },
    logger: { error() {} },
  });
  const { port } = await server.start();
  t.after(() => server.close());

  const result = await sendLocalPrompt({
    token: "123:token",
    chatId: "456",
    port,
    text: "run the tests",
  });

  assert.deepEqual(prompts, ["run the tests"]);
  assert.equal(result.mode, "started");
  assert.equal(result.message, "sent");
});

test("local control rejects requests without the derived key", async (t) => {
  const prompts = [];
  const server = new LocalControlServer({
    token: "123:token",
    chatId: "456",
    port: 0,
    onPrompt: async (text) => { prompts.push(text); },
    logger: { error() {} },
  });
  const { port } = await server.start();
  t.after(() => server.close());

  const result = await sendRawRequest(port, {
    action: "prompt",
    key: "wrong-key",
    text: "do not run",
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /Unauthorized/);
  assert.deepEqual(prompts, []);
});
