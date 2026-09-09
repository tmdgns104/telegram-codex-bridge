import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import {
  deriveLocalControlKey,
  deriveLocalControlPort,
  LocalControlServer,
  sendLocalPrompt,
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
