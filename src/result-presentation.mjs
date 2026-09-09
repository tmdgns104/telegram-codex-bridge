import crypto from "node:crypto";

const PREVIEW_LIMIT = 1100;
const ATTENTION = /실패|미검증|미완료|검토.{0,12}(필요|대기)|승인.{0,12}(필요|대기)|확인 필요|아직|차단|not[_ -](qualified|ready|verified)|human.{0,24}(required|pending)|\b(blocked|unverified|failed)\b/i;

export function projectName(workdir) {
  const parts = String(workdir || "").replaceAll("\\", "/").split("/").filter(Boolean);
  return parts.at(-1) || "프로젝트 미확인";
}

export function shortTaskId(...parts) {
  return crypto.createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 10);
}

export function metadataShape(text) {
  try {
    const value = JSON.parse(text);
    if (!value || Array.isArray(value) || typeof value !== "object") return null;
    const keys = Object.keys(value);
    return keys.length === 1 && ["title", "recap"].includes(keys[0]) && typeof value[keys[0]] === "string"
      ? { kind: keys[0], value: value[keys[0]] } : null;
  } catch { return null; }
}

function mobileLine(line) {
  if (/^\s*\|(?:\s*:?-+:?\s*\|)+\s*$/.test(line)) return "";
  if (/^\s*```/.test(line)) return line.trim() === "```" ? "" : "[코드: 전체 원문 참고]";
  if (line.trim().startsWith("|") && line.trim().endsWith("|")) {
    line = line.trim().slice(1, -1).split("|").map((cell) => cell.trim()).join(" · ");
  }
  return line
    .replace(/:codex-file-citation\{[^}]*\}/g, "[파일 참조: PC에서 확인]")
    .replace(/\[([^\]]+)\]\(<?\/?(?:[a-zA-Z]:[\\/]|\/\/wsl\.)[^)]*\)/g, "$1 (PC에서 확인)")
    .replace(/\[([^\]]+)\]\(<?(https?:\/\/[^>\s)]+)>?\)/g, "$1: $2")
    .replace(/^#{1,6}\s+/, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1");
}

function fitLine(text, max) {
  const points = Array.from(text);
  if (points.length <= max) return text;
  const prefix = points.slice(0, max - 1).join("");
  const space = prefix.lastIndexOf(" ");
  return `${space > max / 2 ? prefix.slice(0, space) : prefix}…`;
}

// This is an excerpt, not a generated semantic summary. Always retain the original separately.
export function resultPreview(original) {
  const text = String(original || "(응답 본문 없음)");
  const normalized = text.split(/\r?\n/).map(mobileLine);
  const mobile = normalized.join("\n");
  if (mobile.length <= PREVIEW_LIMIT && normalized.length <= 14) {
    return { text: mobile, needsDetail: mobile !== text };
  }
  const nonempty = normalized.filter((line) => line.trim());
  const opening = nonempty.slice(0, 4).map((line) => fitLine(line, 140));
  const attention = nonempty.slice(4).filter((line) => ATTENTION.test(line)).slice(0, 3)
    .map((line) => fitLine(line, 125));
  const excerpt = ["본문 발췌", ...opening];
  if (attention.length) excerpt.push("", "확인 관련 원문", ...attention);
  excerpt.push("", "일부만 표시했습니다. 전체 결과에서 문맥과 나머지 내용을 확인하세요.");
  let preview = excerpt.join("\n");
  if (preview.length > PREVIEW_LIMIT) preview = Array.from(preview).slice(0, 520).join("") + "\n… 전체 결과를 확인하세요.";
  return { text: preview, needsDetail: true };
}

export function notificationPresentation(event) {
  const body = String(event["last-assistant-message"] || "(응답 본문 없음)");
  const workdir = String(event.cwd || "");
  const id = shortTaskId(workdir, event["thread-id"] || "", event["turn-id"] || crypto.randomUUID());
  const metadata = metadataShape(body);
  const preview = resultPreview(metadata ? `${metadata.kind === "title" ? "제목" : "요약"}: ${metadata.value}` : body);
  const heading = metadata ? "ℹ️ PC 참고 응답" : "📩 PC 응답 도착";
  const text = [heading, `📂 ${projectName(workdir)} · #${id}`,
    "알림 전용 · 후속 지시는 PC에서", "", preview.text].join("\n");
  return { id, text, body, quiet: Boolean(metadata), needsDetail: Boolean(metadata) || preview.needsDetail,
    filename: `codex-${id}.txt` };
}
