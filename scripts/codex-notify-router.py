#!/usr/bin/env python3
"""Preserve an existing Codex notify command and add Telegram notification."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


def run_quiet(command: list[str]) -> None:
    if not command:
        return
    flags = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
    try:
        subprocess.run(command, check=False, timeout=20, creationflags=flags)
    except Exception:
        pass


def main() -> int:
    if len(sys.argv) < 3:
        return 0
    try:
        chain = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    except Exception:
        chain = {}
    payload = sys.argv[2]
    existing = chain.get("existing") or []
    if existing:
        run_quiet([*existing, payload])
    telegram_script = chain.get("telegram_script")
    if telegram_script:
        run_quiet([sys.executable, telegram_script, payload])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
