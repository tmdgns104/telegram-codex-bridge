import test from "node:test";
import assert from "node:assert/strict";
import { acquireSingleton, deriveSingletonPort } from "../src/singleton.mjs";

test("같은 봇 설정은 동일한 singleton 포트를 만든다", () => {
  assert.equal(
    deriveSingletonPort("123:token", "456"),
    deriveSingletonPort("123:token", "456"),
  );
  assert.notEqual(
    deriveSingletonPort("123:token", "456"),
    deriveSingletonPort("789:other", "456"),
  );
});

test("두 번째 브리지 잠금을 거부하고 종료 후 다시 허용한다", async () => {
  const first = await acquireSingleton({ port: 0 });
  await assert.rejects(
    acquireSingleton({ port: first.port }),
    (error) => error.code === "BRIDGE_ALREADY_RUNNING",
  );
  await first.close();
  const replacement = await acquireSingleton({ port: first.port });
  await replacement.close();
});
