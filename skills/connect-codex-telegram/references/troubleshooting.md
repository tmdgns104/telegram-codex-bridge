# Troubleshooting

## Task tracking and concurrent input

- Separate bridge receipt, Codex acceptance, and task completion. A response timeout after submission is an unknown outcome. Block new mutations until explicit recovery; never retry a Codex turn implicitly.
- Namespace receipt deduplication by bridge instance and request ID. An automatic transport retry must keep both IDs; reject stale instances. Bound in-memory records without evicting IDs that could then execute again. Do not claim deduplication across process restarts or new user submissions.
- Reject secret-marked question batches before displaying any question. Do not echo the question body in the rejection. Block subsequent text until the user deliberately starts a new conversation; arbitrary secret detection is not guaranteed.
- Keep status queries responsive while RPCs await replies. Consume answers only after the current question was delivered, so fast follow-up text cannot answer an unseen next question.
- Reconnect is a deliberate operation that may interrupt work: confirm termination of the owned app-server process before starting its replacement. Preserve unknown acceptance and expire callbacks from the old connection. On Windows a .cmd wrapper can own a descendant process; terminate only that owned tree.
- Codex ephemeral threads do not support paginated turn history, and a newly created persistent thread may not have stored history before its first message. Do not infer a usable recovery fixture from thread/start alone. On a verified compatible CLI, the bundled `smoke:app-server -- --recovery` materializes synthetic history via `thread/inject_items`, checks close/start/resume, and archives the fixture without a model turn. Never inject test items into a user thread. Confirm method strings from the generated ClientRequest mapping, not schema type filenames.
- Treat Codex request acceptance and Telegram notification delivery as separate outcomes. A failed or delayed receipt must not make an accepted prompt look rejected and invite duplicate submission.
- Serialize prompt and thread-changing commands across input channels. Keep status queries responsive while a start request is pending, and let a failed queue entry release the next entry. Do not replay ambiguous requests automatically.
- Apply item events only to the current thread and turn. Test completion before the start response, duplicate completion, and delayed events; a completed turn must not become active again.
- Keep the latest completion result in memory before sending it so `/last` can recover a missed delivery. Document that restart clears it; do not add prompt/result persistence to the thread-ID state file implicitly.
- Consume a question option before awaiting Telegram I/O. Remove old buttons after text answers, resolution, and completion, including when resolution overtakes message delivery.
- Verify with a fake app-server that holds/releases responses and a fake Telegram client that delays/rejects sends. Assert RPC counts and state transitions, then run focused tests against the pre-fix source when available. Real Telegram delivery requires its own authorized end-to-end check.
- Bound retries for transient delivery errors, and respect Telegram's [`retry_after`](https://core.telegram.org/bots/api#responseparameters). Do not repeatedly retry permanent errors or hold the user interface for a long server-requested delay; keep `/pending` available for later recovery.

## Telegram

- `.env에 TELEGRAM_BOT_TOKEN을 먼저 설정하세요`: enter the complete BotFather token locally in `.env`.
- `메시지가 없습니다`: open the new bot and send `/start`, then run discovery again.
- `Error: Not Found`: the token is malformed or incomplete. A valid shape starts with digits, contains one colon, then a long URL-safe secret. Never print the actual token while diagnosing.
- `Unauthorized`: revoke and issue a fresh token in BotFather, then update `.env` locally.
- `Conflict: terminated by other getUpdates request`: another bridge or discovery process is polling the same bot, or a webhook is active. Stop the duplicate process or remove the webhook before retrying.
- `Telegram Codex Bridge가 이미 실행 중입니다`: the singleton lock is working. Keep the existing process and do not retry in a loop.
- Telegram sends no completion: confirm the allowed numeric chat ID, inspect redacted configuration, and keep the host awake.

## Windows and Codex

- PowerShell blocks `codex.ps1`: use `codex.cmd` and set `CODEX_BIN=codex.cmd`.
- `CODEX_WORKDIR 디렉터리를 찾을 수 없습니다`: use an existing absolute project path, not a Telegram name or relative label.
- `fetch failed` with `EACCES`: the execution sandbox blocked outbound Telegram HTTPS. Request scoped network approval or run from the trusted user terminal.
- app-server handshake fails: run `codex.cmd --version`, confirm Codex login, then run `npm.cmd run smoke:app-server`.
- `spawn EINVAL` for `.cmd`: on Windows launch the `.cmd` through `cmd.exe /d /s /c`; the bundled client implements this and rejects shell metacharacters in `CODEX_BIN`.
- A background process disappears when an automation command ends: run `start.cmd` in a persistent user terminal. Create a scheduled task or service only with explicit user authorization.

## Validation sequence

```powershell
python <skill-dir>\scripts\validate_env.py <bridge-dir>\.env
cd <bridge-dir>
npm.cmd run check
npm.cmd test
npm.cmd run smoke:app-server
start.cmd
```

Verify `/help` first, then send a prompt that explicitly forbids edits. Change `CODEX_WORKDIR` to the real repository only after this passes.

## Global notify hook

- Preserve an existing `notify` command instead of replacing it. The configuration script writes a timestamped backup and a local `codex-notify-chain.json`.
- Restart or open a new Codex CLI session after changing global `config.toml`; an already running session may not reload it.
- Direct CLI work gets completion notifications only. Use the Telegram bridge for remote approvals, questions, and cancellation.
- If Telegram-originated work produces duplicate completion messages, confirm the app-server child receives `TELEGRAM_CODEX_BRIDGE_CHILD=1` and restart the bridge after updating it.
