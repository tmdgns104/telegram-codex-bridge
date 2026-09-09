#!/usr/bin/env python3
"""Keep the legacy notify argv contract; share presentation with the Node bridge."""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path


def main() -> int:
    if os.environ.get("TELEGRAM_CODEX_BRIDGE_CHILD") == "1" or len(sys.argv) < 2:
        return 0
    script = Path(__file__).resolve().with_name("notify.mjs")
    flags = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
    try:
        result = subprocess.run(
            ["node", str(script)], input=sys.argv[-1].encode("utf-8"),
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            timeout=15, creationflags=flags, check=False,
        )
        return result.returncode
    except (OSError, subprocess.TimeoutExpired):
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
