# TASK-002 Verification — 2026-09-09

Baseline: `0e18843715996005ea9c35b54893714ffdc2ef31`.
Environment: Windows, Node v24.15.0, codex-cli 0.153.4.

## Observed checks

| Check | Result | Evidence |
|---|---|---|
| `npm.cmd run check` | exit 0 | check.txt |
| `npm.cmd test` | 61/61 PASS, exit 0 | tests.txt |
| `npm.cmd run smoke:app-server` | handshake + ephemeral read-only thread PASS | smoke.txt (local only) |
| `npm.cmd run smoke:app-server -- --recovery` | synthetic history → list → close/start → resume → archive PASS | smoke-recovery-local.txt (local only) |
| Local and global skill validator | valid | actual tool result |
| Skill installation in temporary directory | check exit 0; tests 61/61 PASS | actual tool result; template matches installation |
| Working diff whitespace check | exit 0 | actual tool result |

## User-facing acceptance

- Telegram keeps receiving updates while a Codex RPC is pending; `/status` can explain a pending
  start, disconnected connection, or unknown acceptance. Unknown requests are not replayed.
- `/pending` recovers failed approval/question delivery. Copies use a single request identity.
  Known keyboards are removed after consumption/resolution; even unknown delivery copies have
  expired tokens after the pending request is removed.
- Secret question batches are rejected before display, without echoing their text. Subsequent
  Telegram and local text is blocked until a fresh conversation. This is not general secret detection.
- PC receives an immediate bridge receipt. The subsequent status is accepted, rejected, or unknown;
  acceptance is not completion. Same instance/request ID executes at most once. New user submissions
  and restarts are explicitly outside that deduplication scope. Original prompt API still works.
- Recovery notification failure does not turn a restored connection into a disconnected one.
  Recovered final messages remain available with `/last`; an unknown duration is shown as unknown.

## Runtime findings that changed the implementation

The installed CLI rejected history queries for ephemeral threads and for persistent threads that
had not yet stored their first message. An empty thread/start response alone therefore does not
prove that close/resume/history will work. The bridge replaces only a known unused conversation
when reconnecting; used or uncertain conversations must resume successfully.

The recovery smoke materializes a separate synthetic fixture using the actual dispatcher method
`thread/inject_items`, then verifies paginated history and process restart without `turn/start`.
Schema type filenames are not method names. The successful fixture was archived. Earlier failed
attempts had not materialized history. No user thread or model workload was used for these checks.

Telegram transient retries use a bounded attempt count and the server's
[`retry_after` contract](https://core.telegram.org/bots/api#responseparameters). Long waits and permanent
errors return control so the user can recover with `/pending` later. Network error output omits the
token-bearing endpoint.

## Boundaries and remaining verification

No new dependency, external listener, automatic approval, global Codex configuration change,
bot settings change, or production bridge restart. Test process termination targets only the
app-server child created by that test. Actual Telegram transport/UI and production rollout remain
UNVERIFIED. Model turn execution was not part of this verification.

The updated global skill contains the secret-free source/test/CLI template and the verified recovery
procedure. Local operational history and smoke logs are not published. Source identity is recorded
in source-sha256.json using Git-normalized blob bytes.
