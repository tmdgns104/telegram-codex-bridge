# TASK-004 verification — 2026-09-09

Baseline: `c05833281ef8f34a2cae40e0dd5540e8aacf9ae7`.
Environment: Windows, Node v24.15.0, Python 3.13, codex-cli 0.153.4.

## Observed checks

| Check | Actual result | Evidence |
|---|---|---|
| Project syntax/Python compile | exit 0 | check.txt |
| Project tests | 104/104 PASS, no skips | tests.txt |
| Independent temporary skill installation | check exit 0, tests 104/104 PASS | installed-check.txt, installed-tests.txt |
| Real Codex app-server smoke | exit 0; initialization and owned read-only temporary thread | smoke.txt, local only |
| Repository/global skill validation | both valid | validator tool execution |
| Native hook installation | definition installed exactly once, new standalone hooks.json source | setup and read-back execution |
| Doctor | runtime, login, settings and hook definition pass; bridge activation needs action | doctor.txt |
| Actual Telegram read-only checks | getMe and getChat both succeeded, no message sent | doctor --json tool execution |

## Acceptance evidence

1. Native permission: an actual Node hook child process consumes UTF-8 stdin, strips the transcript path,
   reaches the authenticated loopback and live approval broker, waits for a synthetic Telegram button,
   and returns only the documented native allow/deny envelope. The bridge-child suppression path and
   malformed input produce no decision. Separate cases verify concurrency, foreign chats, expiry,
   disconnect, late keyboard delivery, project exclusion/removal and no duplicate decision.
2. Approval detail: file-change item paths/diffs appear in the prompt; a detail request preserves the full
   provided changes without approving. Forged choices not offered by the server are rejected. Existing
   permission scope, question delivery and one-time callback tests remain passing.
3. Setup/doctor: scoped settings writes preserve unrelated values and comments, hook installation retains
   existing handlers and is idempotent. Trust is not written. Actual local installation added a standalone
   hook source; it did not replace the existing Codex config or notifier. Doctor performs read-only bot checks.
4. Media: generated inbox paths and native local image/audio inputs or document-reading instructions reach
   the selected thread with the caption. Secret-question blocking applies before download. Stream byte limits,
   unsafe Telegram paths, unsupported extensions and oversized attachments are rejected.
5. Artifacts: no file is sent merely because it was listed. Explicit file choice preserves bytes; traversal,
   absolute paths, hidden configuration, alternate streams, links and oversized files are rejected. Buttons
   cannot select a different project's files after switching. An actual Windows junction regression verifies
   that neither artifact reads nor inbox writes escape into its target. Download selection is limited and expires.
6. Workflow: registered projects keep separate thread/result state. Busy switching is rejected. Explicit
   queued tasks start once after completion, ordinary messages still steer, and failure pauses the queue.
   Restart restores exact Korean/CRLF results, bounds history and never persists/replays an execution queue.
   A delayed old completion keeps its original project label across a project change.
7. Existing 85-test behavior is preserved, with expectations changed only for approved behavior: the legacy
   state file adds workdir without adding a result body; the unsupported-input case now uses video because
   photo input is supported. Additional coverage raises the suite to 104 tests.

## Operational limits / UNVERIFIED

The installed hook definition has NOT been marked trusted by this task. The user must review/trust it using
the host Codex hook UI, then start a compatible new session and the bridge. The doctor could not connect to
an active bridge control endpoint. No production bridge was started or stopped and no Telegram message was
sent for these checks. Native hook definition, hook child-process tests and real Codex initialization are
separate evidence; they do not establish a host-generated live approval round trip on the phone.

Actual mobile rendering, user approval interaction, and the selected model's image/audio/document interpretation
remain UNVERIFIED. No model workload, transcription API, paid API or new dependency was used. Native session
conversation questions/follow-up steering are not implemented by PermissionRequest; bridge-origin questions
remain supported. The feature forwards supported approvals without taking over an independent PC session.

File-name/path checks are not a universal secret scanner. Local received content and archived response text stay
in ignored bounded stores; no private message-export contents or unrelated project data entered fixtures,
public evidence, skills or knowledge capture. Uploads require the user's explicit file selection.

## Publication

Pre-publication audit: reachable history (103 blobs) and the staged tree contain no forbidden paths or
credential-pattern matches. Source hashes use Git index bytes; runtime/template/global/temporary-install
parity checks pass. See audit.json and source-sha256.json. Commit/push and remote SHA verification pending.
