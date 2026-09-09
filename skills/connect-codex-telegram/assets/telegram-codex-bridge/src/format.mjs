export function clip(value, max = 1200) {
  const text = String(value ?? "");
  if (text.length <= max) return text;
  const cut = /[\uD800-\uDBFF]/.test(text[max - 1]) ? max - 1 : max;
  return `${text.slice(0, cut)}\n…(생략)`;
}

export function formatDuration(milliseconds) {
  if (typeof milliseconds !== "number" || !Number.isFinite(milliseconds)) return "확인 불가";
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds}초`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}분 ${seconds % 60}초`;
  return `${Math.floor(minutes / 60)}시간 ${minutes % 60}분`;
}

function formatReason(value) {
  const reason = String(value ?? "");
  if (/command failed.*retry (with)?out sandbox/i.test(reason)) {
    return "샌드박스 안에서 명령이 실패하여 같은 명령을 샌드박스 밖에서 한 번 재시도하려고 합니다.";
  }
  return reason;
}

export function formatApproval(method, params, { full = false } = {}) {
  const reason = params.reason ? `\n\n이유: ${clip(formatReason(params.reason), 600)}` : "";
  if (method === "item/commandExecution/requestApproval") {
    const network = params.networkApprovalContext;
    if (network) {
      return `🌐 네트워크 접근 승인 요청\n\n대상: ${network.protocol}://${network.host}${reason}`;
    }
    const extra = params.additionalPermissions ? `\n추가 접근 범위:\n${JSON.stringify(params.additionalPermissions, null, 2)}` : "";
    return `⚠️ 명령 실행 승인 요청\n\n명령:\n${full ? params.command || "(명령 정보 없음)" : clip(params.command || "(명령 정보 없음)")}\n\n위치: ${params.cwd || "(알 수 없음)"}${reason}${full ? extra : clip(extra, 700)}`;
  }
  if (method === "item/fileChange/requestApproval") {
    const changes = Array.isArray(params.changes) ? params.changes : [];
    const details = changes.map((change) => `${change.path || "(경로 미제공)"} · ${typeof change.kind === "object" ? change.kind.type : change.kind || "변경"}\n${change.diff || "(차이 미제공)"}`).join("\n\n");
    return `📝 파일 변경 승인 요청${reason}\n\n${details ? (full ? details : clip(details, 1700)) : "변경 파일·차이를 제공받지 못했습니다. 승인 전에 PC에서 확인하세요."}${params.grantRoot ? `\n쓰기 허용 경로: ${params.grantRoot}` : ""}`;
  }
  if (method === "item/permissions/requestApproval") {
    return `🔐 추가 권한 승인 요청\n\n위치: ${params.cwd}\n요청: ${clip(JSON.stringify(params.permissions, null, 2))}${reason}`;
  }
  return `승인 요청: ${method}${reason}`;
}

export function finalAgentMessage(turn, fallback = "") {
  const items = Array.isArray(turn?.items) ? turn.items : [];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.type === "agentMessage" && item.text) return item.text;
  }
  return fallback || "Codex 작업이 완료되었습니다.";
}
