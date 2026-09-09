import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import readline from "node:readline";

export class AppServerRequestError extends Error {
  constructor(message, { code = "DISCONNECTED", outcome = "unknown" } = {}) {
    super(message);
    this.code = code;
    this.outcome = outcome;
  }
}

function terminateProcess(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Codex 프로세스 종료를 확인하지 못했습니다.")), 5_000);
    child.once("close", () => { clearTimeout(timer); resolve(); });
    // The owned Windows .cmd process has a Codex descendant; stop that tree only.
    if (process.platform === "win32") {
      const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true, stdio: "ignore",
      });
      killer.once("error", () => { clearTimeout(timer); reject(new Error("Codex 프로세스를 종료하지 못했습니다.")); });
    } else {
      child.stdin.end();
      child.kill("SIGTERM");
    }
  });
}

export class AppServerClient extends EventEmitter {
  constructor({ codexBin = process.platform === "win32" ? "codex.cmd" : "codex", logger = console,
    requestTimeoutMs = 30_000, spawnImpl = spawn, terminateImpl = terminateProcess } = {}) {
    super();
    this.codexBin = codexBin;
    this.logger = logger;
    this.requestTimeoutMs = requestTimeoutMs;
    this.spawn = spawnImpl;
    this.terminate = terminateImpl;
    this.nextId = 1;
    this.pending = new Map();
    this.process = null;
    this.closing = null;
    this.disconnected = false;
  }

  async start() {
    if (this.closing) await this.closing;
    if (this.process) return;
    const isWindows = process.platform === "win32";
    if (isWindows && /[\s&|<>^%"]/.test(this.codexBin)) {
      throw new Error("Windows의 CODEX_BIN에는 공백이나 셸 특수문자를 사용할 수 없습니다. 기본값 codex.cmd를 권장합니다.");
    }
    const command = isWindows ? (process.env.ComSpec || "cmd.exe") : this.codexBin;
    const args = isWindows ? ["/d", "/s", "/c", `${this.codexBin} app-server --listen stdio://`]
      : ["app-server", "--listen", "stdio://"];
    const child = this.spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
      env: { ...process.env, TELEGRAM_CODEX_BRIDGE_CHILD: "1" },
    });
    this.process = child;
    this.disconnected = false;
    child.on("error", () => this.#disconnected(child));
    child.on("exit", () => this.#disconnected(child));
    child.stdin.on("error", () => this.#disconnected(child));
    readline.createInterface({ input: child.stdout }).on("line", (line) => {
      if (this.process !== child || this.disconnected || !line.trim()) return;
      let message;
      try { message = JSON.parse(line); }
      catch { this.logger.error("app-server 응답 형식 오류 (원문 생략)"); return; }
      this.#handleMessage(message);
    });
    readline.createInterface({ input: child.stderr }).on("line", (line) => {
      if (line.trim()) this.logger.error(`[codex] ${line}`);
    });
    try {
      await this.request("initialize", {
        clientInfo: { name: "telegram_codex_bridge", title: "Telegram Codex Bridge", version: "0.1.0" },
        capabilities: { experimentalApi: true, mcpServerOpenaiFormElicitation: false },
      });
      this.notify("initialized");
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  request(method, params = {}) {
    if (this.disconnected || !this.process?.stdin?.writable) {
      return Promise.reject(new AppServerRequestError("Codex 연결이 없습니다. /reconnect로 연결하세요.", { outcome: "rejected" }));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AppServerRequestError("Codex 응답 시간이 초과되어 접수 여부를 확인하지 못했습니다.", { code: "REQUEST_TIMEOUT" }));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      try { this.#write({ id, method, params }); }
      catch {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new AppServerRequestError("Codex에 요청을 전달했는지 확인하지 못했습니다."));
      }
    });
  }

  notify(method, params) { this.#write(params === undefined ? { method } : { method, params }); }
  respond(id, result) { this.#write({ id, result }); }
  respondError(id, code, message) { this.#write({ id, error: { code, message } }); }

  close() {
    if (this.closing) return this.closing;
    const child = this.process;
    this.process = null;
    this.#rejectPending(new AppServerRequestError("Codex 연결을 종료했습니다. 이전 요청은 자동 재실행하지 않습니다."));
    if (!child) return Promise.resolve();
    this.closing = this.terminate(child).then(() => { this.closing = null; });
    return this.closing;
  }

  #write(message) {
    if (this.disconnected || !this.process?.stdin?.writable) throw new AppServerRequestError("Codex 연결이 끊겼습니다.");
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #handleMessage(message) {
    if (Object.hasOwn(message, "id") && (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"))) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new AppServerRequestError(`${pending.method}: ${message.error.message || "Codex가 요청을 거절했습니다."}`,
          { code: message.error.code, outcome: "rejected" }));
      } else pending.resolve(message.result);
      return;
    }
    if (Object.hasOwn(message, "id") && message.method) this.emit("request", message);
    else if (message.method) this.emit("notification", message);
  }

  #rejectPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  #disconnected(child) {
    if (this.process !== child || this.disconnected) return;
    this.disconnected = true;
    const error = new AppServerRequestError("Codex 연결이 끊겼습니다. /reconnect로 상태를 복구하세요.");
    this.#rejectPending(error);
    this.emit("fatal", error);
    // Keep the owned process until close() confirms termination before reconnecting.
  }
}
