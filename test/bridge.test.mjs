import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { BRIDGE_DEVELOPER_INSTRUCTIONS, CodexTelegramBridge } from "../src/bridge.mjs";

class FakeAppServer extends EventEmitter {
  constructor() {
    super();
    this.requests = [];
    this.responses = [];
  }
  async start() {}
  async close() {}
  async request(method, params) {
    this.requests.push({ method, params });
    if (method === "thread/start") return { thread: { id: "thread-1" } };
    if (method === "thread/resume") return { thread: { id: params.threadId } };
    if (method === "turn/start") return { turn: { id: "turn-1" } };
    if (method === "thread/turns/list") return { data: [] };
    return {};
  }
  respond(id, result) { this.responses.push({ id, result }); }
  respondError(id, code, message) { this.responses.push({ id, error: { code, message } }); }
}

class FakeTelegram {
  constructor() {
    this.messages = [];
    this.callbacks = [];
    this.removedKeyboards = [];
  }
  async sendMessage(chatId, text, options = {}) {
    const message = { chatId: String(chatId), text, options, message_id: this.messages.length + 1 };
    this.messages.push(message);
    return message;
  }
  async answerCallbackQuery(id, text) { this.callbacks.push({ id, text }); }
  async removeKeyboard(chatId, messageId) { this.removedKeyboards.push(messageId); }
}

function makeBridge(options = {}) {
  const appServer = new FakeAppServer();
  const telegram = new FakeTelegram();
  const statePath = path.join(os.tmpdir(), `telegram-codex-test-${process.pid}-${Math.random()}.json`);
  const bridge = new CodexTelegramBridge({
    appServer,
    telegram,
    config: {
      allowedChatId: "123",
      workdir: process.cwd(),
      sandbox: "workspace-write",
      approvalPolicy: "on-request",
      statePath,
    },
    logger: { error() {} },
    ...options,
  });
  return { appServer, telegram, bridge, statePath };
}

test("허용된 Telegram 메시지로 turn을 시작하고 완료 결과를 보낸다", async (t) => {
  const { appServer, telegram, bridge, statePath } = makeBridge();
  t.after(() => fs.rmSync(statePath, { force: true }));
  await bridge.start();
  await bridge.handleUpdate({ message: { chat: { id: 123 }, text: "테스트를 고쳐줘" } });
  assert.equal(appServer.requests.at(-1).method, "turn/start");
  assert.match(telegram.messages.at(-1).text, /Codex 작업 경로:/);

  appServer.emit("notification", {
    method: "turn/completed",
    params: {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed", items: [{ type: "agentMessage", text: "수정 완료" }] },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(telegram.messages.at(-1).text, /수정 완료/);
});

const tick = () => new Promise((resolve) => setImmediate(resolve));
const message = (text) => ({ message: { chat: { id: 123 }, text } });

async function startFixture(t, options = {}) {
  const fixture = makeBridge(options);
  t.after(() => fs.rmSync(fixture.statePath, { force: true }));
  await fixture.bridge.start();
  return fixture;
}

function complete(appServer, { id = "turn-1", status = "completed", text = "수정 완료" } = {}) {
  appServer.emit("notification", {
    method: "turn/completed",
    params: { threadId: "thread-1", turn: {
      id, status, items: [{ type: "agentMessage", text }],
      ...(status === "failed" ? { error: { message: "테스트 실행 실패" } } : {}),
    } },
  });
}

test("status에 경과 시간과 현재 활동을 표시하고 오래된 turn 이벤트는 무시한다", async (t) => {
  let now = 1_000;
  const { appServer, telegram, bridge } = await startFixture(t, { now: () => now });
  await bridge.handleUpdate(message("테스트해줘"));
  now += 65_000;
  appServer.emit("notification", { method: "item/started", params: {
    threadId: "thread-1", turnId: "turn-1", item: { id: "cmd-1", type: "commandExecution" },
  } });
  appServer.emit("notification", { method: "item/started", params: {
    threadId: "thread-1", turnId: "old-turn", item: { id: "old", type: "fileChange" },
  } });
  appServer.emit("notification", { method: "turn/started", params: {
    threadId: "thread-1", turn: { id: "old-turn" },
  } });
  complete(appServer, { id: "old-turn" });
  await bridge.handleUpdate(message("/status@my_bot"));
  assert.match(telegram.messages.at(-1).text, /1분 5초/);
  assert.match(telegram.messages.at(-1).text, /명령 실행 중/);
  assert.doesNotMatch(telegram.messages.at(-1).text, /파일 수정 중/);
  assert.equal(bridge.activeTurnId, "turn-1");
  appServer.emit("notification", { method: "item/completed", params: {
    threadId: "thread-1", turnId: "turn-1", item: { id: "cmd-1", type: "commandExecution" },
  } });
  await bridge.handleUpdate(message("/status"));
  assert.match(telegram.messages.at(-1).text, /Codex 응답 대기 중/);
});

test("status에 승인 대기를 표시하고 요청 해결 후 해제한다", async (t) => {
  const { appServer, telegram, bridge } = await startFixture(t);
  await bridge.handleUpdate(message("테스트해줘"));
  appServer.emit("request", { id: 80, method: "item/commandExecution/requestApproval", params: {
    threadId: "thread-1", turnId: "turn-1", command: "npm test",
  } });
  await tick();
  await bridge.handleUpdate(message("/status"));
  assert.match(telegram.messages.at(-1).text, /승인 대기 \(1건\)/);
  appServer.emit("notification", { method: "serverRequest/resolved", params: { requestId: 80, threadId: "thread-1" } });
  await tick();
  await bridge.handleUpdate(message("/status"));
  assert.doesNotMatch(telegram.messages.at(-1).text, /승인 대기/);
  assert.equal(telegram.removedKeyboards.length, 1);
});

for (const status of ["completed", "failed", "interrupted"]) {
  test(`last로 ${status} 결과를 다시 조회하고 결과 본문을 디스크에 저장하지 않는다`, async (t) => {
    let now = 0;
    const { appServer, telegram, bridge, statePath } = await startFixture(t, { now: () => now });
    await bridge.handleUpdate(message("/last"));
    assert.match(telegram.messages.at(-1).text, /아직 조회할 결과가 없습니다/);
    await bridge.handleUpdate(message("테스트해줘"));
    now = 3_661_000;
    complete(appServer, { status });
    await tick();
    const result = telegram.messages.at(-1).text;
    assert.match(result, /소요 시간: 1시간 1분/);
    assert.match(result, status === "failed" ? /테스트 실행 실패/ : /수정 완료/);
    await bridge.handleUpdate(message("/last"));
    assert.equal(telegram.messages.at(-1).text, result);
    await bridge.handleUpdate(message("/status"));
    assert.match(telegram.messages.at(-1).text, /대기 중[\s\S]*최근 작업/);
    assert.equal(bridge.activeTurnId, null);
    assert.deepEqual(JSON.parse(fs.readFileSync(statePath, "utf8")), { threadId: "thread-1" });
    const count = telegram.messages.length;
    complete(appServer, { status });
    complete(appServer, { id: "older-turn", text: "오래된 결과" });
    await tick();
    assert.equal(telegram.messages.length, count);
    await bridge.handleUpdate(message("/last"));
    assert.equal(telegram.messages.at(-1).text, result);
  });
}

test("PC와 Telegram의 동시 입력은 하나의 시작과 추가 지시로 처리한다", async (t) => {
  const { appServer, bridge } = await startFixture(t);
  const originalRequest = appServer.request.bind(appServer);
  let finishStart;
  appServer.request = async (method, params) => {
    const result = await originalRequest(method, params);
    if (method === "turn/start") await new Promise((resolve) => { finishStart = resolve; });
    return result;
  };
  const first = bridge.submitLocalPrompt("첫 작업");
  const second = bridge.handleUpdate(message("추가 지시"));
  const third = bridge.submitLocalPrompt("다른 추가 지시");
  await tick();
  assert.equal(appServer.requests.filter(({ method }) => method === "turn/start").length, 1);
  finishStart();
  const results = await Promise.all([first, second, third]);
  assert.equal(results[0].mode, "started");
  assert.equal(results[2].mode, "steered");
  assert.deepEqual(appServer.requests.filter(({ method }) => method.startsWith("turn/")).map(({ method }) => method),
    ["turn/start", "turn/steer", "turn/steer"]);
  assert.equal(appServer.requests.at(-1).params.expectedTurnId, "turn-1");
});

test("실패한 시작 요청 뒤에도 다음 입력을 처리한다", async (t) => {
  const { appServer, bridge } = await startFixture(t);
  const originalRequest = appServer.request.bind(appServer);
  let fail = true;
  appServer.request = async (method, params) => {
    if (method === "turn/start" && fail) { fail = false; throw new Error("시작 실패"); }
    return originalRequest(method, params);
  };
  const first = bridge.submitLocalPrompt("첫 작업");
  const failure = assert.rejects(first, /시작 실패/);
  const second = bridge.submitLocalPrompt("두 번째 작업");
  await failure;
  assert.equal((await second).mode, "started");
});

test("시작 응답 전 완료되어도 진행 중으로 되돌리지 않는다", async (t) => {
  const { appServer, telegram, bridge } = await startFixture(t);
  const originalRequest = appServer.request.bind(appServer);
  appServer.request = async (method, params) => {
    const result = await originalRequest(method, params);
    if (method === "turn/start") {
      appServer.emit("notification", { method: "turn/started", params: { threadId: "thread-1", turn: result.turn } });
      complete(appServer);
      await tick();
    }
    return result;
  };
  await bridge.submitLocalPrompt("빨리 끝나는 작업");
  assert.equal(bridge.activeTurnId, null);
  await bridge.handleUpdate(message("/status"));
  assert.match(telegram.messages.at(-1).text, /대기 중/);
  assert.equal(telegram.messages.filter(({ text }) => text.includes("작업을 시작했습니다")).length, 0);
});

test("작업 시작 중 status는 응답하고 cancel은 시작 응답 뒤 실행한다", async (t) => {
  const { appServer, telegram, bridge } = await startFixture(t);
  const originalRequest = appServer.request.bind(appServer);
  let finishStart;
  appServer.request = async (method, params) => {
    const result = await originalRequest(method, params);
    if (method === "turn/start") await new Promise((resolve) => { finishStart = resolve; });
    return result;
  };
  const prompt = bridge.submitLocalPrompt("테스트해줘");
  await tick();
  await bridge.handleUpdate(message("/status"));
  assert.match(telegram.messages.at(-1).text, /작업 시작을 요청하는 중/);
  const cancel = bridge.handleUpdate(message("/cancel"));
  const newThread = bridge.handleUpdate(message("/new"));
  finishStart();
  await Promise.all([prompt, cancel, newThread]);
  assert.equal(appServer.requests.at(-1).method, "turn/interrupt");
  assert.equal(appServer.requests.filter(({ method }) => method === "thread/start").length, 1);
});

test("접수 알림 전송 실패나 지연이 PC 접수 결과를 실패시키지 않는다", async (t) => {
  const { telegram, bridge } = await startFixture(t);
  telegram.sendMessage = async () => { throw new Error("네트워크 오류"); };
  assert.equal((await bridge.submitLocalPrompt("첫 작업")).mode, "started");
  telegram.sendMessage = () => new Promise(() => {});
  assert.equal((await bridge.submitLocalPrompt("추가 지시")).mode, "steered");
});

test("완료 알림 전송 실패 후 last로 복구한다", async (t) => {
  const { appServer, telegram, bridge } = await startFixture(t);
  await bridge.submitLocalPrompt("테스트해줘");
  const sendMessage = telegram.sendMessage.bind(telegram);
  telegram.sendMessage = async () => { throw new Error("네트워크 오류"); };
  complete(appServer);
  await tick();
  telegram.sendMessage = sendMessage;
  await bridge.handleUpdate(message("/last"));
  assert.match(telegram.messages.at(-1).text, /작업 완료[\s\S]*수정 완료/);
});

function ask(appServer, questions, id = 90) {
  appServer.emit("request", { id, method: "item/tool/requestUserInput", params: {
    threadId: "thread-1", turnId: "turn-1", questions,
  } });
}

test("질문 설명과 답변 대기 상태를 표시하고 텍스트 답변 시 이전 버튼을 만료한다", async (t) => {
  const { appServer, telegram, bridge } = await startFixture(t);
  await bridge.submitLocalPrompt("테스트해줘");
  ask(appServer, [
    { id: "choice", question: "범위를 고르세요", options: [{ label: "전체", description: "모든 테스트 실행" }] },
    { id: "detail", question: "추가 조건을 알려주세요", options: null },
  ]);
  await tick();
  const question = telegram.messages.at(-1);
  assert.match(question.text, /전체 — 모든 테스트 실행/);
  await bridge.handleUpdate(message("/status"));
  assert.match(telegram.messages.at(-1).text, /질문 답변 대기 \(1\/2\)/);
  await bridge.handleUpdate(message("일부만"));
  assert.ok(telegram.removedKeyboards.includes(question.message_id));
  await bridge.handleUpdate(message("/status"));
  assert.match(telegram.messages.at(-1).text, /질문 답변 대기 \(2\/2\)/);
  await bridge.handleUpdate(message("빠른 테스트"));
  assert.deepEqual(appServer.responses.at(-1), { id: 90, result: { answers: {
    choice: { answers: ["일부만"] }, detail: { answers: ["빠른 테스트"] },
  } } });
  await bridge.handleUpdate(message("/status"));
  assert.doesNotMatch(telegram.messages.at(-1).text, /질문 답변 대기/);
});

test("질문 버튼을 동시에 두 번 눌러도 다음 질문의 답변으로 재사용하지 않는다", async (t) => {
  const { appServer, telegram, bridge } = await startFixture(t);
  await bridge.submitLocalPrompt("테스트해줘");
  ask(appServer, [
    { id: "first", question: "첫 질문", options: [{ label: "선택 1" }] },
    { id: "second", question: "두 번째 질문", options: [{ label: "선택 2" }] },
  ]);
  await tick();
  const question = telegram.messages.at(-1);
  const query = { id: "double-tap", data: question.options.reply_markup.inline_keyboard[0][0].callback_data,
    message: { chat: { id: 123 }, message_id: question.message_id } };
  await Promise.all([bridge.handleUpdate({ callback_query: query }), bridge.handleUpdate({ callback_query: query })]);
  assert.equal(appServer.responses.length, 0);
  assert.equal(bridge.pendingUserInput.index, 1);
  await bridge.handleUpdate(message("별도 답변"));
  assert.deepEqual(appServer.responses.at(-1).result.answers.second, { answers: ["별도 답변"] });
});

for (const event of ["resolved", "completed"]) {
  test(`${event} 알림이 질문과 버튼을 정리하여 다음 메시지가 답변으로 소비되지 않는다`, async (t) => {
    const { appServer, telegram, bridge } = await startFixture(t);
    await bridge.submitLocalPrompt("테스트해줘");
    ask(appServer, [{ id: "choice", question: "범위를 고르세요", options: [{ label: "전체" }] }]);
    await tick();
    const question = telegram.messages.at(-1);
    if (event === "resolved") {
      appServer.emit("notification", { method: "serverRequest/resolved", params: { requestId: 90 } });
    } else complete(appServer);
    await tick();
    assert.equal(bridge.pendingUserInput, null);
    assert.ok(telegram.removedKeyboards.includes(question.message_id));
    await bridge.handleUpdate(message("새 지시"));
    assert.equal(appServer.requests.at(-1).method, event === "resolved" ? "turn/steer" : "turn/start");
    assert.equal(appServer.responses.length, 0);
  });
}

test("승인 메시지가 전송되는 동안 작업이 끝나도 늦게 나타난 버튼을 제거한다", async (t) => {
  const { appServer, telegram, bridge } = await startFixture(t);
  await bridge.submitLocalPrompt("테스트해줘");
  const sendMessage = telegram.sendMessage.bind(telegram);
  let releaseApproval;
  telegram.sendMessage = async (chatId, text, options) => {
    if (options?.reply_markup) await new Promise((resolve) => { releaseApproval = resolve; });
    return sendMessage(chatId, text, options);
  };
  appServer.emit("request", { id: 77, method: "item/commandExecution/requestApproval", params: {
    threadId: "thread-1", turnId: "turn-1", command: "npm test",
  } });
  complete(appServer);
  await tick();
  releaseApproval();
  await tick();
  assert.equal(bridge.pendingCallbacks.size, 0);
  assert.ok(telegram.removedKeyboards.includes(telegram.messages.at(-1).message_id));
});

test("disconnect reports unknown state and reconnect reads history without replay", async (t) => {
  const { appServer, telegram, bridge } = await startFixture(t);
  await bridge.submitLocalPrompt("test");
  appServer.emit("fatal", new Error("synthetic disconnect"));
  await bridge.handleUpdate(message("/status"));
  assert.match(telegram.messages.at(-1).text, /연결 끊김/);
  assert.doesNotMatch(telegram.messages.at(-1).text, /작업 진행 중/);
  await assert.rejects(bridge.submitLocalPrompt("duplicate"), /reconnect/);
  await bridge.handleUpdate(message("/reconnect"));
  assert.equal(bridge.connectionState, "connected");
  assert.equal(appServer.requests.filter(({ method }) => method === "turn/start").length, 1);
  assert.ok(appServer.requests.some(({ method }) => method === "thread/resume"));
  assert.ok(appServer.requests.some(({ method }) => method === "thread/turns/list"));
  assert.equal(bridge.activeTurnId, null);
});

test("unknown acceptance blocks queued prompts until explicit recovery", async (t) => {
  const { appServer, telegram, bridge } = await startFixture(t);
  const request = appServer.request.bind(appServer);
  let starts = 0;
  appServer.request = async (method, params) => {
    if (method === "turn/start") {
      starts += 1;
      throw Object.assign(new Error("timeout"), { outcome: "unknown" });
    }
    return request(method, params);
  };
  const first = assert.rejects(bridge.submitLocalPrompt("test"), (error) => error.outcome === "unknown");
  const second = assert.rejects(bridge.submitLocalPrompt("test again"), /reconnect/);
  await Promise.all([first, second]);
  assert.equal(starts, 1);
  await bridge.handleUpdate(message("/status"));
  assert.match(telegram.messages.at(-1).text, /접수 여부/);
  await bridge.handleUpdate(message("/new"));
  assert.match(telegram.messages.at(-1).text, /reconnect/);
});

test("failed history read stays disconnected instead of creating a new conversation", async (t) => {
  const { appServer, telegram, bridge } = await startFixture(t);
  await bridge.submitLocalPrompt("test");
  const request = appServer.request.bind(appServer);
  appServer.request = async (method, params) => {
    if (method === "thread/resume") throw new Error("unavailable");
    return request(method, params);
  };
  await bridge.handleUpdate(message("/reconnect"));
  assert.equal(bridge.connectionState, "disconnected");
  assert.equal(appServer.requests.filter(({ method }) => method === "thread/start").length, 1);
  assert.match(telegram.messages.at(-1).text, /복구에 실패/);
});

test("pending recovers failed approval delivery and all copies decide once", async (t) => {
  const { appServer, telegram, bridge } = await startFixture(t);
  await bridge.submitLocalPrompt("test");
  const send = telegram.sendMessage.bind(telegram);
  telegram.sendMessage = async () => { throw new Error("offline"); };
  appServer.emit("request", { id: 401, method: "item/commandExecution/requestApproval", params: {
    threadId: "thread-1", turnId: "turn-1", command: "npm test",
  } });
  await tick();
  assert.equal(bridge.pendingCallbacks.size, 1);
  telegram.sendMessage = send;
  await bridge.handleUpdate(message("/pending"));
  const first = telegram.messages.at(-1);
  await bridge.handleUpdate(message("/pending"));
  const second = telegram.messages.at(-1);
  assert.equal(first.options.reply_markup.inline_keyboard[0][0].callback_data, second.options.reply_markup.inline_keyboard[0][0].callback_data);
  const query = (msg) => ({ callback_query: { id: `tap-${msg.message_id}`,
    data: msg.options.reply_markup.inline_keyboard[0][0].callback_data,
    message: { chat: { id: 123 }, message_id: msg.message_id } } });
  await Promise.all([bridge.handleUpdate(query(first)), bridge.handleUpdate(query(second))]);
  assert.equal(appServer.responses.length, 1);
  assert.ok(telegram.removedKeyboards.includes(first.message_id));
  assert.ok(telegram.removedKeyboards.includes(second.message_id));
});

test("pending recovers question delivery and older copies cannot answer twice", async (t) => {
  const { appServer, telegram, bridge } = await startFixture(t);
  await bridge.submitLocalPrompt("test");
  const send = telegram.sendMessage.bind(telegram);
  telegram.sendMessage = async () => { throw new Error("offline"); };
  ask(appServer, [{ id: "choice", question: "Choose", options: [{ label: "A" }] }]);
  await tick();
  telegram.sendMessage = send;
  await bridge.handleUpdate(message("/pending"));
  const first = telegram.messages.at(-1);
  await bridge.handleUpdate(message("/pending"));
  const second = telegram.messages.at(-1);
  await bridge.handleUpdate(message("custom answer"));
  assert.equal(appServer.responses.length, 1);
  assert.ok(telegram.removedKeyboards.includes(first.message_id));
  assert.ok(telegram.removedKeyboards.includes(second.message_id));
});

test("secret questions are rejected before display and subsequent text is blocked", async (t) => {
  const { appServer, telegram, bridge } = await startFixture(t);
  await bridge.submitLocalPrompt("test");
  ask(appServer, [
    { id: "plain", question: "normal question" },
    { id: "secret", question: "SYNTHETIC_SECRET_QUESTION", isSecret: true },
  ]);
  await tick();
  await bridge.handleUpdate(message("SYNTHETIC_SECRET_ANSWER"));
  await assert.rejects(bridge.submitLocalPrompt("SYNTHETIC_SECRET_ANSWER"), /민감한 입력/);
  assert.equal(bridge.pendingUserInput, null);
  assert.ok(appServer.responses[0].error);
  assert.ok(!JSON.stringify(appServer.requests).includes("SYNTHETIC_SECRET_ANSWER"));
  assert.ok(!JSON.stringify(appServer.responses).includes("SYNTHETIC_SECRET_ANSWER"));
  assert.ok(!JSON.stringify(telegram.messages).includes("SYNTHETIC_SECRET_QUESTION"));
  complete(appServer);
  await tick();
  await bridge.handleUpdate(message("/new"));
  assert.equal(bridge.secretInputBlocked, false);
});

test("forged approval action is rejected without consuming the legitimate button", async (t) => {
  const { appServer, telegram, bridge } = await startFixture(t);
  appServer.emit("request", { id: 88, method: "item/commandExecution/requestApproval", params: {
    threadId: "thread-1", turnId: "turn-1", command: "npm test",
  } });
  await tick();
  const data = telegram.messages.at(-1).options.reply_markup.inline_keyboard[0][0].callback_data;
  await bridge.handleUpdate({ callback_query: { id: "forged", data: data.replace(":accept", ":grant"), message: { chat: { id: 123 } } } });
  assert.equal(appServer.responses.length, 0);
  assert.equal(bridge.pendingCallbacks.size, 1);
});

test("Telegram status remains responsive while its previous prompt is awaiting Codex", async (t) => {
  const { appServer, telegram, bridge } = await startFixture(t);
  const request = appServer.request.bind(appServer);
  let finish;
  appServer.request = async (method, params) => {
    if (method === "turn/start") await new Promise((resolve) => { finish = resolve; });
    return request(method, params);
  };
  bridge.dispatchUpdate(message("test"));
  await tick();
  bridge.dispatchUpdate(message("/status"));
  await tick();
  assert.match(telegram.messages.at(-1).text, /작업 시작을 요청하는 중/);
  finish();
  await tick();
  assert.equal(bridge.activeTurnId, "turn-1");
});

test("text sent before a question is delivered is not consumed as its answer", async (t) => {
  const { appServer, telegram, bridge } = await startFixture(t);
  await bridge.submitLocalPrompt("test");
  const send = telegram.sendMessage.bind(telegram);
  let finish;
  telegram.sendMessage = async (chatId, text, options) => {
    if (text.includes("Choose")) await new Promise((resolve) => { finish = resolve; });
    return send(chatId, text, options);
  };
  ask(appServer, [{ id: "one", question: "Choose", options: [{ label: "A" }] }]);
  await bridge.handleUpdate(message("premature answer"));
  assert.equal(appServer.responses.length, 0);
  assert.match(telegram.messages.at(-1).text, /질문을 확인한 뒤/);
  finish();
  await tick();
  await bridge.handleUpdate(message("intended answer"));
  assert.deepEqual(appServer.responses.at(-1).result.answers.one, { answers: ["intended answer"] });
});

test("unused conversation can reconnect without querying unmaterialized history", async (t) => {
  const { appServer, bridge } = await startFixture(t);
  await bridge.handleUpdate(message("/reconnect"));
  assert.equal(bridge.connectionState, "connected");
  assert.equal(appServer.requests.filter(({ method }) => method === "thread/start").length, 2);
  assert.equal(appServer.requests.filter(({ method }) => method === "turn/start").length, 0);
  assert.equal(appServer.requests.filter(({ method }) => method === "thread/turns/list").length, 0);
});

test("recovery delivery failure preserves connected state and recovered result", async (t) => {
  const { appServer, telegram, bridge } = await startFixture(t);
  await bridge.submitLocalPrompt("test");
  const request = appServer.request.bind(appServer);
  appServer.request = async (method, params) => method === "thread/turns/list"
    ? { data: [{ id: "turn-1", status: "completed", items: [{ type: "agentMessage", text: "recovered result" }] }] }
    : request(method, params);
  const send = telegram.sendMessage.bind(telegram);
  telegram.sendMessage = async () => { throw new Error("offline"); };
  await bridge.handleUpdate(message("/reconnect"));
  assert.equal(bridge.connectionState, "connected");
  telegram.sendMessage = send;
  await bridge.handleUpdate(message("/last"));
  assert.match(telegram.messages.at(-1).text, /recovered result/);
  assert.match(telegram.messages.at(-1).text, /소요 시간: 확인 불가/);
  assert.equal(appServer.requests.filter(({ method }) => method === "turn/start").length, 1);
});

test("스레드에 불필요한 샌드박스 외부 재시도를 막는 지침을 전달한다", async (t) => {
  const { appServer, bridge, statePath } = makeBridge();
  t.after(() => fs.rmSync(statePath, { force: true }));
  await bridge.start();
  const request = appServer.requests.find(({ method }) => method === "thread/start");
  assert.equal(request.params.developerInstructions, BRIDGE_DEVELOPER_INSTRUCTIONS);
  assert.match(request.params.developerInstructions, /Do not request an outside-sandbox retry/);
});

test("명령 승인 버튼을 app-server 응답으로 한 번만 전달한다", async (t) => {
  const { appServer, telegram, bridge, statePath } = makeBridge();
  t.after(() => fs.rmSync(statePath, { force: true }));
  await bridge.start();
  appServer.emit("request", {
    id: 77,
    method: "item/commandExecution/requestApproval",
    params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", command: "npm test", cwd: process.cwd() },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(telegram.messages.at(-1).text, /Codex 작업 경로:/);
  const callbackData = telegram.messages.at(-1).options.reply_markup.inline_keyboard[0][0].callback_data;
  const query = { id: "callback-1", data: callbackData, message: { chat: { id: 123 }, message_id: 1 } };
  await bridge.handleUpdate({ callback_query: query });
  assert.deepEqual(appServer.responses, [{ id: 77, result: { decision: "accept" } }]);
  await bridge.handleUpdate({ callback_query: query });
  assert.equal(appServer.responses.length, 1);
});

test("허용되지 않은 chat_id의 명령을 무시한다", async (t) => {
  const { appServer, bridge, statePath } = makeBridge();
  t.after(() => fs.rmSync(statePath, { force: true }));
  await bridge.start();
  const before = appServer.requests.length;
  await bridge.handleUpdate({ message: { chat: { id: 999 }, text: "파일 삭제" } });
  assert.equal(appServer.requests.length, before);
});
