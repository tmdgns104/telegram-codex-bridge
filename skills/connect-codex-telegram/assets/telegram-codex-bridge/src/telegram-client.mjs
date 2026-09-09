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
    const form = new FormData();
    form.set("chat_id", String(chatId));
    // Generated text only: never open a model-provided file path.
    form.set("document", new Blob([text], { type: "text/plain;charset=utf-8" }), filename);
    for (const [key, value] of Object.entries(options)) form.set(key, String(value));
    return this.call("sendDocument", form);
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
