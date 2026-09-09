const MAX_MESSAGE_LENGTH = 4000;

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
  constructor(token, { fetchImpl = fetch, logger = console } = {}) {
    this.baseUrl = `https://api.telegram.org/bot${token}`;
    this.fetch = fetchImpl;
    this.logger = logger;
    this.offset = 0;
    this.stopped = false;
  }

  async call(method, body = {}, { signal } = {}) {
    const response = await this.fetch(`${this.baseUrl}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    const payload = await response.json();
    if (!response.ok || !payload.ok) {
      throw new Error(`Telegram ${method} 실패: ${payload.description || response.status}`);
    }
    return payload.result;
  }

  async sendMessage(chatId, text, options = {}) {
    const chunks = splitTelegramText(text);
    let result;
    for (let index = 0; index < chunks.length; index += 1) {
      result = await this.call("sendMessage", {
        chat_id: chatId,
        text: chunks[index],
        disable_web_page_preview: true,
        ...(index === chunks.length - 1 ? options : {}),
      });
    }
    return result;
  }

  answerCallbackQuery(callbackQueryId, text) {
    return this.call("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      text,
    });
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
          this.offset = update.update_id + 1;
          await handler(update);
        }
      } catch (error) {
        if (this.stopped) break;
        this.logger.error(error.message);
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  }
}

