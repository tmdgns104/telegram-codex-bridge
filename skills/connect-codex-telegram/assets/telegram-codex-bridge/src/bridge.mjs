import crypto from "node:crypto";
import fs from "node:fs";
import { finalAgentMessage, formatApproval, formatDuration } from "./format.mjs";

const CALLBACK_ACTIONS = new Set(["accept", "decline", "cancel", "grant", "deny"]);
const ACTIVITY_LABELS = {
  reasoning: "작업 검토 중",
  commandExecution: "명령 실행 중",
  fileChange: "파일 수정 중",
  mcpToolCall: "도구 실행 중",
  dynamicToolCall: "도구 실행 중",
  webSearch: "웹 검색 중",
  agentMessage: "답변 작성 중",
};

export const BRIDGE_DEVELOPER_INSTRUCTIONS = [
  "This Codex session is controlled through a Telegram bridge on Windows.",
  "Do not request an outside-sandbox retry merely because a diagnostic or read-only command failed.",
  "First use a sandbox-compatible alternative and treat expected probe failures (for example, a directory not being a Git repository or an optional tool being unavailable) as findings rather than reasons to escalate.",
  "Avoid Get-CimInstance and Win32_Process inspection in the Windows sandbox; use Get-Process or other non-WMI checks when possible.",
  "Request an outside-sandbox retry only when it is necessary for the user's requested outcome and the sandbox denial has been verified.",
].join(" ");

export class CodexTelegramBridge {
  constructor({ appServer, telegram, config, logger = console, now = Date.now }) {
    this.appServer = appServer;
    this.telegram = telegram;
    this.config = config;
    this.logger = logger;
    this.now = now;
    this.threadId = null;
    this.activeTurnId = null;
    this.agentText = "";
    this.pendingCallbacks = new Map();
    this.pendingUserInput = null;
    this.inputQueue = Promise.resolve();
    this.startingAt = null;
    this.turnStartedAt = null;
    this.activeItems = new Map();
    this.lastResult = null;

    appServer.on("request", (request) => {
      void this.#onServerRequest(request).catch((error) => this.logger.error("Codex 요청 처리 실패", error));
    });
    appServer.on("notification", (notification) => {
      void this.#onNotification(notification).catch((error) => this.logger.error("Codex 알림 처리 실패", error));
    });
    appServer.on("fatal", (error) => {
      void this.#send(`❌ Codex app-server 오류\n${error.message}`).catch((sendError) => this.logger.error(sendError));
    });
  }

  async start() {
    await this.appServer.start();
    await this.#loadOrCreateThread();
  }

  async submitLocalPrompt(text) {
    const mode = await this.#enqueueInput(() => this.#submitPrompt(text));
    return {
      mode,
      message: mode === "steered"
        ? "Instruction added to the active task. Approvals and results will arrive in Telegram."
        : "Task started. Approvals and results will arrive in Telegram.",
    };
  }

  async handleUpdate(update) {
    const chatId = String(update.message?.chat?.id ?? update.callback_query?.message?.chat?.id ?? "");
    if (chatId !== this.config.allowedChatId) {
      if (update.callback_query) {
        await this.telegram.answerCallbackQuery(update.callback_query.id, "허용되지 않은 사용자입니다.");
      }
      return;
    }

    if (update.callback_query) return this.#handleCallback(update.callback_query);
    const text = update.message?.text?.trim();
    if (!text) return;

    if (this.pendingUserInput && !text.startsWith("/")) {
      return this.#answerCurrentQuestion(text);
    }
    if (text.startsWith("/")) return this.#handleCommand(text);
    return this.#enqueueInput(() => this.#submitPrompt(text));
  }

  #enqueueInput(action) {
    // PC connections and Telegram polling share one thread; serialize mutations only.
    const result = this.inputQueue.then(action);
    this.inputQueue = result.catch(() => {});
    return result;
  }

  async #loadOrCreateThread() {
    let stored;
    try {
      stored = JSON.parse(fs.readFileSync(this.config.statePath, "utf8"));
    } catch {
      stored = null;
    }

    if (stored?.threadId) {
      try {
        const result = await this.appServer.request("thread/resume", {
          threadId: stored.threadId,
          cwd: this.config.workdir,
          sandbox: this.config.sandbox,
          approvalPolicy: this.config.approvalPolicy,
          approvalsReviewer: "user",
          developerInstructions: BRIDGE_DEVELOPER_INSTRUCTIONS,
        });
        this.threadId = result.thread.id;
        return;
      } catch (error) {
        this.logger.error(`기존 스레드 재개 실패, 새 스레드를 만듭니다: ${error.message}`);
      }
    }
    await this.#createThread();
  }

  async #createThread() {
    const result = await this.appServer.request("thread/start", {
      cwd: this.config.workdir,
      sandbox: this.config.sandbox,
      approvalPolicy: this.config.approvalPolicy,
      approvalsReviewer: "user",
      developerInstructions: BRIDGE_DEVELOPER_INSTRUCTIONS,
    });
    this.threadId = result.thread.id;
    fs.writeFileSync(this.config.statePath, JSON.stringify({ threadId: this.threadId }, null, 2));
  }

  async #submitPrompt(text) {
    if (this.activeTurnId) {
      await this.appServer.request("turn/steer", {
        threadId: this.threadId,
        expectedTurnId: this.activeTurnId,
        input: [{ type: "text", text }],
      });
      this.#announce("↪️ 진행 중인 작업에 추가 지시를 전달했습니다.");
      return "steered";
    }

    this.agentText = "";
    this.startingAt = this.now();
    try {
      const result = await this.appServer.request("turn/start", {
        threadId: this.threadId,
        cwd: this.config.workdir,
        approvalPolicy: this.config.approvalPolicy,
        approvalsReviewer: "user",
        input: [{ type: "text", text }],
      });
      this.#activateTurn(result.turn.id);
      if (this.activeTurnId === result.turn.id) {
        this.#announce("▶️ 작업을 시작했습니다.\n/status로 진행 상황을 확인하고 /cancel로 중단할 수 있습니다.");
      }
      return "started";
    } finally {
      this.startingAt = null;
    }
  }

  #activateTurn(turnId) {
    // A fast completion notification can arrive before the turn/start response.
    if (this.lastResult?.turnId === turnId || this.activeTurnId === turnId) return;
    this.activeTurnId = turnId;
    this.turnStartedAt = this.startingAt ?? this.now();
    this.activeItems.clear();
  }

  #statusText() {
    if (!this.activeTurnId) {
      if (this.startingAt !== null) return "⏳ Codex에 작업 시작을 요청하는 중입니다.";
      const last = this.lastResult
        ? `\n최근 작업: ${this.lastResult.heading} · ${formatDuration(this.lastResult.durationMs)}\n/last로 결과를 다시 볼 수 있습니다.`
        : "\n일반 메시지로 작업을 시작하세요.";
      return `✅ 대기 중${last}`;
    }
    let state = "⏳ 작업 진행 중";
    const approvals = [...this.pendingCallbacks.values()]
      .filter((pending) => pending.params.turnId === this.activeTurnId).length;
    if (this.pendingUserInput) {
      state = `❓ 질문 답변 대기 (${this.pendingUserInput.index + 1}/${this.pendingUserInput.params.questions.length})\n질문 메시지의 버튼 또는 일반 메시지로 답하세요.`;
    } else if (approvals) {
      state = `🔐 승인 대기 (${approvals}건)\n승인 요청 메시지의 버튼을 눌러주세요.`;
    }
    const activities = [...new Set(this.activeItems.values())];
    const activity = activities.length ? activities.join(" · ") : "Codex 응답 대기 중";
    return `${state}\n경과 시간: ${formatDuration(this.now() - this.turnStartedAt)}\n현재 활동: ${activity}\n/cancel — 작업 중단`;
  }

  async #handleCommand(text) {
    const command = text.split(/\s+/)[0].split("@")[0].toLowerCase();
    if (command === "/start" || command === "/help") {
      await this.#send([
        "🤖 Telegram Codex Bridge",
        "",
        "일반 메시지: Codex에 작업 지시",
        "/status — 진행 상황·경과 시간·승인 대기 확인",
        "/last — 최근 완료·실패·중단 결과 다시 보기",
        "/new — 새 Codex 대화",
        "/cancel — 진행 중인 작업 중단",
        "/where — 작업 경로 확인",
        "",
        "승인 요청은 인라인 버튼으로 전달됩니다.",
      ].join("\n"));
      return;
    }
    if (command === "/status") {
      await this.#send(this.#statusText());
      return;
    }
    if (command === "/last") {
      await this.#send(this.lastResult
        ? this.lastResult.text
        : "아직 조회할 결과가 없습니다. 최근 결과는 브리지를 실행한 동안만 보관됩니다.");
      return;
    }
    if (command === "/where") {
      await this.#send(`📁 ${this.config.workdir}\nSandbox: ${this.config.sandbox}\n승인 정책: ${this.config.approvalPolicy}`);
      return;
    }
    if (command === "/new") {
      return this.#enqueueInput(async () => {
        if (this.activeTurnId) {
          await this.#send("진행 중인 작업이 있습니다. 먼저 /cancel을 사용하세요.");
          return;
        }
        await this.#createThread();
        await this.#send(`🆕 새 Codex 대화를 만들었습니다.\nthread: ${this.threadId}`);
      });
    }
    if (command === "/cancel") {
      return this.#enqueueInput(async () => {
        if (!this.activeTurnId) {
          await this.#send("진행 중인 작업이 없습니다.");
          return;
        }
        await this.appServer.request("turn/interrupt", {
          threadId: this.threadId,
          turnId: this.activeTurnId,
        });
        await this.#send("⏹️ 작업 중단을 요청했습니다.");
      });
    }
    await this.#send("알 수 없는 명령입니다. /help를 확인하세요.");
  }

  async #onServerRequest(request) {
    const { method, params, id } = request;
    if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
      const token = this.#registerCallback({ rpcId: id, method, params });
      const sent = await this.telegram.sendMessage(this.config.allowedChatId, this.#withWorkdir(formatApproval(method, params)), {
        reply_markup: {
          inline_keyboard: [
            [{ text: "✅ 이번만 허용", callback_data: `a:${token}:accept` }],
            [
              { text: "❌ 거부", callback_data: `a:${token}:decline` },
              { text: "⏹ 작업 취소", callback_data: `a:${token}:cancel` },
            ],
          ],
        },
      });
      await this.#attachApprovalMessage(token, sent.message_id);
      return;
    }
    if (method === "item/permissions/requestApproval") {
      const token = this.#registerCallback({ rpcId: id, method, params });
      const sent = await this.telegram.sendMessage(this.config.allowedChatId, this.#withWorkdir(formatApproval(method, params)), {
        reply_markup: {
          inline_keyboard: [[
            { text: "✅ 이번 턴만 허용", callback_data: `a:${token}:grant` },
            { text: "❌ 거부", callback_data: `a:${token}:deny` },
          ]],
        },
      });
      await this.#attachApprovalMessage(token, sent.message_id);
      return;
    }
    if (method === "item/tool/requestUserInput") {
      await this.#beginUserInput(id, params);
      return;
    }

    this.appServer.respondError(id, -32601, `Telegram bridge에서 지원하지 않는 요청: ${method}`);
    await this.#send(`⚠️ 지원하지 않는 Codex 요청을 거부했습니다.\n${method}`);
  }

  async #handleCallback(query) {
    const parts = String(query.data || "").split(":");
    if (parts[0] === "q") return this.#handleQuestionOption(query, parts);
    if (parts.length !== 3 || parts[0] !== "a" || !CALLBACK_ACTIONS.has(parts[2])) {
      await this.telegram.answerCallbackQuery(query.id, "유효하지 않은 버튼입니다.");
      return;
    }

    const [, token, action] = parts;
    const pending = this.pendingCallbacks.get(token);
    if (!pending) {
      await this.telegram.answerCallbackQuery(query.id, "이미 처리되었거나 만료된 요청입니다.");
      return;
    }
    this.pendingCallbacks.delete(token);

    let result;
    if (pending.method === "item/permissions/requestApproval") {
      result = action === "grant"
        ? { permissions: pending.params.permissions, scope: "turn" }
        : { permissions: {}, scope: "turn" };
    } else {
      result = { decision: action };
    }
    this.appServer.respond(pending.rpcId, result);
    await Promise.allSettled([
      this.telegram.answerCallbackQuery(query.id, action === "accept" || action === "grant" ? "허용했습니다." : "거부했습니다."),
      this.telegram.removeKeyboard(this.config.allowedChatId, pending.messageId),
    ]);
  }

  async #beginUserInput(rpcId, params) {
    if (this.pendingUserInput) {
      this.appServer.respondError(rpcId, -32000, "다른 사용자 입력 요청이 진행 중입니다.");
      return;
    }
    this.pendingUserInput = { rpcId, params, index: 0, answers: {} };
    await this.#sendCurrentQuestion();
  }

  async #sendCurrentQuestion() {
    const pending = this.pendingUserInput;
    const question = pending.params.questions[pending.index];
    const prefix = `❓ Codex 질문 ${pending.index + 1}/${pending.params.questions.length}\n${question.question}`;
    if (question.isSecret) {
      await this.#send(`${prefix}\n\n⚠️ Telegram은 종단간 암호화된 봇 채팅이 아닙니다. 비밀번호·API 키는 보내지 마세요.`);
    } else if (question.options?.length) {
      const token = crypto.randomBytes(5).toString("hex");
      pending.optionToken = token;
      pending.optionValues = question.options.map((option) => option.label);
      const descriptions = question.options.map((option) =>
        `${option.label}${option.description ? ` — ${option.description}` : ""}`).join("\n");
      const sent = await this.telegram.sendMessage(this.config.allowedChatId,
        this.#withWorkdir(`${prefix}\n\n${descriptions}\n\n버튼을 누르거나 일반 메시지로 답하세요.`), {
        reply_markup: {
          inline_keyboard: question.options.map((option, index) => [{
            text: option.label,
            callback_data: `q:${token}:${index}`,
          }]),
        },
      });
      if (this.pendingUserInput === pending && pending.optionToken === token) {
        pending.messageId = sent.message_id;
      } else {
        await this.telegram.removeKeyboard(this.config.allowedChatId, sent.message_id).catch(() => {});
      }
    } else {
      await this.#send(`${prefix}\n\n답변을 일반 메시지로 보내세요.`);
    }
  }

  async #handleQuestionOption(query, parts) {
    const pending = this.pendingUserInput;
    const index = Number(parts[2]);
    if (!pending || parts[1] !== pending.optionToken || !Number.isInteger(index) || !pending.optionValues[index]) {
      await this.telegram.answerCallbackQuery(query.id, "이미 처리되었거나 만료된 질문입니다.");
      return;
    }
    const answer = pending.optionValues[index];
    // Consume the option before Telegram I/O so a second tap cannot answer the next question.
    await Promise.all([
      this.#answerCurrentQuestion(answer),
      this.telegram.answerCallbackQuery(query.id, "답변을 전달했습니다.").catch(() => {}),
    ]);
  }

  async #answerCurrentQuestion(answer) {
    const pending = this.pendingUserInput;
    if (!pending) return;
    const question = pending.params.questions[pending.index];
    pending.answers[question.id] = { answers: [answer] };
    pending.index += 1;
    pending.optionToken = null;
    pending.optionValues = null;
    const messageId = pending.messageId;
    pending.messageId = null;
    if (messageId) {
      void this.telegram.removeKeyboard(this.config.allowedChatId, messageId).catch(() => {});
    }
    if (pending.index < pending.params.questions.length) {
      await this.#sendCurrentQuestion();
      return;
    }
    this.pendingUserInput = null;
    this.appServer.respond(pending.rpcId, { answers: pending.answers });
    await this.#send("✅ 답변을 Codex에 전달했습니다.");
  }

  async #onNotification({ method, params }) {
    if (method === "serverRequest/resolved") {
      const cleanup = [];
      for (const [token, pending] of this.pendingCallbacks) {
        if (String(pending.rpcId) === String(params.requestId)) {
          this.pendingCallbacks.delete(token);
          if (pending.messageId) {
            cleanup.push(this.telegram.removeKeyboard(this.config.allowedChatId, pending.messageId));
          }
        }
      }
      if (this.pendingUserInput && String(this.pendingUserInput.rpcId) === String(params.requestId)) {
        const messageId = this.pendingUserInput.messageId;
        this.pendingUserInput = null;
        if (messageId) cleanup.push(this.telegram.removeKeyboard(this.config.allowedChatId, messageId));
      }
      await Promise.allSettled(cleanup);
      return;
    }
    if (params?.threadId !== this.threadId) return;
    if (method === "turn/started") {
      if (this.startingAt === null && params.turn.id !== this.activeTurnId) return;
      this.#activateTurn(params.turn.id);
      return;
    }
    if (method.startsWith("item/")) {
      if (!this.activeTurnId || params.turnId !== this.activeTurnId) return;
      if (method === "item/agentMessage/delta") this.agentText += params.delta;
      if (method === "item/started") {
        const activity = ACTIVITY_LABELS[params.item.type];
        if (activity) this.activeItems.set(params.item.id, activity);
      }
      if (method === "item/completed") this.activeItems.delete(params.item.id);
      return;
    }
    if (method === "turn/completed") {
      if (this.lastResult?.turnId === params.turn.id) return;
      const wasActive = params.turn.id === this.activeTurnId || (!this.activeTurnId && this.startingAt !== null);
      if (!wasActive) return;
      this.activeTurnId = null;
      const questionMessageId = this.pendingUserInput?.messageId;
      this.pendingUserInput = null;
      this.activeItems.clear();
      const cleanup = [];
      if (questionMessageId) cleanup.push(this.telegram.removeKeyboard(this.config.allowedChatId, questionMessageId));
      for (const [token, pending] of this.pendingCallbacks) {
        if (pending.params?.turnId === params.turn.id) {
          this.pendingCallbacks.delete(token);
          if (pending.messageId) {
            cleanup.push(this.telegram.removeKeyboard(this.config.allowedChatId, pending.messageId));
          }
        }
      }
      const status = params.turn.status;
      const heading = status === "completed" ? "✅ 작업 완료" : status === "interrupted" ? "⏹️ 작업 중단됨" : "❌ 작업 실패";
      const body = status === "failed"
        ? params.turn.error?.message || "알 수 없는 오류"
        : finalAgentMessage(params.turn, this.agentText);
      this.agentText = "";
      const durationMs = this.now() - (this.turnStartedAt ?? this.startingAt ?? this.now());
      const text = `${heading}\n소요 시간: ${formatDuration(durationMs)}\n\n${body}`;
      // Save before delivery: /last can recover a result after a Telegram send failure.
      this.lastResult = { turnId: params.turn.id, heading, durationMs, text };
      this.turnStartedAt = null;
      await Promise.allSettled(cleanup);
      await this.#send(text);
    }
  }

  async #attachApprovalMessage(token, messageId) {
    const pending = this.pendingCallbacks.get(token);
    if (pending) pending.messageId = messageId;
    else await this.telegram.removeKeyboard(this.config.allowedChatId, messageId).catch(() => {});
  }

  #registerCallback(value) {
    const token = crypto.randomBytes(6).toString("hex");
    this.pendingCallbacks.set(token, value);
    return token;
  }

  #send(text) {
    return this.telegram.sendMessage(this.config.allowedChatId, this.#withWorkdir(text));
  }

  #announce(text) {
    // An accepted Codex request stays accepted even if its Telegram receipt fails or stalls.
    void this.#send(text).catch((error) => this.logger.error("작업 접수 알림 전송 실패", error));
  }

  #withWorkdir(text) {
    return `📂 Codex 작업 경로: ${this.config.workdir}\n\n${text}`;
  }
}
