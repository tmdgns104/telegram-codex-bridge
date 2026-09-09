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
5. Persist the selected registered project, project thread IDs and bounded result history in the Git-ignored workspace store. Never persist approval payloads or the execution queue.

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

## Recovery and PC receipts

The loopback interface keeps the legacy `prompt` action and adds authenticated `hello`,
`submit`, and `status`. A submit carries a bridge instance ID and request ID. The receipt
is returned before Codex replies; it then becomes accepted, rejected, or unknown. Records
are memory-only and bounded. They describe acceptance, not final task completion.

Telegram `/pending` sends pending approvals/questions again using the same request identity.
Every known keyboard copy expires when the request resolves. Secret question batches are
rejected before display; subsequent text is blocked until a fresh conversation.

Transport deadlines do not impose a turn execution limit. `/reconnect` explicitly closes
the owned app-server, resumes the thread, and reads the latest turn. It never starts a
previous prompt again. A known unused in-memory thread may be replaced with a fresh empty
thread because no user work was submitted. Receipt/result bodies are not added to the
thread-ID state file.

## Global completion notifications

Codex's global `notify` command receives one JSON argument for supported events, currently `agent-turn-complete`. The bundled router preserves the previous notifier and calls the Python bridge notifier. That entrypoint passes UTF-8 stdin to `scripts/notify.mjs`, sharing `TelegramClient` and the result formatter. The bridge marks its app-server child environment with `TELEGRAM_CODEX_BRIDGE_CHILD=1` so Telegram-originated work is not reported twice.

The completion notify hook does not carry approval responses or follow-up questions. A separate synchronous PermissionRequest hook forwards supported native PC approvals through the existing authenticated loopback to the same Telegram poller. It returns the native hook decision contract only after a one-time user decision. Do not resume or clone an independently running PC thread to intercept approval. Native conversation questions are outside this hook contract.

PC notifications use a neutral response-arrived label: a completed turn is not a verified successful task.
Title/recap-only JSON has no reliable provenance discriminator, so it is shown silently with its original
JSON attached, not discarded. Long responses have a bounded excerpt and an in-memory generated UTF-8
document. No arbitrary artifact paths are opened. Notification IDs are stable hashes of workdir/thread/turn.
Attempt deduplication stores only hashes/timestamps for up to 1,000 events within 24 hours, with a short
OS-released loopback lock serializing the disk transaction. Expired/evicted or unidentified events are outside
this guarantee. Ambiguous deliveries are not replayed; use the original PC conversation for the result.

Bridge results expose an expiring full-result button and `/detail`, with project-filtered `/history` backed by at most 30 results, seven days and four MB. Individual results above 256 KB remain memory-only without truncating their originals. Message replies
must match the current thread/turn, and the identity is rechecked when queued input executes. During a
question, only replies to delivered question messages are consumed as answers. Unknown, notification-only,
old-session, and stale-task replies cannot silently start or steer the current task.

## Native approvals and workspace interaction

`scripts/permission-hook.mjs` accepts only required PermissionRequest fields via UTF-8 stdin. It never reads the transcript.
The native broker binds random callback tokens to live requests for up to five minutes and limits outstanding requests to 32.
Only registered canonical project roots are eligible. Expiry, missing bridge, invalid input, recognized credentials, or failed
delivery returns no hook decision and preserves the host's normal approval flow. The hook installer preserves other handlers
and never sets hook trust. An allow from this handler cannot override a deny from another handler.

`/queue add` differs from ordinary steering: it creates the next independent turn, up to ten queued tasks. Failure, cancellation
or uncertain connection pauses the queue. Queue contents are not replayed after restart. Project switching is allowed only
without active work, queued tasks or pending prompts; thread IDs and results are restored per project.

Attachments download at most ten MB into a generated project inbox name, with a 100 MB retention cap and cleanup after a day
when new input arrives. Image/audio use native local input types; documents are passed as paths to read, not executed.
Artifact downloads require the user's `/file` command or selected `/files` button, stay within the project, and reject hidden
configuration, unsupported executable types and links. Result-text downloads are a separate path.
