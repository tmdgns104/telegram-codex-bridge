import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

for (const directory of ["src", "scripts"]) {
  for (const name of fs.readdirSync(directory).filter((name) => name.endsWith(".mjs"))) {
    const result = spawnSync(process.execPath, ["--check", path.join(directory, name)], { stdio: "inherit", windowsHide: true });
    if (result.status !== 0) process.exit(result.status || 1);
  }
}
const python = spawnSync(process.env.PYTHON || "python", ["-m", "py_compile", "scripts/codex-telegram-notify.py"], { stdio: "inherit", windowsHide: true });
process.exitCode = python.status || (python.error ? 1 : 0);
