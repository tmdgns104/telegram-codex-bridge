const MAX_MESSAGE_LENGTH = 4000;

export class TelegramApiError extends Error {
  constructor(method, { code, retryAfter = 0, retryable = false } = {}) {
    super(`Telegram ${method} 전송 실패${code ? ` (${code})` : ""}. 연결을 확인한 뒤 다시 시도하세요.`);
    this.code = code;
    this.retryAfter = retryAfter;
    this.retryable = retryable;
  }
}

function wait(ms, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

export function splitTelegramText(text, maxLength = MAX_MESSAGE_LENGTH) {
  const source = String(text || "(내용 없음)");
  if (source.length <= maxLength) return [source];

  const chunks = [];
  let remaining = source;
  while (remaining.length > maxLength) {
    let cut = remaining.lastIndexOf("\n", maxLength);
    if (cut < Math.floor(maxLength * 0.5)) cut = maxLength;
    if (/[\uD800-\uDBFF]/.test(remaining[cut - 1]) && /[\uDC00-\uDFFF]/.test(remaining[cut])) cut -= 1;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^\n/, "");
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

export class TelegramClient {
  constructor(token, { fetchImpl = fetch, logger = console, requestTimeoutMs = 10_000,
    maxRetries = 2, sleepImpl = wait } = {}) {
    this.baseUrl = `https://api.telegram.org/bot${token}`;
    this.fileBaseUrl = `https://api.telegram.org/file/bot${token}`;
    this.fetch = fetchImpl;
    this.logger = logger;
    this.offset = 0;
    this.stopped = false;
    this.requestTimeoutMs = requestTimeoutMs;
    this.maxRetries = maxRetries;
    this.sleep = sleepImpl;
    this.stopController = new AbortController();
  }

  async call(method, body = {}, { signal, retry = false } = {}) {
    const lifecycle = this.stopController.signal;
    const attempts = retry ? this.maxRetries + 1 : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const controller = new AbortController();
      const abort = () => controller.abort();
      lifecycle.addEventListener("abort", abort, { once: true });
      signal?.addEventListener("abort", abort, { once: true });
      if (lifecycle.aborted || signal?.aborted) controller.abort();
      const timeoutMs = method === "getUpdates" ? (body.timeout || 0) * 1000 + this.requestTimeoutMs : this.requestTimeoutMs;
      const timer = setTimeout(abort, timeoutMs);
      let failure;
      try {
        const multipart = body instanceof FormData;
        const response = await this.fetch(`${this.baseUrl}/${method}`, {
          method: "POST", ...(multipart ? {} : { headers: { "content-type": "application/json" } }),
          body: multipart ? body : JSON.stringify(body), signal: controller.signal,
        });
        const payload = await response.json();
        if (!response.ok || !payload.ok) {
          const code = payload.error_code || response.status;
          throw new TelegramApiError(method, {
            code, retryAfter: Number(payload.parameters?.retry_after) || 0,
            retryable: code === 429 || code >= 500,
          });
        }
        return payload.result;
      } catch (error) {
        // Fetch errors can contain the token-bearing URL; expose only a safe summary.
        failure = error instanceof TelegramApiError ? error : new TelegramApiError(method, { retryable: true });
      } finally {
        clearTimeout(timer);
        lifecycle.removeEventListener("abort", abort);
        signal?.removeEventListener("abort", abort);
      }
      if (lifecycle.aborted || signal?.aborted || !failure.retryable || attempt + 1 === attempts || failure.retryAfter > 30) throw failure;
      const delay = Math.max(500 * 2 ** attempt, failure.retryAfter * 1000);
      await this.sleep(delay, lifecycle);
    }
  }

  async sendMessage(chatId, text, options = {}) {
    const { retry = false, ...messageOptions } = options;
    const chunks = splitTelegramText(text);
    let result;
    for (let index = 0; index < chunks.length; index += 1) {
      result = await this.call("sendMessage", {
        chat_id: chatId,
        text: chunks[index],
        disable_web_page_preview: true,
        ...(index === chunks.length - 1 ? messageOptions : {}),
      }, { retry });
    }
    return result;
  }

  answerCallbackQuery(callbackQueryId, text) {
    return this.call("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      text,
    });
  }

  sendTextDocument(chatId, text, filename, options = {}) {
    return this.sendDocument(chatId, new Blob([text], { type: "text/plain;charset=utf-8" }), filename, options);
  }

  sendDocument(chatId, content, filename, options = {}) {
    const form = new FormData();
    form.set("chat_id", String(chatId));
    form.set("document", content instanceof Blob ? content : new Blob([content]), filename);
    for (const [key, value] of Object.entries(options)) form.set(key, String(value));
    return this.call("sendDocument", form);
  }

  async downloadFile(fileId, maxBytes) {
    const info = await this.call("getFile", { file_id: fileId });
    if (typeof info.file_path !== "string" || !/^[a-zA-Z0-9_./-]+$/.test(info.file_path) || info.file_path.split("/").includes("..") || info.file_path.startsWith("/") || info.file_size > maxBytes) {
      throw new Error("첨부 파일 경로 또는 크기를 확인할 수 없습니다.");
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    this.stopController.signal.addEventListener("abort", abort, { once: true });
    if (this.stopped) controller.abort();
    const timer = setTimeout(abort, this.requestTimeoutMs);
    try {
      const response = await this.fetch(`${this.fileBaseUrl}/${info.file_path}`, { signal: controller.signal, redirect: "error" });
      if (!response.ok || Number(response.headers.get("content-length")) > maxBytes) throw new Error("download failed");
      const chunks = [];
      let total = 0;
      for await (const chunk of response.body) {
        total += chunk.length;
        if (total > maxBytes) { controller.abort(); throw new Error("oversized"); }
        chunks.push(chunk);
      }
      return Buffer.concat(chunks, total);
    } catch { throw new Error("첨부를 받지 못했습니다. 10MB 이하 파일인지 확인하고 다시 보내세요."); }
    finally { clearTimeout(timer); this.stopController.signal.removeEventListener("abort", abort); }
  }

  removeKeyboard(chatId, messageId) {
    return this.call("editMessageReplyMarkup", {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: [] },
    });
  }

  stop() {
    this.stopped = true;
    this.stopController.abort();
  }

  async poll(handler, timeoutSeconds = 30) {
    while (!this.stopped) {
      try {
        const updates = await this.call("getUpdates", {
          offset: this.offset,
          timeout: timeoutSeconds,
          allowed_updates: ["message", "callback_query"],
        });
        for (const update of updates) {
          if (this.stopped) break;
          this.offset = update.update_id + 1;
          await handler(update);
        }
      } catch (error) {
        if (this.stopped) break;
        this.logger.error(error.message);
        await this.sleep(2000, this.stopController.signal);
      }
    }
  }
}
