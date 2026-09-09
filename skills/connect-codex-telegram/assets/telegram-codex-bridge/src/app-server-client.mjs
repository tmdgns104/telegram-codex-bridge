import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import readline from "node:readline";

export class AppServerClient extends EventEmitter {
  constructor({ codexBin = process.platform === "win32" ? "codex.cmd" : "codex", logger = console } = {}) {
    super();
    this.codexBin = codexBin;
    this.logger = logger;
    this.nextId = 1;
    this.pending = new Map();
    this.process = null;
  }

  async start() {
    if (this.process) return;
    const isWindows = process.platform === "win32";
    if (isWindows && /[\s&|<>^%"]/.test(this.codexBin)) {
      throw new Error("Windows의 CODEX_BIN에는 공백이나 셸 특수문자를 사용할 수 없습니다. 기본값 codex.cmd를 권장합니다.");
    }
    const command = isWindows ? (process.env.ComSpec || "cmd.exe") : this.codexBin;
    const args = isWindows
      ? ["/d", "/s", "/c", `${this.codexBin} app-server --listen stdio://`]
      : ["app-server", "--listen", "stdio://"];
    this.process = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, TELEGRAM_CODEX_BRIDGE_CHILD: "1" },
    });

    this.process.on("error", (error) => this.#stopWithError(error));
    this.process.on("exit", (code, signal) => {
      if (code !== 0 && code !== null) {
        this.#stopWithError(new Error(`codex app-server 종료: code=${code}, signal=${signal}`));
      }
      this.emit("exit", { code, signal });
    });

    readline.createInterface({ input: this.process.stdout }).on("line", (line) => {
      if (!line.trim()) return;
      try {
        this.#handleMessage(JSON.parse(line));
      } catch (error) {
        this.logger.error("app-server JSON 파싱 실패", error, line);
      }
    });
    readline.createInterface({ input: this.process.stderr }).on("line", (line) => {
      if (line.trim()) this.logger.error(`[codex] ${line}`);
    });

    await this.request("initialize", {
      clientInfo: {
        name: "telegram_codex_bridge",
        title: "Telegram Codex Bridge",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
        mcpServerOpenaiFormElicitation: false,
      },
    });
    this.notify("initialized");
  }

  request(method, params = {}) {
    if (!this.process?.stdin?.writable) return Promise.reject(new Error("app-server가 실행 중이 아닙니다."));
    const id = this.nextId++;
    this.#write({ id, method, params });
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject, method }));
  }

  notify(method, params) {
    const message = { method };
    if (params !== undefined) message.params = params;
    this.#write(message);
  }

  respond(id, result) {
    this.#write({ id, result });
  }

  respondError(id, code, message) {
    this.#write({ id, error: { code, message } });
  }

  close() {
    if (this.process && !this.process.killed) this.process.kill();
    this.process = null;
  }

  #write(message) {
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #handleMessage(message) {
    if (Object.hasOwn(message, "id") && (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"))) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(`${pending.method}: ${message.error.message || JSON.stringify(message.error)}`));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (Object.hasOwn(message, "id") && message.method) {
      this.emit("request", message);
      return;
    }
    if (message.method) this.emit("notification", message);
  }

  #stopWithError(error) {
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
    this.emit("fatal", error);
  }
}
