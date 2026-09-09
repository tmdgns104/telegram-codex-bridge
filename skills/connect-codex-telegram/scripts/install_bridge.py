#!/usr/bin/env python3
"""Install the bundled Telegram–Codex bridge without overwriting user files."""

from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("destination", type=Path, help="New bridge directory")
    parser.add_argument("--dry-run", action="store_true", help="Validate without copying")
    args = parser.parse_args()

    source = Path(__file__).resolve().parent.parent / "assets" / "telegram-codex-bridge"
    destination = args.destination.expanduser().resolve()
    if not source.is_dir():
        print(f"Template not found: {source}", file=sys.stderr)
        return 2
    if destination.exists() and any(destination.iterdir() if destination.is_dir() else [destination]):
        print(f"Refusing to overwrite non-empty destination: {destination}", file=sys.stderr)
        return 3

    if args.dry_run:
        print(f"Would install {source} -> {destination}")
        return 0

    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        shutil.copytree(source, destination, dirs_exist_ok=True)
    else:
        shutil.copytree(source, destination)

    codex_bin = "codex.cmd" if sys.platform == "win32" else "codex"
    env_text = (
        "# Enter secrets locally. Never commit this file.\n"
        "TELEGRAM_BOT_TOKEN=\n"
        "ALLOWED_CHAT_ID=\n"
        "CODEX_WORKDIR=\n\n"
        f"CODEX_BIN={codex_bin}\n"
        "CODEX_SANDBOX=workspace-write\n"
        "CODEX_APPROVAL_POLICY=on-request\n"
        "TELEGRAM_POLL_TIMEOUT_SECONDS=30\n"
    )
    (destination / ".env").write_text(env_text, encoding="utf-8")
    print(f"Installed bridge: {destination}")
    print(f"Configure secrets locally: {destination / '.env'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
