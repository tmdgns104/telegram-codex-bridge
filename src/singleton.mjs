import crypto from "node:crypto";
import net from "node:net";

export function deriveSingletonPort(token, chatId) {
  const digest = crypto.createHash("sha256").update(`${token}\0${chatId}`).digest();
  return 40000 + (digest.readUInt16BE(0) % 20000);
}

export function acquireSingleton({ token, chatId, port } = {}) {
  const selectedPort = port ?? deriveSingletonPort(token, chatId);
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", (error) => {
      const message = error.code === "EADDRINUSE"
        ? "Telegram Codex Bridge가 이미 실행 중입니다. 두 번째 프로세스를 종료합니다."
        : `단일 실행 잠금을 만들 수 없습니다: ${error.message}`;
      const wrapped = new Error(message, { cause: error });
      wrapped.code = error.code === "EADDRINUSE" ? "BRIDGE_ALREADY_RUNNING" : error.code;
      reject(wrapped);
    });
    server.listen({ host: "127.0.0.1", port: selectedPort, exclusive: true }, () => {
      const address = server.address();
      resolve({
        port: typeof address === "object" && address ? address.port : selectedPort,
        close: () => new Promise((closeResolve) => {
          if (!server.listening) return closeResolve();
          server.close(() => closeResolve());
        }),
      });
    });
  });
}
