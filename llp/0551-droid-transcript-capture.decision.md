# LLP 0551: Factory Droid transcript capture

**Type:** Decision
**Status:** Draft
**Systems:** Plugins, Sources, Backfill, Config, Privacy
**Author:** Phil / Codex
**Date:** 2026-10-20
**Related:** LLP 0045, LLP 0359, LLP 0403, LLP 0416

## Capture {#capture}

The requested first Factory adapter uses native hooks to signal a changed
local transcript and bounded native recovery for missed notifications. The
standalone hook sends only session_id and transcript_path to a loopback HTTP
listener. It emits no stdout, changes no permission decisions, and exits zero
within 2.5 seconds. A busy listener refuses work; recovery repairs gaps.
PostToolUse can precede persistence, so Stop, SessionEnd, Notification,
SessionStart, UserPromptSubmit, PreCompact and SubagentStop also notify.

Register the existing ai_gateway_messages storage contracts without requiring
the proxy. Both lanes use one parser/projector and the existing projected
exchange writer. This captures local CLI transcripts, not hosted Factory
sessions without local files. Do not read credentials or sidecar settings.

## Format evidence {#format}

Validated against Factory CLI 0.245.0, darwin/arm64, SHA-256
`150f9747e48858b65dc07c68170708bffd85953729f8e6f01467c56b4aa67542`,
from the [official release](https://downloads.factory.ai/factory-cli/releases/0.245.0/darwin/arm64/droid).
The checksum matches the published .sha256 file. Two authenticated exec runs
in an isolated macOS test home confirmed the version-2 session_start header
and native message schema with real model replies and Read tool calls. The
checked-in message fixtures remain synthetic examples checked against the
binary's native persistence schema and serializer.

The native serializer writes records with type=message, id, parentId,
seq, timestamp, and message {role, content, modelId?, apiProvider?}. Roles are
user/assistant; tool results are user content blocks with tool_use_id and
is_error. The writer converts native toolUseId to tool_use_id. Sequence starts
at zero; legacy missing seq advances the previous sequence by one. Header
fields are type=session_start, version=2, id, cwd, plus metadata. A header need
not have a timestamp. Non-message events (including compaction_state) are not
conversation messages. Refuse unknown header versions. Preserve structured
text/tool calls/results and attachment placeholders, without signatures,
encrypted reasoning or dereferencing file paths. Do not interpret record
`tokens` or sidecar cumulative `tokenUsage` as per-message billed usage.

The official [session-navigation skill](https://github.com/Factory-AI/factory-plugins/blob/aa8be50bc07e9f4ec48db9d57929ce8e2214504a/plugins/core/skills/session-navigation/SKILL.md)
confirms the sessions/project/UUID.jsonl and UUID.settings.json layout. The
[hook documentation](https://docs.factory.com/harness/hooks) supplies callback
input and lifecycle events. The pinned binary additionally confirms per-event
hooks.json precedence over settings.json and FACTORY_HOME_OVERRIDE relocating
the home containing .factory. No DROID_HOME or FACTORY_CONFIG_DIR is invented.
The authenticated runs also confirmed Script-wrapped Read calls, separate
native records for the nested call/result, empty-content hook status records,
and an agent_turn_outcome event. Both tool result links survived projection;
empty hook records and non-message events produced no conversation parts.

## Identity {#identity}

Message IDs hash [native session ID, header cwd, native message ID] with a
`droid:` prefix. Native parent IDs use the same scope. Native seq (or the
upstream legacy fallback) supplies message_index before window filtering,
so batching, incremental reads, restarts and backfill converge. Forked session
IDs deliberately form separate conversations. There is no cumulative spend
carrier to double count across forks. Native tool-use IDs retain tool links.

## Bounds {#bounds}

Discovery streams at most 10,000 entries, one level beneath the sessions root,
without traversing directory symlinks. Reads require a real path under the
real sessions root and a regular file. Per-file size is capped at 64 MiB,
header at 16 KiB, line at 1 MiB and records at 100,000. Batches have at most
64 records and 1 MiB of source text. A scan reserves at most 256 MiB; scheduled
scans rotate their starting file to avoid starvation. The runner's effective
since/until/retention window (LLP 0359) filters message timestamps. Default
recovery is every five minutes, suppressed by backfill.on_join=false.

Live capture admits one request, at most 16 KiB and 2.5 seconds for its body,
and reads at most 8 MiB per notification. At most 64 session cursors hold an
offset, sequence, header and 128-byte boundary. No conversation payload cache
is retained. Header/inode/boundary changes and same-size modifications reset
the offset; periodic full recovery handles other in-place rewrites. Cursor
commit follows successful writes and an unchanged file stat. Only terminated
lines are consumed; pending tool placeholders hold the cursor before them.
Recovery fingerprints are process-local, bounded by discovery, and committed
only after complete successful consumption, never on dry run or failed writes.

Both lanes check .hypignore and persistent session exclusions before projection.
Unreadable exclusions fail closed (LLP 0403). Local-only policy is carried by
the existing storage/export path. Diagnostics include counts and error classes,
never transcript paths, prompt bodies or tool output. Files remain native;
no raw callback spool is introduced.

## Attachment {#attachment}

Install command matcher groups into ~/.factory/hooks.json, honoring
FACTORY_HOME_OVERRIDE. The existing _hypaware managed.hook_entries undo record
owns exact event/matcher/command entries. Core understands standalone root
maps as well as nested hooks objects, so detach works after unloading Droid.
Preserve user groups. Where adding an event shadows settings.json's fallback,
copy those commands and record ownership of the copies. Detach removes copies
and the capture hook, exposing settings.json again. Refuse an unmigrated
legacy hooks/hooks.json when no modern hooks.json exists, since creating an
empty modern file on detach would shadow the legacy file. Refuse malformed
or non-JSON configurations rather than rewriting them blindly. Unknown
_hypaware keys are stripped by the native hook schema, not executed as hooks.

## Verification {#verification}

Deterministic tests cover native IDs, sequence/window stability, tools, absent
billed usage, bounds, partial lines, rewrites, failure retry, ignore policy,
path containment, and attach/detach preserving user handlers. A hermetic smoke
runs the installed command through stdin and real HTTP, queries stored rows,
replays recovery, and checks run-specific logs and spans. It also boots the
real daemon with a one-day provider window and 30-day cache retention, then
asserts that its scheduled sweep imports only the recent message, preserving
the native sequence. No real user installation or Factory credential is
needed for these checks.

On 2026-10-20 (America/Los_Angeles), a real authenticated CLI test captured
10 parts live through the installed hooks. SessionStart, PostToolUse, Stop
and SessionEnd completed with exit zero and empty stdout/stderr. With only
the test daemon stopped, a second Read request completed normally; its hooks
exited zero with the expected capture-unavailable diagnostic on stderr.
The cache remained at 10 parts. A window excluding both sessions imported
zero rows; a one-day manual backfill then added the second session's 10 parts.
A second backfill wrote zero rows, leaving 20 unique parts. Exact final
answers, both levels of tool-result linkage, hook capture counts and backfill
scan telemetry were checked. This validates local CLI capture and manual
recovery. Large-file limits remain covered by deterministic tests rather than
an authenticated large-conversation run.

The packed build also passed installed-service checks on macOS launchd (a
distinct test label) and Debian Linux systemd (a disposable container with a
real user service manager). On each, the installed hook captured five fixture
parts, the normal 60-second daemon tick recovered a missed row while excluding
a two-day-old row, and conversation, trace and log SQL queries succeeded.
Restart followed by another scheduled sweep left six unique parts. Detach
removed the managed hooks, and uninstall confirmed the service stopped.
The npm package contained the adapter and hook; npx boot, typecheck, all 21
documented release smokes, and the expanded Droid smoke passed.

The full traditional suite had 8,867 passes, seven skips and one failure in
the unrelated Hermes legacy-session catch-up test. That exact failure also
reproduced on unchanged baseline ad8a40958df74517a7241e245390abc0afe19a54;
the full-suite release gate is therefore not claimed green.
