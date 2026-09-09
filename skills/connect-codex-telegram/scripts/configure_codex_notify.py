#!/usr/bin/env python3
"""Chain an existing Codex notify command with the bridge Telegram notifier."""

from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
from datetime import datetime
from pathlib import Path

try:
    import tomllib
except ImportError:  # pragma: no cover
    tomllib = None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("bridge_dir", type=Path)
    parser.add_argument("--config", type=Path, default=Path.home() / ".codex" / "config.toml")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    bridge = args.bridge_dir.expanduser().resolve()
    config = args.config.expanduser().resolve()
    router = bridge / "scripts" / "codex-notify-router.py"
    telegram = bridge / "scripts" / "codex-telegram-notify.py"
    chain_path = bridge / "codex-notify-chain.json"
    if not router.is_file() or not telegram.is_file():
        print("Bridge notification scripts are missing.", file=sys.stderr)
        return 2

    text = config.read_text(encoding="utf-8-sig") if config.exists() else ""
    parsed = tomllib.loads(text) if text and tomllib else {}
    existing = parsed.get("notify") if isinstance(parsed.get("notify"), list) else []
    existing = [str(value) for value in existing]

    if any(Path(value).name.lower() == "codex-notify-router.py" for value in existing):
        try:
            prior = json.loads(chain_path.read_text(encoding="utf-8"))
            existing = [str(value) for value in prior.get("existing", [])]
        except Exception:
            existing = []

    chain = {"existing": existing, "telegram_script": str(telegram)}
    notify_value = [sys.executable, str(router), str(chain_path)]
    notify_line = "notify = " + json.dumps(notify_value, ensure_ascii=False)
    pattern = re.compile(r"(?m)^\s*notify\s*=\s*\[[^\r\n]*\]\s*$")
    if pattern.search(text):
        updated = pattern.sub(lambda _match: notify_line, text, count=1)
    else:
        updated = notify_line + "\n" + text

    print("Existing notifier preserved:", bool(existing))
    print("Telegram notifier:", telegram)
    print("Codex config:", config)
    if args.dry_run:
        return 0

    config.parent.mkdir(parents=True, exist_ok=True)
    if config.exists():
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        backup = config.with_name(f"{config.name}.bak-telegram-{stamp}")
        shutil.copy2(config, backup)
        print("Backup:", backup)
    chain_path.write_text(json.dumps(chain, ensure_ascii=False, indent=2), encoding="utf-8")
    config.write_text(updated, encoding="utf-8")
    print("Codex notify hook configured.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
