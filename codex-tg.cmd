@echo off
setlocal
cd /d "%~dp0"
node scripts\codex-tg.mjs %*
