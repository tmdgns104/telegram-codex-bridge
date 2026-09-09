#!/usr/bin/env python3
"""Send a redacted Codex turn-complete notification through this bridge's bot."""

from __future__ import annotations

import json
import os
import sys
import urllib.request
from pathlib import Path


def load_env(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for raw_line in path.read_text(encoding="utf-8-sig").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def chunks(text: str, size: int = 3900) -> list[str]:
    return [text[index:index + size] for index in range(0, len(text), size)] or ["(내용 없음)"]


def main() -> int:
    if os.environ.get("TELEGRAM_CODEX_BRIDGE_CHILD") == "1" or len(sys.argv) < 2:
        return 0
    try:
        event = json.loads(sys.argv[-1])
        if event.get("type") != "agent-turn-complete":
            return 0
        env = load_env(Path(__file__).resolve().parent.parent / ".env")
        token = env.get("TELEGRAM_BOT_TOKEN", "")
        chat_id = env.get("ALLOWED_CHAT_ID", "")
        if not token or not chat_id:
            return 0
        cwd = event.get("cwd") or "(경로 정보 없음)"
        result = event.get("last-assistant-message") or "Codex turn이 완료되었습니다."
        message = f"✅ PC Codex 작업 완료\n\n경로: {cwd}\n\n{result}"
        url = f"https://api.telegram.org/bot{token}/sendMessage"
        for part in chunks(message):
            request = urllib.request.Request(
                url,
                data=json.dumps({"chat_id": chat_id, "text": part, "disable_web_page_preview": True}).encode("utf-8"),
                headers={"content-type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(request, timeout=10):
                pass
    except Exception:
        return 0
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
