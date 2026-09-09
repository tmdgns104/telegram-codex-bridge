import crypto from "node:crypto";
import fs from "node:fs";
import { finalAgentMessage, formatApproval, formatDuration } from "./format.mjs";
import { projectName, resultPreview, shortTaskId } from "./result-presentation.mjs";
import { hasAttachment, receiveAttachment, listArtifacts, readArtifact } from "./files.mjs";

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
  "The user reads results on a phone. Begin the final response with a concise outcome, any failed or unverified criteria, and the next required user action. Put supporting details after that. Never label the user's whole task successful merely because a turn ended.",
].join(" ");

export class CodexTelegramBridge {
  constructor({ appServer, telegram, config, nativeApprovals, workspace, logger = console, now = Date.now }) {
    this.appServer = appServer;
    this.telegram = telegram;
    this.config = config;
    this.nativeApprovals = nativeApprovals;
    this.workspace = workspace;
    this.itemDetails = new Map();
    this.taskQueue = [];
    this.queueEnabled = true;
    this.fileChoices = new Map();
    this.logger = logger;
    this.now = now;
    this.threadId = null;
    this.activeTurnId = null;
    this.agentText = "";
    this.pendingCallbacks = new Map();
    this.pendingUserInput = null;
    this.inputQueue = Promise.resolve();
    this.queuedInputs = 0;
    this.startingAt = null;
    this.turnStartedAt = null;
    this.activeItems = new Map();
    this.lastResult = null;
    this.connectionState = "connecting";
    this.secretInputBlocked = false;
    this.threadWasUsed = true;
    this.messageTargets = new Map();

    appServer.on("request", (request) => {
      void this.#onServerRequest(request).catch((error) => this.logger.error("Codex 요청 처리 실패", error));
    });
    appServer.on("notification", (notification) => {
      void this.#onNotification(notification).catch((error) => this.logger.error("Codex 알림 처리 실패", error));
    });
    appServer.on("fatal", (error) => {
      this.queueEnabled = false;
      this.connectionState = "disconnected";
      this.#clearPending();
      this.#announce("🔌 Codex 연결이 끊겼습니다.\n작업 상태를 확정할 수 없습니다. /reconnect로 연결을 복구하세요.\n이전 작업은 자동으로 다시 실행하지 않습니다.");
    });
  }

  async start() {
    await this.appServer.start();
    await this.#loadOrCreateThread();
    this.connectionState = "connected";
    this.#restoreResult();
  }

  async submitLocalPrompt(text) {
    const mode = await this.#enqueueInput(() => this.#submitPrompt(text));
    return {
      mode,
      message: mode === "steered"
        ? "진행 중인 작업에 추가 지시를 전달했습니다. 승인·결과는 Telegram에서 확인하세요."
        : "Codex 작업이 시작됐습니다. 승인·결과는 Telegram에서 확인하세요.",
    };
  }

  dispatchUpdate(update) {
    // Polling must remain responsive to /status while a Codex RPC is awaiting a reply.
    void this.handleUpdate(update).catch(() => this.logger.error("Telegram 입력 처리 실패. /status 또는 /pending으로 확인하세요."));
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
    if (update.message?.reply_to_message && !this.#canReplyTo(update.message.reply_to_message.message_id)) {
      await this.#send("이 메시지는 현재 제어 중인 작업의 답장 대상이 아닙니다. PC 알림에는 PC에서 후속 지시를 보내세요. 현재 작업은 /status, /where로 확인할 수 있습니다.");
      return;
    }
    const text = update.message?.text?.trim();
    if (hasAttachment(update.message)) {
      const workdir = this.config.workdir;
      const threadId = this.threadId;
      const replyId = update.message.reply_to_message?.message_id;
      return this.#enqueueInput(async () => {
        if (this.secretInputBlocked || this.pendingUserInput) throw new Error("현재 질문에는 텍스트로 답해주세요. 민감한 값은 PC에서 설정하세요.");
        if (workdir !== this.config.workdir || threadId !== this.threadId || (replyId && !this.#canReplyTo(replyId))) throw new Error("첨부 대상 작업이 바뀌었습니다. /status로 확인한 뒤 다시 보내세요.");
        this.#requireConnection();
        const attachment = await receiveAttachment({ message: update.message, telegram: this.telegram, workdir });
        // Approval/question state can change while Telegram downloads the file.
        if (this.secretInputBlocked || this.pendingUserInput || (replyId && !this.#canReplyTo(replyId))) throw new Error("첨부 수신 중 작업 상태가 바뀌었습니다. /pending으로 확인하세요.");
        const prompt = update.message.caption?.trim() || (update.message.voice || update.message.audio ? "이 음성의 요청을 듣고 처리해주세요. 해석할 수 없으면 알려주세요." : "이 첨부 내용을 확인하고 요약해주세요.");
        await this.#submitPrompt(prompt, [attachment.input]);
      }).catch((error) => this.#send(`첨부를 전달하지 못했습니다. ${error.message}`));
    }
    if (!text) {
      if (update.message) await this.#send("현재는 텍스트 입력만 지원합니다. 사진·파일·음성의 내용을 글로 설명해주세요.");
      return;
    }

    if (!text.startsWith("/") && this.secretInputBlocked) {
      await this.#send("민감한 입력은 받지 않습니다. PC에서 설정을 마친 뒤 /cancel, /new 순서로 새 대화를 시작하세요.");
      return;
    }

    if (this.pendingUserInput && !text.startsWith("/")) {
      if (!this.pendingUserInput.questionReady) {
        await this.#send("질문을 아직 전달하지 못했습니다. /pending으로 질문을 확인한 뒤 답해주세요.");
        return;
      }
      return this.#answerCurrentQuestion(text);
    }
    if (text.startsWith("/")) return this.#handleCommand(text);
    const replyId = update.message?.reply_to_message?.message_id;
    return this.#enqueueInput(() => {
      if (replyId && !this.#canReplyTo(replyId)) throw new Error("답장 대상의 작업이 바뀌었습니다. /status로 현재 작업을 확인하세요.");
      return this.#submitPrompt(text);
    }).catch((error) =>
      error.outcome === "unknown" ? undefined : this.#send(this.#promptErrorText(error)));
  }

  #enqueueInput(action) {
    // PC connections and Telegram polling share one thread; serialize mutations only.
    this.queuedInputs += 1;
    const result = this.inputQueue.then(() => { this.queuedInputs -= 1; return action(); });
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
    if (this.workspace) {
      const project = this.workspace.selected;
      stored = project.threadId ? { threadId: project.threadId } :
        project.path === this.workspace.initialWorkdir && (!stored?.workdir || stored.workdir === project.path) ? stored : null;
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
        this.workspace?.setThread(this.threadId);
        return;
      } catch (error) {
        if (error.outcome === "unknown") throw error;
        this.logger.error(`기존 스레드 재개 실패, 새 스레드를 만듭니다: ${error.message}`);
      }
    }
    await this.#createThread();
  }

  async #createThread() {
    const result = await this.#taskRequest("thread/start", {
      cwd: this.config.workdir,
      sandbox: this.config.sandbox,
      approvalPolicy: this.config.approvalPolicy,
      approvalsReviewer: "user",
      developerInstructions: BRIDGE_DEVELOPER_INSTRUCTIONS,
    });
    this.threadId = result.thread.id;
    this.threadWasUsed = false;
    fs.writeFileSync(this.config.statePath, JSON.stringify({ threadId: this.threadId, workdir: this.config.workdir }, null, 2));
    this.workspace?.setThread(this.threadId);
  }

  async #submitPrompt(text, attachments = []) {
    this.#requireConnection();
    if (this.secretInputBlocked) throw new Error("민감한 입력은 받지 않습니다. PC에서 설정한 뒤 Telegram에서 /cancel, /new를 사용하세요.");
    if (this.activeTurnId) {
      await this.#taskRequest("turn/steer", {
        threadId: this.threadId,
        expectedTurnId: this.activeTurnId,
        input: [{ type: "text", text }, ...attachments],
      });
      this.#announce("↪️ 진행 중인 작업에 추가 지시를 전달했습니다.");
      return "steered";
    }

    this.agentText = "";
    this.startingAt = this.now();
    const previouslyUsed = this.threadWasUsed;
    this.threadWasUsed = true;
    try {
      const result = await this.#taskRequest("turn/start", {
        threadId: this.threadId,
        cwd: this.config.workdir,
        approvalPolicy: this.config.approvalPolicy,
        approvalsReviewer: "user",
        input: [{ type: "text", text }, ...attachments],
      });
      this.#activateTurn(result.turn.id);
      if (this.activeTurnId === result.turn.id) {
        this.#announce("▶️ 작업을 시작했습니다.\n/status로 진행 상황을 확인하고 /cancel로 중단할 수 있습니다.");
      }
      return "started";
    } catch (error) {
      if (error.outcome !== "unknown") this.threadWasUsed = previouslyUsed;
      throw error;
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
    this.itemDetails.clear();
  }

  #statusText() {
    if (this.connectionState !== "connected") {
      const state = this.connectionState === "uncertain" ? "⚠️ 접수 여부 확인 필요"
        : this.connectionState === "reconnecting" ? "🔄 Codex 연결 복구 중" : "🔌 Codex 연결 끊김";
      return `${state}\n진행 여부를 아직 확정할 수 없습니다.\n/reconnect — 연결 재설정 및 기존 대화 상태 확인\n같은 작업을 다시 보내기 전에 연결을 복구하세요.`;
    }
    if (this.secretInputBlocked) return "🔒 민감한 입력 차단 중\nPC에서 값을 설정한 뒤 /cancel, /new 순서로 새 대화를 시작하세요.";
    if (!this.activeTurnId) {
      if (this.startingAt !== null) return "⏳ Codex에 작업 시작을 요청하는 중입니다.";
      if (this.queuedInputs > 0) return "⏳ 요청을 순서대로 전달하고 있습니다. 잠시 뒤 /status로 확인하세요.";
      const last = this.lastResult
        ? `\n최근 작업: ${this.lastResult.heading} · ${formatDuration(this.lastResult.durationMs)}\n/last로 결과를 다시 볼 수 있습니다.`
        : "\n일반 메시지로 작업을 시작하세요.";
      return `✅ 대기 중${last}`;
    }
    let state = "⏳ 작업 진행 중";
    const approvals = [...this.pendingCallbacks.values()]
      .filter((pending) => pending.params.turnId === this.activeTurnId).length;
    if (this.pendingUserInput) {
      state = `❓ 질문 답변 대기 (${this.pendingUserInput.index + 1}/${this.pendingUserInput.params.questions.length})\n/pending으로 질문을 다시 보고 답할 수 있습니다.`;
    } else if (approvals) {
      state = `🔐 승인 대기 (${approvals}건)\n/pending으로 승인 버튼을 다시 받을 수 있습니다.`;
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
        "/detail — 최근 결과의 전체 원문 파일 받기",
        "/pending — 놓친 승인·질문 다시 받기",
        "/menu — 버튼 메뉴",
        "/projects · /project 번호 — 프로젝트 선택",
        "/project add 절대경로 — PC 승인 대상 프로젝트 등록",
        "/queue add 내용 — 별도 다음 작업 예약",
        "/queue pause · /queue run · /queue drop 번호",
        "/history [번호] — 저장된 결과 조회",
        "/files · /file 상대경로 — 산출물 받기 (10MB 이하)",
        "사진·문서·음성과 설명을 함께 보내 작업을 지시할 수 있습니다.",
        "/reconnect — 연결 재설정 (진행 중 작업이 중단될 수 있음)",
        "/new — 새 Codex 대화",
        "/cancel — 진행 중인 작업 중단",
        "/where — 작업 경로 확인",
        "",
        "승인 요청은 인라인 버튼으로 전달됩니다.",
      ].join("\n"));
      return;
    }
    if (command === "/status") {
      const nativeCount = this.nativeApprovals?.pending.size || 0;
      await this.#send(`${this.#statusText()}\n다음 작업: ${this.taskQueue.length}건${this.queueEnabled ? "" : " (일시정지)"}${nativeCount ? `\nPC 승인 대기: ${nativeCount}건` : ""}`);
      return;
    }
    if (command === "/menu" || command === "/projects" || command === "/project" || command === "/queue" || command === "/history") {
      return this.#workflowCommand(command, text.slice(text.indexOf(" ") + 1).trim() === text ? "" : text.slice(text.indexOf(" ") + 1).trim());
    }
    if (command === "/files" || command === "/file") {
      try {
        if (command === "/file") {
          const relative = text.slice(text.indexOf(" ") + 1).trim();
          return await this.#sendArtifact(this.config.workdir, relative);
        }
        const choices = listArtifacts(this.config.workdir);
        this.fileChoices.clear();
        const buttons = choices.map((file) => {
          const token = crypto.randomBytes(8).toString("hex");
          this.fileChoices.set(token, { workdir: this.config.workdir, path: file.path, expiresAt: this.now() + 300_000 });
          return [{ text: `${file.path.slice(-50)} · ${Math.ceil(file.size / 1024)}KB`, callback_data: `f:${token}` }];
        });
        return await this.telegram.sendMessage(this.config.allowedChatId, this.#withWorkdir("최근 문서·이미지·음성 파일입니다. 받을 파일을 선택하세요.\n최대 12개 표시 · /file 상대경로로 직접 받기\n버튼은 5분 뒤 또는 프로젝트 변경 시 만료됩니다."), { reply_markup: { inline_keyboard: buttons } });
      } catch (error) { return this.#send(`산출물을 보내지 못했습니다. ${error.message}`); }
    }
    if (command === "/last") {
      if (this.lastResult) await this.#sendResult(this.lastResult);
      else await this.#send("아직 조회할 결과가 없습니다. 최근 결과는 브리지를 실행한 동안만 보관됩니다.");
      return;
    }
    if (command === "/detail") return this.#sendDetail();
    if (command === "/where") {
      await this.#send(`📁 ${this.config.workdir}\nSandbox: ${this.config.sandbox}\n승인 정책: ${this.config.approvalPolicy}`);
      return;
    }
    if (command === "/pending") return this.#resendPending();
    if (command === "/reconnect") {
      return this.#enqueueInput(() => this.#reconnect()).catch(() =>
        this.#send("연결 복구에 실패했습니다. PC에서 브리지 실행 상태와 Codex 로그인을 확인하세요. 반복되면 브리지를 재시작한 뒤 /status로 확인하세요. 이전 작업은 재실행하지 않았습니다."));
    }
    if (command === "/new") {
      return this.#enqueueInput(async () => {
        this.#requireConnection();
        if (this.activeTurnId || this.taskQueue.length) {
          await this.#send("진행 중인 작업이 있습니다. 먼저 /cancel을 사용하세요.");
          return;
        }
        await this.#createThread();
        this.secretInputBlocked = false;
        await this.#send(`🆕 새 Codex 대화를 만들었습니다.\nthread: ${this.threadId}`);
      }).catch((error) => this.#send(this.#promptErrorText(error)));
    }
    if (command === "/cancel") {
      this.queueEnabled = false;
      return this.#enqueueInput(async () => {
        this.#requireConnection();
        if (!this.activeTurnId) {
          await this.#send("진행 중인 작업이 없습니다.");
          return;
        }
        await this.#taskRequest("turn/interrupt", {
          threadId: this.threadId,
          turnId: this.activeTurnId,
        });
        await this.#send("⏹️ 작업 중단을 요청했습니다.");
      }).catch((error) => this.#send(this.#promptErrorText(error)));
    }
    await this.#send("알 수 없는 명령입니다. /help를 확인하세요.");
  }

  async #onServerRequest(request) {
    const { method, params, id } = request;
    if (params?.threadId && params.threadId !== this.threadId) {
      this.appServer.respondError(id, -32602, "현재 프로젝트의 요청이 아닙니다.");
      return;
    }
    if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
      const item = this.itemDetails.get(params.itemId);
      const token = this.#registerCallback({ rpcId: id, method, params: { ...params, ...(item?.changes ? { changes: item.changes } : {}) } });
      await this.#sendApproval(token);
      return;
    }
    if (method === "item/permissions/requestApproval") {
      const token = this.#registerCallback({ rpcId: id, method, params });
      await this.#sendApproval(token);
      return;
    }
    if (method === "item/tool/requestUserInput") {
      await this.#beginUserInput(id, params);
      return;
    }

    this.appServer.respondError(id, -32601, `Telegram bridge에서 지원하지 않는 요청: ${method}`);
    await this.#send(`⚠️ 지원하지 않는 Codex 요청을 거부했습니다.\n${method}`);
  }

  async #sendApproval(token) {
    const pending = this.pendingCallbacks.get(token);
    if (!pending) return;
    const { method, params } = pending;
    if (pending.sending) return pending.sending;
    const markup = method === "item/permissions/requestApproval" ? {
      inline_keyboard: [[
        { text: "✅ 이번 턴만 허용", callback_data: `a:${token}:grant` },
        { text: "❌ 거부", callback_data: `a:${token}:deny` },
      ]],
    } : {
      inline_keyboard: [
        [{ text: "✅ 이번만 허용", callback_data: `a:${token}:accept` }],
        [
          { text: "❌ 거부", callback_data: `a:${token}:decline` },
          { text: "⏹ 작업 취소", callback_data: `a:${token}:cancel` },
        ],
      ],
    };
    if (method === "item/commandExecution/requestApproval" && Array.isArray(params.availableDecisions)) {
      const allowed = params.availableDecisions.filter((value) => typeof value === "string");
      markup.inline_keyboard = markup.inline_keyboard.map((row) => row.filter((button) => allowed.includes(button.callback_data.split(":").at(-1)))).filter((row) => row.length);
    }
    markup.inline_keyboard.push([{ text: "📄 요청 전체 내용", callback_data: `d:${token}` }]);
    pending.sending = (async () => {
      const sent = await this.telegram.sendMessage(this.config.allowedChatId,
        this.#withWorkdir(formatApproval(method, params)), { reply_markup: markup, retry: true });
      await this.#attachApprovalMessage(token, sent.message_id);
    })();
    try { await pending.sending; }
    finally { pending.sending = null; }
  }

  async #handleCallback(query) {
    if (await this.nativeApprovals?.handleCallback(query)) return;
    const parts = String(query.data || "").split(":");
    if (parts[0] === "f") {
      const choice = parts.length === 2 && this.fileChoices.get(parts[1]);
      if (!choice || choice.workdir !== this.config.workdir || this.now() >= choice.expiresAt) return this.telegram.answerCallbackQuery(query.id, "만료된 파일 목록입니다. /files로 다시 확인하세요.");
      await this.telegram.answerCallbackQuery(query.id, "파일을 보내겠습니다.");
      try { await this.#sendArtifact(choice.workdir, choice.path); }
      catch (error) { await this.#send(`산출물을 보내지 못했습니다. ${error.message}`); }
      return;
    }
    if (parts[0] === "v") {
      const result = this.lastResult;
      if (parts.length !== 2 || parts[1] !== result?.detailToken || (result.workdir && result.workdir !== this.config.workdir)) return this.telegram.answerCallbackQuery(query.id, "이 결과의 파일 목록 버튼은 만료됐습니다. /files로 현재 프로젝트를 확인하세요.");
      await this.telegram.answerCallbackQuery(query.id, "이 프로젝트의 파일 목록을 확인합니다.");
      if (result.workdir && result.workdir !== this.config.workdir) return this.#send("프로젝트가 바뀌었습니다. /files로 현재 파일을 확인하세요.");
      return this.#handleCommand("/files");
    }
    if (parts[0] === "m") {
      const commands = { status: "/status", pending: "/pending", last: "/last", projects: "/projects", queue: "/queue", history: "/history", files: "/files", help: "/help" };
      if (parts.length !== 2 || !commands[parts[1]]) return;
      await this.telegram.answerCallbackQuery(query.id, "확인하겠습니다.");
      return this.#handleCommand(commands[parts[1]]);
    }
    if (parts[0] === "d") {
      const pending = parts.length === 2 && this.pendingCallbacks.get(parts[1]);
      if (!pending) return this.telegram.answerCallbackQuery(query.id, "처리되었거나 만료된 요청입니다.");
      const original = `${formatApproval(pending.method, pending.params, { full: true })}\n\n요청 원문:\n${JSON.stringify(pending.params, null, 2)}`;
      await this.telegram.answerCallbackQuery(query.id, "승인 요청 원문을 보내겠습니다.");
      return this.telegram.sendTextDocument(this.config.allowedChatId, original, "approval-details.txt", { disable_notification: true });
    }
    if (parts[0] === "r") {
      const result = this.lastResult;
      if (parts.length !== 2 || parts[1] !== result?.detailToken) {
        await this.telegram.answerCallbackQuery(query.id, "이 결과는 만료됐습니다. /last로 최근 결과를 확인하세요.");
        return;
      }
      await this.telegram.answerCallbackQuery(query.id, "전체 결과를 보내겠습니다.");
      await this.#sendDetail(result);
      return;
    }
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
    const allowed = pending.method === "item/permissions/requestApproval" ? ["grant", "deny"] : ["accept", "decline", "cancel"];
    const advertised = pending.method === "item/commandExecution/requestApproval" ? pending.params.availableDecisions : null;
    if (!allowed.includes(action) || (Array.isArray(advertised) && !advertised.includes(action))) {
      await this.telegram.answerCallbackQuery(query.id, "이 요청에 사용할 수 없는 버튼입니다.");
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
    try { this.appServer.respond(pending.rpcId, result); }
    catch {
      this.connectionState = "uncertain";
      await this.#removeKeyboards(pending);
      await this.telegram.answerCallbackQuery(query.id, "전달 여부를 확인하지 못했습니다. /reconnect를 사용하세요.");
      return;
    }
    await Promise.allSettled([
      this.telegram.answerCallbackQuery(query.id, action === "accept" || action === "grant" ? "허용했습니다." : "거부했습니다."),
      this.#removeKeyboards(pending),
    ]);
  }

  async #beginUserInput(rpcId, params) {
    if (!Array.isArray(params.questions) || params.questions.length === 0) {
      this.appServer.respondError(rpcId, -32602, "사용자 질문이 비어 있습니다.");
      return;
    }
    if (this.secretInputBlocked || params.questions.some((question) => question.isSecret)) {
      this.secretInputBlocked = true;
      this.appServer.respondError(rpcId, -32000, "Secret input is not supported through Telegram. Ask the user to configure it locally; do not request secret answers in chat.");
      await this.#send("🔒 민감한 입력이 필요한 질문은 Telegram으로 보내지 않았습니다.\nPC에서 필요한 값을 설정하세요. 설정 후 /cancel, /new 순서로 새 대화를 시작할 수 있습니다.");
      return;
    }
    if (this.pendingUserInput) {
      this.appServer.respondError(rpcId, -32000, "다른 사용자 입력 요청이 진행 중입니다.");
      return;
    }
    this.pendingUserInput = { rpcId, params, index: 0, answers: {}, messageIds: new Set(), questionReady: false };
    await this.#sendCurrentQuestion();
  }

  async #sendCurrentQuestion() {
    const pending = this.pendingUserInput;
    if (!pending) return;
    if (pending.sending?.index === pending.index) return pending.sending.promise;
    const delivery = { index: pending.index, promise: this.#deliverQuestion(pending, pending.index) };
    pending.sending = delivery;
    try { await delivery.promise; }
    finally { if (pending.sending === delivery) pending.sending = null; }
  }

  async #deliverQuestion(pending, index) {
    const question = pending.params.questions[index];
    const prefix = `❓ Codex 질문 ${index + 1}/${pending.params.questions.length}\n${question.question}`;
    if (question.options?.length) {
      const token = pending.optionToken || crypto.randomBytes(5).toString("hex");
      pending.optionToken = token;
      pending.optionValues = question.options.map((option) => option.label);
      const descriptions = question.options.map((option) =>
        `${option.label}${option.description ? ` — ${option.description}` : ""}`).join("\n");
      const sent = await this.telegram.sendMessage(this.config.allowedChatId,
        this.#withWorkdir(`${prefix}\n\n${descriptions}\n\n버튼을 누르거나 일반 메시지로 답하세요.`), {
        retry: true,
        reply_markup: {
          inline_keyboard: question.options.map((option, index) => [{
            text: option.label,
            callback_data: `q:${token}:${index}`,
          }]),
        },
      });
      if (this.pendingUserInput === pending && pending.optionToken === token) {
        pending.messageId = sent.message_id;
        pending.messageIds.add(sent.message_id);
      } else {
        await this.telegram.removeKeyboard(this.config.allowedChatId, sent.message_id).catch(() => {});
      }
    } else {
      const sent = await this.telegram.sendMessage(this.config.allowedChatId, this.#withWorkdir(`${prefix}\n\n답변을 일반 메시지로 보내세요.`), { retry: true });
      if (this.pendingUserInput === pending && pending.index === index) pending.messageIds.add(sent.message_id);
    }
    if (this.pendingUserInput === pending && pending.index === index) pending.questionReady = true;
  }

  async #handleQuestionOption(query, parts) {
    const pending = this.pendingUserInput;
    const index = Number(parts[2]);
    if (!pending || !pending.questionReady || parts[1] !== pending.optionToken || !Number.isInteger(index) || !pending.optionValues[index]) {
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
    pending.questionReady = false;
    pending.optionToken = null;
    pending.optionValues = null;
    void this.#removeKeyboards(pending);
    pending.messageId = null;
    pending.messageIds = new Set();
    if (pending.index < pending.params.questions.length) {
      await this.#sendCurrentQuestion();
      return;
    }
    this.pendingUserInput = null;
    try { this.appServer.respond(pending.rpcId, { answers: pending.answers }); }
    catch {
      this.connectionState = "uncertain";
      await this.#send("답변 전달 여부를 확인하지 못했습니다. /reconnect로 연결을 복구하세요.");
      return;
    }
    await this.#send("✅ 답변을 Codex에 전달했습니다.");
  }

  async #onNotification({ method, params }) {
    if (method === "serverRequest/resolved") {
      const cleanup = [];
      for (const [token, pending] of this.pendingCallbacks) {
        if (String(pending.rpcId) === String(params.requestId)) {
          this.pendingCallbacks.delete(token);
          cleanup.push(this.#removeKeyboards(pending));
        }
      }
      if (this.pendingUserInput && String(this.pendingUserInput.rpcId) === String(params.requestId)) {
        cleanup.push(this.#removeKeyboards(this.pendingUserInput));
        this.pendingUserInput = null;
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
        if (params.item.type === "fileChange") {
          this.itemDetails.set(params.item.id, params.item);
          if (this.itemDetails.size > 100) this.itemDetails.delete(this.itemDetails.keys().next().value);
        }
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
      const question = this.pendingUserInput;
      this.pendingUserInput = null;
      this.activeItems.clear();
      const cleanup = [];
      if (question) cleanup.push(this.#removeKeyboards(question));
      for (const [token, pending] of this.pendingCallbacks) {
        if (pending.params?.turnId === params.turn.id) {
          this.pendingCallbacks.delete(token);
          cleanup.push(this.#removeKeyboards(pending));
        }
      }
      const status = params.turn.status;
      const heading = status === "completed" ? "📩 Codex 응답 완료" : status === "interrupted" ? "⏹️ 작업 중단됨" : "❌ 작업 실패";
      const body = status === "failed"
        ? params.turn.error?.message || "알 수 없는 오류"
        : finalAgentMessage(params.turn, this.agentText);
      this.agentText = "";
      const durationMs = params.recovered ? null : this.now() - (this.turnStartedAt ?? this.startingAt ?? this.now());
      const text = `${heading}\n소요 시간: ${formatDuration(durationMs)}\n\n${body}`;
      // Save before delivery: /last can recover a result after a Telegram send failure.
      const result = { workdir: this.config.workdir, threadId: this.threadId, turnId: params.turn.id, heading, durationMs, text,
        detailToken: crypto.randomBytes(8).toString("hex") };
      this.lastResult = result;
      if (this.workspace) {
        try {
          if (!this.workspace.addResult(result)) this.#announce("이번 결과는 보관 크기 한도를 넘어 재시작 후 조회할 수 없습니다. 지금 /detail로 받으세요.");
        } catch { this.#announce("결과 기록을 저장하지 못했습니다. 현재 /detail로 받을 수 있습니다."); }
      }
      if (status !== "completed") this.queueEnabled = false;
      this.turnStartedAt = null;
      await Promise.allSettled(cleanup);
      try { await this.#sendResult(result); }
      finally { this.#scheduleNextTask(); }
    }
  }

  async #attachApprovalMessage(token, messageId) {
    const pending = this.pendingCallbacks.get(token);
    if (pending) {
      pending.messageId = messageId;
      pending.messageIds.add(messageId);
    }
    else await this.telegram.removeKeyboard(this.config.allowedChatId, messageId).catch(() => {});
  }

  #registerCallback(value) {
    for (const [token, pending] of this.pendingCallbacks) {
      if (pending.rpcId === value.rpcId) return token;
    }
    const token = crypto.randomBytes(6).toString("hex");
    this.pendingCallbacks.set(token, { ...value, messageIds: new Set() });
    return token;
  }

  #removeKeyboards(pending) {
    return Promise.allSettled([...pending.messageIds || []].map((id) =>
      this.telegram.removeKeyboard(this.config.allowedChatId, id)));
  }

  #clearPending() {
    for (const pending of this.pendingCallbacks.values()) void this.#removeKeyboards(pending);
    this.pendingCallbacks.clear();
    if (this.pendingUserInput) void this.#removeKeyboards(this.pendingUserInput);
    this.pendingUserInput = null;
    this.activeItems.clear();
  }

  #requireConnection() {
    if (this.connectionState !== "connected") {
      const error = new Error("Codex 연결 확인이 필요합니다. /reconnect를 먼저 사용하세요.");
      error.outcome = "rejected";
      throw error;
    }
  }

  async #taskRequest(method, params) {
    try { return await this.appServer.request(method, params); }
    catch (error) {
      if (error.outcome === "unknown") {
        this.queueEnabled = false;
        if (this.connectionState !== "disconnected") this.connectionState = "uncertain";
        this.#announce(this.#promptErrorText(error));
      }
      throw error;
    }
  }

  #promptErrorText(error) {
    return error.outcome === "unknown"
      ? "⚠️ 접수 여부를 확인하지 못했습니다. 같은 작업을 다시 보내지 말고 /reconnect로 상태를 복구하세요."
      : `작업을 접수하지 못했습니다.\n${error.message}`;
  }

  async #resendPending() {
    await this.nativeApprovals?.resend();
    if (this.connectionState !== "connected") return this.#send(this.#statusText());
    if (!this.pendingCallbacks.size && !this.pendingUserInput) {
      if (!this.nativeApprovals?.pending.size) await this.#send("지금 답변하거나 승인할 요청이 없습니다. /status로 작업 상태를 확인하세요.");
      return;
    }
    const deliveries = [...this.pendingCallbacks.keys()].map((token) => this.#sendApproval(token));
    if (this.pendingUserInput) deliveries.push(this.#sendCurrentQuestion());
    const results = await Promise.allSettled(deliveries);
    if (results.some((result) => result.status === "rejected")) {
      await this.#send("일부 요청을 보내지 못했습니다. 잠시 뒤 /pending을 다시 보내세요. 승인 결정은 전달하지 않았습니다.");
    }
  }

  async #reconnect() {
    this.queueEnabled = false;
    this.connectionState = "reconnecting";
    this.#clearPending();
    this.#announce("🔄 연결을 재설정하고 기존 대화 상태를 확인합니다. 진행 중 작업은 중단될 수 있으며 자동으로 재실행하지 않습니다.");
    try {
      await this.appServer.close();
      await this.appServer.start();
      const freshThread = !this.threadWasUsed;
      if (freshThread) await this.#createThread();
      else if (!this.threadId) await this.#loadOrCreateThread();
      else await this.appServer.request("thread/resume", {
        threadId: this.threadId, cwd: this.config.workdir, sandbox: this.config.sandbox,
        approvalPolicy: this.config.approvalPolicy, approvalsReviewer: "user",
        developerInstructions: BRIDGE_DEVELOPER_INSTRUCTIONS, excludeTurns: true,
      });
      const result = freshThread ? { data: [] } : await this.appServer.request("thread/turns/list", {
        threadId: this.threadId, limit: 1, sortDirection: "desc", itemsView: "full",
      });
      if (!Array.isArray(result.data)) throw new Error("최근 작업 상태를 읽지 못했습니다.");
      const turn = result.data[0];
      this.activeTurnId = null;
      if (turn?.status === "inProgress") this.#activateTurn(turn.id);
      else if (turn && turn.id !== this.lastResult?.turnId) {
        this.activeTurnId = turn.id;
        await this.#onNotification({ method: "turn/completed", params: { threadId: this.threadId, turn, recovered: true } })
          .catch(() => this.logger.error("복구된 결과 알림 전송 실패. /last로 조회할 수 있습니다."));
      }
      if (this.connectionState === "disconnected") throw new Error("연결이 다시 끊겼습니다.");
      this.connectionState = "connected";
      this.#announce(`✅ 연결을 복구했습니다.${freshThread ? " 입력 전의 빈 대화를 새로 준비했습니다." : ""}\n${this.#statusText()}\n이전 접수 번호가 미확인이면 /last로 결과를 확인하세요.`);
    } catch (error) {
      this.connectionState = "disconnected";
      throw error;
    }
  }

  #canReplyTo(messageId) {
    if (this.pendingUserInput) return this.pendingUserInput.questionReady && this.pendingUserInput.messageIds.has(messageId);
    const target = this.messageTargets.get(messageId);
    if (!target || target.threadId !== this.threadId) return false;
    if (this.activeTurnId) return target.turnId === this.activeTurnId;
    return !target.turnId || target.turnId === this.lastResult?.turnId;
  }

  #restoreResult() {
    const result = this.workspace?.results()[0];
    if (result) this.lastResult = { ...result, detailToken: crypto.randomBytes(8).toString("hex") };
  }

  #scheduleNextTask() {
    if (!this.taskQueue.length || !this.queueEnabled) return;
    void this.#enqueueInput(async () => {
      if (!this.queueEnabled || this.activeTurnId || this.startingAt !== null || this.connectionState !== "connected" || this.pendingUserInput || this.secretInputBlocked) return;
      const task = this.taskQueue.shift();
      if (!task) return;
      if (task.workdir !== this.config.workdir) { this.queueEnabled = false; this.taskQueue.unshift(task); return; }
      try { await this.#submitPrompt(task.text); }
      catch (error) { this.queueEnabled = false; await this.#send(`대기 작업 #${task.id}의 접수에 문제가 있어 대기열을 멈췄습니다.\n${this.#promptErrorText(error)}\n이 요청은 자동 재실행하지 않습니다.`); }
    });
  }

  async #workflowCommand(command, argument) {
    if (command === "/menu") {
      return this.telegram.sendMessage(this.config.allowedChatId, this.#withWorkdir("원하는 항목을 선택하세요."), {
        reply_markup: { inline_keyboard: [
          [{ text: "진행 상황", callback_data: "m:status" }, { text: "승인·질문", callback_data: "m:pending" }],
          [{ text: "최근 결과", callback_data: "m:last" }, { text: "결과 기록", callback_data: "m:history" }],
          [{ text: "프로젝트", callback_data: "m:projects" }, { text: "다음 작업", callback_data: "m:queue" }],
          [{ text: "산출물", callback_data: "m:files" }, { text: "도움말", callback_data: "m:help" }],
        ] },
      });
    }
    if (command === "/queue") {
      const [action, ...rest] = argument.split(/\s+/);
      if (action === "pause") this.queueEnabled = false;
      else if (action === "run") { this.queueEnabled = true; this.#scheduleNextTask(); }
      else if (action === "drop") {
        const index = this.taskQueue.findIndex((t) => t.id === rest[0]);
        if (index < 0) return this.#send("대기 작업 번호를 찾을 수 없습니다.");
        this.taskQueue.splice(index, 1);
      } else if (action === "add") {
        const prompt = argument.slice(4).trim();
        if (!prompt || prompt.length > 16_000 || this.taskQueue.length >= 10) return this.#send("/queue add 작업 내용 — 작업당 16,000자, 대기 최대 10건입니다.");
        if (this.secretInputBlocked) return this.#send("민감한 입력 차단 중에는 작업을 등록할 수 없습니다.");
        this.taskQueue.push({ id: crypto.randomBytes(3).toString("hex"), text: prompt, workdir: this.config.workdir });
        this.#scheduleNextTask();
      } else if (argument) return this.#send("/queue add 내용 · /queue pause · /queue run · /queue drop 번호");
      return this.#send(`다음 작업 ${this.queueEnabled ? "실행 가능" : "일시정지"}\n${this.taskQueue.map((t) => `#${t.id} · ${t.text.slice(0, 140)}`).join("\n") || "대기 작업이 없습니다."}\n\n/queue add 내용 — 별도 다음 작업\n/queue pause · /queue run · /queue drop 번호\n재시작하면 대기열은 사라지며 자동 재실행하지 않습니다.`);
    }
    if (!this.workspace) return this.#send("이 실행은 프로젝트/기록 저장을 사용하지 않습니다.");
    if (command === "/history") {
      if (argument === "clear") { this.workspace.clearHistory(); return this.#send("저장된 결과 기록을 삭제했습니다. 현재 메모리의 /last는 유지됩니다."); }
      const results = this.workspace.results();
      if (argument) {
        const index = Number(argument) - 1;
        if (!Number.isInteger(index) || !results[index]) return this.#send("/history 목록의 번호를 입력하세요.");
        const result = results[index];
        return this.telegram.sendTextDocument(this.config.allowedChatId, result.text, `result-${shortTaskId(result.workdir, result.threadId, result.turnId)}.txt`, { disable_notification: true });
      }
      return this.#send(`최근 결과 기록 (전체 최대 30건·7일)\n${results.map((r, i) => `${i + 1}. ${new Date(r.recordedAt).toLocaleString("ko-KR")} · ${r.heading}`).join("\n") || "기록이 없습니다."}\n/history 번호 — 원문 받기\n/history clear — 저장된 전체 결과 삭제`);
    }
    if (command === "/project") {
      return this.#enqueueInput(async () => {
        if (argument.startsWith("add ")) {
          const added = this.workspace.register(argument.slice(4).trim().replace(/^"|"$/g, ""));
          return this.#send(`${added.name} 프로젝트를 등록했습니다. /projects에서 번호를 확인하세요.`);
        }
        if (this.activeTurnId || this.startingAt !== null || this.taskQueue.length || this.pendingUserInput || this.pendingCallbacks.size) return this.#send("진행 중 작업·대기열·질문을 마친 뒤 프로젝트를 바꿀 수 있습니다.");
        if (argument.startsWith("remove ")) {
          const project = this.workspace.projects[Number(argument.slice(7)) - 1];
          if (!project) return this.#send("/projects에서 제거할 번호를 확인하세요.");
          this.workspace.remove(project.path);
          await this.nativeApprovals?.resend();
          return this.#send("프로젝트 등록과 해당 결과 기록을 제거했습니다. PC 승인 허용 범위는 /projects에서 확인하세요.");
        }
        const selected = this.workspace.projects[Number(argument) - 1];
        if (!selected) return this.#send("/projects에서 번호 확인 → /project 번호\n등록: /project add 절대경로");
        this.#requireConnection();
        this.workspace.select(selected.path);
        this.config.workdir = selected.path;
        this.threadId = null;
        this.threadWasUsed = true;
        this.lastResult = null;
        this.messageTargets.clear();
        this.itemDetails.clear();
        this.secretInputBlocked = false;
        try { await this.#loadOrCreateThread(); this.#restoreResult(); }
        catch (error) { this.connectionState = "disconnected"; throw error; }
        await this.#send("프로젝트를 바꿨습니다. 이 프로젝트의 작업과 기록을 사용합니다.");
      }).catch((error) => this.#send(`프로젝트를 변경하지 못했습니다. ${error.message}`));
    }
    return this.#send(`등록된 프로젝트\n${this.workspace.projects.map((p, i) => `${i + 1}. ${p.path === this.config.workdir ? "● " : ""}${p.name}\n   ${p.path}`).join("\n")}\n\n/project 번호 — 선택\n/project add 절대경로 — 등록\n/project remove 번호 — 등록·해당 기록 제거\n등록한 경로 안의 PC 승인 요청만 Telegram으로 전달됩니다.`);
  }

  async #sendResult(result) {
    const preview = resultPreview(result.text);
    const sent = await this.telegram.sendMessage(this.config.allowedChatId,
      this.#withWorkdir(preview.text, result.turnId, result.threadId, result.workdir || this.config.workdir), {
        reply_markup: { inline_keyboard: [[{ text: "📄 전체 원문", callback_data: `r:${result.detailToken}` }], [{ text: "📎 산출물", callback_data: `v:${result.detailToken}` }]] },
      });
    this.#rememberMessage(sent, result.threadId, result.turnId);
  }

  async #sendArtifact(workdir, relative) {
    const artifact = readArtifact(workdir, relative.replace(/^"|"$/g, ""));
    return this.telegram.sendDocument(this.config.allowedChatId, artifact.bytes, artifact.filename,
      { caption: `📎 ${projectName(workdir)} · ${artifact.filename}`, disable_notification: true });
  }

  async #sendDetail(result = this.lastResult) {
    if (!result) return this.#send("아직 조회할 결과가 없습니다. /last로 확인하세요.");
    try {
      const workdir = result.workdir || this.config.workdir;
      const id = shortTaskId(workdir, result.threadId, result.turnId);
      await this.telegram.sendTextDocument(this.config.allowedChatId, result.text, `codex-${id}.txt`,
        { caption: `📄 ${projectName(workdir)} · #${id} 전체 결과`, disable_notification: true });
    } catch {
      await this.#send("전체 결과 파일을 보내지 못했습니다. 잠시 뒤 /detail을 다시 보내세요. 최근 결과는 현재 브리지 메모리에 보관되어 있습니다.");
    }
  }

  #rememberMessage(sent, threadId = this.threadId, turnId = this.activeTurnId) {
    if (!sent?.message_id) return;
    this.messageTargets.set(sent.message_id, { threadId, turnId });
    if (this.messageTargets.size > 200) this.messageTargets.delete(this.messageTargets.keys().next().value);
  }

  async #send(text) {
    const threadId = this.threadId;
    const turnId = this.activeTurnId;
    const sent = await this.telegram.sendMessage(this.config.allowedChatId, this.#withWorkdir(text));
    this.#rememberMessage(sent, threadId, turnId);
    return sent;
  }

  #announce(text) {
    // An accepted Codex request stays accepted even if its Telegram receipt fails or stalls.
    void this.#send(text).catch((error) => this.logger.error("작업 접수 알림 전송 실패", error));
  }

  #withWorkdir(text, turnId = this.activeTurnId, threadId = this.threadId, workdir = this.config.workdir) {
    const id = turnId ? ` · #${shortTaskId(workdir, threadId, turnId)}` : "";
    const scope = workdir === this.config.workdir ? "원격 제어 · 현재 프로젝트에 전달" : "이전 프로젝트 결과 · 후속 지시 전에 프로젝트를 선택하세요";
    return `📂 ${projectName(workdir)}${id}\n${scope}\n\n${text}`;
  }
}
