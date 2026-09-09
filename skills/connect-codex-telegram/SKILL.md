---
name: connect-codex-telegram
description: Install, configure, verify, and troubleshoot a private Telegram front end for a local Codex CLI/app-server, including Telegram commands, streamed completion results, command/file/permission approval buttons, and Codex follow-up questions. Use when a user asks to control Codex from Telegram, reproduce the Telegram–Codex bridge on another Windows PC, configure BotFather tokens or chat IDs, diagnose bridge startup or Telegram Bot API errors, or package this integration for another person.
---

# Connect Codex to Telegram

Build from the bundled bridge template instead of recreating the JSON-RPC client. Keep all secrets local and preserve least-privilege defaults.

## Workflow

1. Confirm the intended host is a trusted personal machine and identify one explicit project directory for `CODEX_WORKDIR`.
2. Check `node --version`, `codex --version` or `codex.cmd --version`, and Codex login status without reading or displaying auth files.
3. Install the bundled template into a new directory:

   ```powershell
   python <skill-dir>\scripts\install_bridge.py D:\telegram-codex-bridge
   ```

   On POSIX, pass a POSIX destination. Refuse to overwrite an existing non-empty directory; inspect and patch existing installations instead.
4. Tell the user to create a bot with the verified Telegram `@BotFather`. Never ask them to paste the token into chat. Have them enter it directly in the installed `.env`.
5. Have the user message the new bot with `/start`, then discover the numeric chat ID:

   ```powershell
   npm.cmd run discover:chat-id
   ```

6. Set `ALLOWED_CHAT_ID` to that numeric ID and `CODEX_WORKDIR` to an existing, narrowly scoped project directory. Do not use a drive root, home directory, or broad workspace unless the user explicitly requests and understands the scope.
7. Validate without exposing the token:

   ```powershell
   python <skill-dir>\scripts\validate_env.py <bridge-dir>\.env
   npm.cmd run check
   npm.cmd test
   npm.cmd run smoke:app-server
   ```

8. Start in a persistent user-owned terminal with `start.cmd` on Windows or `npm start` on POSIX. Only create a background service or scheduled task when explicitly requested.
9. Verify `/help`, `/status`, and one read-only prompt before allowing file modifications.
10. When the user wants completion alerts for Codex tasks started outside Telegram, configure the global `notify` hook while preserving any existing notifier:

    ```powershell
    python <skill-dir>\scripts\configure_codex_notify.py <bridge-dir>
    ```

    Explain that official `notify` currently covers `agent-turn-complete` only. Full remote approvals and questions require starting the work through the Telegram bridge.
11. Create or update `STOT.md` using `references/stot-template.md` after material setup or troubleshooting work. Record paths, versions, tests, decisions, and next actions; never record tokens, Codex auth, or secret answers.

## Safety invariants

- Keep `CODEX_SANDBOX` at `read-only` or `workspace-write`; reject `danger-full-access`.
- Keep `CODEX_APPROVAL_POLICY` at `untrusted` or `on-request`; reject `never`.
- Route approvals to the user and do not expose session-wide approval in the Telegram UI.
- Accept messages and callback queries only from `ALLOWED_CHAT_ID`.
- Acquire the bundled singleton lock before creating Telegram or app-server clients; a second process for the same bot must exit before polling.
- Grant only the permissions Codex requested and scope them to the current turn.
- Never expose `codex app-server` on a public interface. The bundled bridge uses stdio and Telegram long polling.
- Never print, quote, commit, archive, or copy `.env`, `.state.json`, Codex auth files, bot tokens, or bridge logs into the Skill.
- Treat Telegram bot chats as non-E2E-encrypted. Do not collect API keys, passwords, recovery codes, or other secrets through Codex questions.
- Preserve user changes when updating an existing bridge. Read the relevant files and patch narrowly.

## Implementation map

- `assets/telegram-codex-bridge/`: secret-free bridge template to copy into a new installation.
- `scripts/install_bridge.py`: deterministic, non-overwriting installer.
- `scripts/validate_env.py`: redacted `.env` validator.
- `scripts/configure_codex_notify.py`: preserve the existing global notifier and add Telegram turn-complete delivery.
- `references/architecture.md`: event flow and app-server request mapping. Read when modifying bridge behavior.
- `references/troubleshooting.md`: known Windows, Telegram, and Codex failure modes. Read when setup or startup fails.
- When changing task tracking or input handling, use the recovery and delivery regression cases in `references/troubleshooting.md`. The template includes `/pending`, explicit `/reconnect`, and PC receipts with `codex-tg.cmd --status`.
- `references/stot-template.md`: durable project-history template. Read when asked to remember or hand off work.

## Completion report

Report the installed path, selected `CODEX_WORKDIR`, redacted configuration status, test results, app-server smoke result, and the exact next user action. State clearly when actual Telegram verification remains blocked on a locally entered token or `/start` message.
