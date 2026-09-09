import { loadDotEnv } from "../src/config.mjs";

loadDotEnv();
const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
if (!token) {
  console.error(".env에 TELEGRAM_BOT_TOKEN을 먼저 설정하세요.");
  process.exit(1);
}

const response = await fetch(`https://api.telegram.org/bot${token}/getUpdates`);
const payload = await response.json();
if (!payload.ok) throw new Error(payload.description || "getUpdates 실패");

const chats = new Map();
for (const update of payload.result) {
  const chat = update.message?.chat || update.callback_query?.message?.chat;
  if (chat) chats.set(String(chat.id), chat);
}
if (!chats.size) {
  console.log("메시지가 없습니다. Telegram에서 봇에게 /start를 보낸 뒤 다시 실행하세요.");
} else {
  for (const [id, chat] of chats) {
    console.log(`chat_id=${id}  name=${chat.first_name || chat.title || "(이름 없음)"}`);
  }
}

