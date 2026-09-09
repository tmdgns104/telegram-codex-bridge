import crypto from "node:crypto";
import net from "node:net";

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_PROMPT_LENGTH = 16_000;
const REQUEST_ID = /^[a-zA-Z0-9_-]{8,80}$/;

function digest(token, chatId) {
  return crypto.createHash("sha256").update(`local-control\0${token}\0${chatId}`).digest();
}

export function deriveLocalControlPort(token, chatId) {
  return 20_000 + (digest(token, chatId).readUInt16BE(0) % 20_000);
}

export function deriveLocalControlKey(token, chatId) {
  return digest(token, chatId).toString("base64url");
}

function keysEqual(actual, expected) {
  const actualHash = crypto.createHash("sha256").update(String(actual || "")).digest();
  const expectedHash = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(actualHash, expectedHash);
}

function writeResponse(socket, value) {
  if (!socket.destroyed && socket.writable) socket.end(`${JSON.stringify(value)}\n`);
}

export class LocalControlServer {
  constructor({ token, chatId, onPrompt, onPermission, port, logger = console, maxReceipts = 1000 }) {
    this.key = deriveLocalControlKey(token, chatId);
    this.port = port ?? deriveLocalControlPort(token, chatId);
    this.onPrompt = onPrompt;
    this.onPermission = onPermission;
    this.logger = logger;
    this.server = null;
    this.instanceId = crypto.randomUUID();
    this.receipts = new Map();
    this.latestRequestId = null;
    this.maxReceipts = maxReceipts;
    this.sockets = new Set();
  }

  start() {
    if (this.server) throw new Error("Local control server is already running.");
    const server = net.createServer((socket) => this.#handleConnection(socket));
    this.server = server;
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen({ host: "127.0.0.1", port: this.port, exclusive: true }, () => {
        server.off("error", reject);
        server.on("error", (error) => this.logger.error("Local control server error", error));
        const address = server.address();
        if (typeof address === "object" && address) this.port = address.port;
        resolve({ port: this.port });
      });
    });
  }

  close() {
    const server = this.server;
    this.server = null;
    for (const socket of this.sockets) socket.destroy();
    return new Promise((resolve) => {
      if (!server?.listening) return resolve();
      server.close(() => resolve());
    });
  }

  #handleConnection(socket) {
    this.sockets.add(socket);
    socket.once("close", () => this.sockets.delete(socket));
    socket.setEncoding("utf8");
    socket.setTimeout(10_000, () => writeResponse(socket, { ok: false, error: "Request timed out." }));
    let buffer = "";
    let handled = false;

    socket.on("data", (chunk) => {
      if (handled) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > MAX_REQUEST_BYTES) {
        handled = true;
        writeResponse(socket, { ok: false, error: "Request is too large." });
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      handled = true;
      socket.setTimeout(0);
      void this.#handleRequest(socket, buffer.slice(0, newline));
    });
    socket.on("error", (error) => this.logger.error("Local control connection error", error));
  }

  async #handleRequest(socket, line) {
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      writeResponse(socket, { ok: false, error: "Invalid JSON request." });
      return;
    }
    if (!request || typeof request !== "object" || !keysEqual(request.key, this.key)) {
      writeResponse(socket, { ok: false, error: "Unauthorized local request." });
      return;
    }
    if (request.action === "hello") {
      writeResponse(socket, { ok: true, instanceId: this.instanceId, version: "0.2.0", nativeApprovals: Boolean(this.onPermission) });
      return;
    }
    if (request.action === "permission") {
      if (!this.onPermission) return writeResponse(socket, { ok: true, decision: "fallback" });
      const controller = new AbortController();
      const abort = () => controller.abort();
      socket.once("close", abort);
      try {
        const result = await this.onPermission(request.event, controller.signal);
        writeResponse(socket, { ok: true, ...result });
      } catch { writeResponse(socket, { ok: true, decision: "fallback", reason: "invalid_request" }); }
      finally { socket.off("close", abort); }
      return;
    }
    if (request.action === "status") {
      const id = request.requestId || this.latestRequestId;
      const receipt = this.receipts.get(id);
      writeResponse(socket, receipt ? { ok: true, ...this.#publicReceipt(receipt) } : {
        ok: true, status: "not_found", requestId: id || null,
        message: "이 브리지에 접수 기록이 없습니다. 재시작 전 요청일 수 있으므로 Telegram의 /status, /last로 확인하세요. 자동 재실행하지 않습니다.",
      });
      return;
    }
    if (request.action !== "prompt" && request.action !== "submit") {
      writeResponse(socket, { ok: false, error: "Unsupported action." });
      return;
    }
    const text = typeof request.text === "string" ? request.text.trim() : "";
    if (!text || text.length > MAX_PROMPT_LENGTH) {
      writeResponse(socket, { ok: false, error: `Prompt must contain 1-${MAX_PROMPT_LENGTH} characters.` });
      return;
    }
    if (request.action === "submit") {
      if (request.instanceId !== this.instanceId) {
        writeResponse(socket, { ok: false, code: "STALE_INSTANCE", error: "브리지가 재시작됐습니다. 이전 작업을 재실행하지 않았습니다. Telegram /status, /last로 먼저 확인하세요." });
        return;
      }
      if (!REQUEST_ID.test(request.requestId || "")) {
        writeResponse(socket, { ok: false, error: "유효한 접수 번호가 필요합니다." });
        return;
      }
      const fingerprint = crypto.createHash("sha256").update(text).digest("hex");
      const existing = this.receipts.get(request.requestId);
      if (existing) {
        writeResponse(socket, existing.fingerprint === fingerprint
          ? { ok: true, ...this.#publicReceipt(existing) }
          : { ok: false, error: "같은 접수 번호에 다른 작업을 보낼 수 없습니다." });
        return;
      }
      if (this.receipts.size >= this.maxReceipts) {
        writeResponse(socket, { ok: false, error: "접수 기록 한도에 도달했습니다. 진행 중 작업을 마친 뒤 브리지를 재시작하세요." });
        return;
      }
      const receipt = { requestId: request.requestId, fingerprint, status: "received",
        message: "브리지가 요청을 받았습니다. Codex 접수 확인 중입니다. 같은 작업을 다시 보내지 마세요." };
      this.receipts.set(receipt.requestId, receipt);
      this.latestRequestId = receipt.requestId;
      writeResponse(socket, { ok: true, ...this.#publicReceipt(receipt) });
      // A receipt acknowledges bridge ownership; it does not claim Codex accepted the task.
      void this.#runPrompt(receipt, text);
      return;
    }
    try {
      const result = await this.onPrompt(text);
      writeResponse(socket, { ok: true, ...result });
    } catch (error) {
      writeResponse(socket, { ok: false, error: error.message });
    }
  }

  #publicReceipt(receipt) {
    return { requestId: receipt.requestId, status: receipt.status, mode: receipt.mode, message: receipt.message };
  }

  async #runPrompt(receipt, text) {
    try {
      const result = await this.onPrompt(text);
      receipt.status = "accepted";
      receipt.mode = result?.mode;
      receipt.message = result?.message || "Codex에 전달했습니다. 결과는 Telegram에서 확인하세요.";
    } catch (error) {
      receipt.status = error.outcome === "unknown" ? "unknown" : "rejected";
      receipt.message = error.outcome === "unknown"
        ? "Codex 접수 여부를 확인하지 못했습니다. 같은 작업을 다시 보내지 말고 Telegram /reconnect로 상태를 복구하세요."
        : `접수하지 못했습니다. ${error.message}`;
    }
  }
}

export function sendLocalPrompt({ token, chatId, text, port, timeoutMs = 5_000 }) {
  return sendLocalRequest({ token, chatId, port, timeoutMs, request: { action: "prompt", text } });
}

export async function submitLocalTask({ token, chatId, text, port, timeoutMs = 5_000, requestId = crypto.randomUUID() }) {
  const connection = { token, chatId, port, timeoutMs };
  const { instanceId } = await sendLocalRequest({ ...connection, request: { action: "hello" } });
  const request = { action: "submit", requestId, instanceId, text };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try { return await sendLocalRequest({ ...connection, request }); }
    catch (error) {
      if (!error.transport || attempt === 1) {
        error.requestId = requestId;
        throw error;
      }
      // Retry the same receipt and instance, never a new task after an ambiguous delivery.
    }
  }
}

export function getLocalTask({ token, chatId, requestId, port, timeoutMs = 5_000 }) {
  return sendLocalRequest({ token, chatId, port, timeoutMs, request: { action: "status", requestId } });
}

export function sendLocalRequest({ token, chatId, request, port, timeoutMs = 5000 }) {
  const selectedPort = port ?? deriveLocalControlPort(token, chatId);
  const payload = JSON.stringify({
    ...request,
    key: deriveLocalControlKey(token, chatId),
  });

  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port: selectedPort });
    let response = "";
    const timeout = setTimeout(() => {
      socket.destroy();
      const error = new Error("브리지 응답을 확인하지 못했습니다. 작업이 접수됐을 수 있습니다.");
      error.transport = true;
      reject(error);
    }, timeoutMs);

    const finish = (callback) => {
      clearTimeout(timeout);
      callback();
    };
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`${payload}\n`));
    socket.on("data", (chunk) => {
      response += chunk;
      if (Buffer.byteLength(response, "utf8") > MAX_REQUEST_BYTES) socket.destroy(new Error("브리지 응답이 너무 큽니다."));
    });
    socket.once("error", () => finish(() => {
      const error = new Error("브리지에 연결할 수 없습니다. PC에서 start.cmd가 실행 중인지 확인하세요.");
      error.transport = true;
      reject(error);
    }));
    socket.once("end", () => finish(() => {
      try {
        const result = JSON.parse(response.trim());
        if (!result.ok) {
          const error = new Error(result.error || "요청을 처리하지 못했습니다.");
          error.code = result.code;
          reject(error);
        }
        else resolve(result);
      } catch (error) {
        const failure = new Error("브리지 접수 응답을 확인하지 못했습니다.");
        failure.transport = true;
        reject(failure);
      }
    }));
  });
}
