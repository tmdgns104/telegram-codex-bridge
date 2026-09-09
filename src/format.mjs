export function clip(value, max = 1200) {
  const text = String(value ?? "");
  return text.length <= max ? text : `${text.slice(0, max)}\n…(생략)`;
}

export function formatDuration(milliseconds) {
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

export function formatApproval(method, params) {
  const reason = params.reason ? `\n\n이유: ${clip(formatReason(params.reason), 600)}` : "";
  if (method === "item/commandExecution/requestApproval") {
    const network = params.networkApprovalContext;
    if (network) {
      return `🌐 네트워크 접근 승인 요청\n\n대상: ${network.protocol}://${network.host}${reason}`;
    }
    return `⚠️ 명령 실행 승인 요청\n\n명령:\n${clip(params.command || "(명령 정보 없음)")}\n\n위치: ${params.cwd || "(알 수 없음)"}${reason}`;
  }
  if (method === "item/fileChange/requestApproval") {
    return `📝 파일 변경 승인 요청${reason || "\n\nCodex가 파일을 변경하려고 합니다."}`;
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
