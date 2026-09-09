# Architecture reference

## Components

```text
Telegram Bot API (long polling)
        ↕
TelegramClient + CodexTelegramBridge
        ↕ JSONL / JSON-RPC over stdio
local codex app-server
        ↕
selected CODEX_WORKDIR
```

The bridge starts `codex app-server --listen stdio://`. Do not replace this with a public WebSocket listener for a personal setup.

Before creating either client, derive a loopback singleton port from the Bot token and allowed chat ID and bind it exclusively. The token is hashed and never logged. A second process with the same bot configuration receives `EADDRINUSE` and exits before Telegram polling or app-server startup. The operating system releases the lock automatically when the owning process exits.

## Lifecycle

1. Send `initialize`, then `initialized` once per app-server connection.
2. Resume the stored thread ID or call `thread/start` with `cwd`, sandbox, approval policy, and user reviewer.
3. Send user text through `turn/start`; use `turn/steer` when a compatible turn is active.
4. Accumulate `item/agentMessage/delta` as a fallback and prefer the last `agentMessage` in `turn/completed`.
5. Persist only the thread ID. Never persist approval payloads or secrets.

## Server request mapping

| app-server request | Telegram interaction | response |
|---|---|---|
| `item/commandExecution/requestApproval` | accept once / decline / cancel | `{decision}` |
| `item/fileChange/requestApproval` | accept once / decline / cancel | `{decision}` |
| `item/permissions/requestApproval` | grant for turn / deny | requested subset or empty permissions |
| `item/tool/requestUserInput` | option buttons or a text reply | answer map keyed by question ID |

Use short random callback tokens instead of embedding commands or paths in Telegram callback data. Map each token to one pending JSON-RPC request in memory, verify `ALLOWED_CHAT_ID`, consume it once, and clear it when `serverRequest/resolved` or `turn/completed` arrives.

## Safe configuration

Use `workspace-write` plus `on-request` for a coding bridge, or `read-only` for initial verification. Do not accept `danger-full-access` or `never` in configuration validation. Do not expose `acceptForSession` in the personal Telegram UI.

## Global completion notifications

Codex's global `notify` command receives one JSON argument for supported events, currently `agent-turn-complete`. The bundled router calls any previously configured notifier first, then calls the bridge Telegram notifier. The bridge marks its app-server child environment with `TELEGRAM_CODEX_BRIDGE_CHILD=1` so Telegram-originated work is not reported twice.

This global hook does not carry approval responses or follow-up questions. Start unattended work through the Telegram bridge when remote interaction is required.
