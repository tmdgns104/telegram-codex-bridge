# TASK-003 Verification — 2026-09-09

Baseline: `9ca42a60c816c61faa72bdfde5cb1bdc8f039b59`.
Scope: readable PC notifications, bridge result previews/details, reply identity checks.
Environment: Windows, Node v24.15.0, Python 3.13, codex-cli 0.153.4.

## Observed verification

| Check | Actual result | Evidence |
|---|---|---|
| `npm.cmd run check` | exit 0, Node syntax and Python compile | check.txt |
| `npm.cmd test` | 85/85 PASS, exit 0 | tests.txt |
| `npm.cmd run smoke:app-server` | exit 0, real initialization and read-only ephemeral thread | smoke.txt, local only |
| Repository and global skill validators | valid | tool execution |
| Temporary skill installation | check exit 0, tests 85/85 PASS | actual installer/check/test execution |
| Source and reusable template | exact code/test parity | publication audit |

## Acceptance evidence

1. Neutral PC receipt headings do not claim successful task completion, even for review-required,
   failed-criteria, or ordinary-answer text. Native completion metadata is insufficient to infer
   overall task success. Bridge turn completion similarly says the response finished.
2. Title/recap-only JSON is quiet, displayed readably, and retained exactly in a generated text document.
   Other JSON remains ordinary output. No guessed internal provenance is used to discard responses.
3. Long Unicode output, CRLF, Markdown tables, desktop file references, and late review caveats have
   bounded excerpts. Full document content equals the original; actual multipart requests contain
   the expected Unicode bytes. No arbitrary local artifact path is opened.
4. Event identity includes bot/chat/workdir/thread/turn. Repeated and concurrent event attempts are
   suppressed within a 24-hour / 1,000-event retention window. IDs missing, expiry, capacity, distinct
   sources, and uncertain transmission are covered. These are notification receipts, not task-execution
   receipts; expiry/eviction permits a later notification attempt and never replays a Codex task.
5. Unknown PC notification replies and stale turn/thread replies cannot start/steer a task or answer
   a question. Identity is rechecked after queued thread changes. Free-text question replies work.
   Expired detail callbacks do not fetch a different result; result identity survives acknowledgement races.
6. Native Python entrypoint tests launch actual Node child processes against a mocked fetch sender in a
   disposable installation. Four concurrent processes produce exactly one preview and one original document.
   Bridge-origin events and malformed values generate no HTTP request. No real Telegram network call is made.
7. Existing approval delivery, callback consumption, connection recovery, and PC execution-receipt checks
   remain passing. An approval-delay test now targets approval buttons specifically, because full-result
   buttons are also present; its expiry assertion remains intact.
   A new result-identity regression also holds approval cleanup across a subsequent task: each completion
   keeps its own notification body while the most recent result remains available via `/last`.

## Boundaries

Actual Telegram mobile rendering, notification sound settings, and production bridge restart remain
UNVERIFIED. No model workload was requested. The real smoke uses only an owned read-only temporary thread.
Plain-text previews are excerpts, not semantic summaries; the user can inspect the original context.
The bridge keeps only the most recent result in memory. PC notification originals are generated in memory
and sent as text documents; application files, PDFs, and images are not uploaded by this change.

No service, new dependency, global Codex configuration change, automatic permission approval, project
switching, or task queue was added. A short OS-released loopback mutex protects notification receipt
updates; it closes before Telegram delivery. Notification delivery ambiguity is not automatically retried.
Retention bounds and missing identities limit duplicate suppression as documented in README.

The user-provided message export stays local and is ignored by Git. No export contents were copied into
tests, public evidence, or reusable skills. All new fixtures use synthetic text and project identifiers.

## Publication

Pending commit/push and remote SHA verification. Source identity is recorded in source-sha256.json
using staged Git-normalized blob bytes.

Pre-publication audit: 89 indexed paths and 116 reachable history objects contained no forbidden
export/config/state/log paths. Indexed content had no credential-pattern matches. The source manifest
covers 29 files; 28 code/config/test files match the repository template, global skill, and disposable
installation after Git line-ending normalization. README and .gitignore intentionally keep project-only
documentation/exclusions out of the reusable template. The three skill documents also match the global
copy. Korean repository documents were decoded as UTF-8 and checked for replacement/corruption markers.
