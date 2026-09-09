import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { AppServerClient } from "../src/app-server-client.mjs";

function fixture() {
  const children = [];
  const requests = [];
  const client = new AppServerClient({
    requestTimeoutMs: 25,
    logger: { error() {} },
    spawnImpl() {
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      });
      child.stdin.on("data", (data) => {
        const request = JSON.parse(String(data));
        requests.push(request);
        if (request.method === "initialize") child.stdout.write(JSON.stringify({ id: request.id, result: {} }) + "\n");
      });
      children.push(child);
      return child;
    },
    terminateImpl: async (child) => {
      child.stdin.end(); child.stdout.end(); child.stderr.end(); child.emit("close");
    },
  });
  return { client, children, requests };
}

test("synchronous initialize response is not lost before pending registration", async (t) => {
  const { client, requests } = fixture();
  t.after(() => client.close());
  await client.start();
  assert.equal(requests.at(-1).method, "initialized");
  assert.equal(client.pending.size, 0);
});

for (const exit of [0, 1, null]) {
  test(`exit ${exit} rejects pending requests, reports disconnection once and allows fresh connection`, async (t) => {
    const { client, children } = fixture();
    t.after(() => client.close());
    await client.start();
    let failures = 0;
    client.on("fatal", () => { failures += 1; });
    const request = client.request("turn/start", { input: [] });
    const rejected = assert.rejects(request, (error) => error.outcome === "unknown");
    children[0].emit("exit", exit, exit === null ? "SIGTERM" : null);
    children[0].emit("error", new Error("closed"));
    await rejected;
    assert.equal(failures, 1);
    assert.equal(client.pending.size, 0);
    await assert.rejects(client.request("turn/start"), (error) => error.outcome === "rejected");
    await client.close();
    await client.start();
    assert.equal(children.length, 2);
  });
}

test("timeout releases RPC state, marks unknown and ignores a late response", async (t) => {
  const { client, children, requests } = fixture();
  t.after(() => client.close());
  await client.start();
  await assert.rejects(client.request("turn/start"), (error) => error.code === "REQUEST_TIMEOUT" && error.outcome === "unknown");
  children[0].stdout.write(JSON.stringify({ id: requests.at(-1).id, result: { turn: { id: "late" } } }) + "\n");
  assert.equal(client.pending.size, 0);
  assert.equal(requests.filter(({ method }) => method === "turn/start").length, 1);
});

test("explicit close settles pending RPCs and never replays them", async () => {
  const { client, requests } = fixture();
  await client.start();
  const rejected = assert.rejects(client.request("turn/start"), (error) => error.outcome === "unknown");
  await client.close();
  await rejected;
  assert.equal(client.pending.size, 0);
  assert.equal(requests.filter(({ method }) => method === "turn/start").length, 1);
});
