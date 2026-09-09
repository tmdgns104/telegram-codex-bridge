import crypto from "node:crypto";
import net from "node:net";

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_PROMPT_LENGTH = 16_000;

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
  socket.end(`${JSON.stringify(value)}\n`);
}

export class LocalControlServer {
  constructor({ token, chatId, onPrompt, port, logger = console }) {
    this.key = deriveLocalControlKey(token, chatId);
    this.port = port ?? deriveLocalControlPort(token, chatId);
    this.onPrompt = onPrompt;
    this.logger = logger;
    this.server = null;
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
    return new Promise((resolve) => {
      if (!server?.listening) return resolve();
      server.close(() => resolve());
    });
  }

  #handleConnection(socket) {
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
    if (!keysEqual(request.key, this.key)) {
      writeResponse(socket, { ok: false, error: "Unauthorized local request." });
      return;
    }
    if (request.action !== "prompt") {
      writeResponse(socket, { ok: false, error: "Unsupported action." });
      return;
    }
    const text = typeof request.text === "string" ? request.text.trim() : "";
    if (!text || text.length > MAX_PROMPT_LENGTH) {
      writeResponse(socket, { ok: false, error: `Prompt must contain 1-${MAX_PROMPT_LENGTH} characters.` });
      return;
    }
    try {
      const result = await this.onPrompt(text);
      writeResponse(socket, { ok: true, ...result });
    } catch (error) {
      writeResponse(socket, { ok: false, error: error.message });
    }
  }
}

export function sendLocalPrompt({ token, chatId, text, port, timeoutMs = 5_000 }) {
  const selectedPort = port ?? deriveLocalControlPort(token, chatId);
  const request = JSON.stringify({
    action: "prompt",
    key: deriveLocalControlKey(token, chatId),
    text,
  });

  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port: selectedPort });
    let response = "";
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("Telegram Codex Bridge did not respond in time."));
    }, timeoutMs);

    const finish = (callback) => {
      clearTimeout(timeout);
      callback();
    };
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`${request}\n`));
    socket.on("data", (chunk) => { response += chunk; });
    socket.once("error", (error) => finish(() => reject(new Error(`Cannot connect to Telegram Codex Bridge: ${error.message}`))));
    socket.once("end", () => finish(() => {
      try {
        const result = JSON.parse(response.trim());
        if (!result.ok) reject(new Error(result.error || "Local request failed."));
        else resolve(result);
      } catch (error) {
        reject(new Error(`Invalid bridge response: ${error.message}`));
      }
    }));
  });
}
