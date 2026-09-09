#!/usr/bin/env python3
"""Validate bridge .env structure without printing secret values."""

from __future__ import annotations

import argparse
import re
from pathlib import Path


TOKEN_PATTERN = re.compile(r"^\d{6,}:[A-Za-z0-9_-]{20,}$")
CHAT_PATTERN = re.compile(r"^-?\d+$")


def parse_env(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for raw_line in path.read_text(encoding="utf-8-sig").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("env_file", type=Path)
    args = parser.parse_args()
    path = args.env_file.expanduser().resolve()
    if not path.is_file():
        print(f"FAIL env file missing: {path}")
        return 2

    values = parse_env(path)
    token_ok = bool(TOKEN_PATTERN.fullmatch(values.get("TELEGRAM_BOT_TOKEN", "")))
    chat_ok = bool(CHAT_PATTERN.fullmatch(values.get("ALLOWED_CHAT_ID", "")))
    workdir_text = values.get("CODEX_WORKDIR", "")
    workdir = Path(workdir_text).expanduser() if workdir_text else None
    workdir_ok = bool(workdir and workdir.is_absolute() and workdir.is_dir())
    sandbox_ok = values.get("CODEX_SANDBOX", "workspace-write") in {"read-only", "workspace-write"}
    approval_ok = values.get("CODEX_APPROVAL_POLICY", "on-request") in {"untrusted", "on-request"}

    checks = {
        "token_format": token_ok,
        "allowed_chat_id": chat_ok,
        "workdir_exists": workdir_ok,
        "safe_sandbox": sandbox_ok,
        "safe_approval_policy": approval_ok,
    }
    for name, ok in checks.items():
        print(f"{'PASS' if ok else 'FAIL'} {name}")
    return 0 if all(checks.values()) else 1


if __name__ == "__main__":
    raise SystemExit(main())
