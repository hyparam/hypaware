# LLP 0403: Persistent session exclusions and Claude hook identity

**Type:** Spec
**Status:** Draft
**Systems:** Privacy, Gateway, Plugins, Sources, Backfill
**Author:** Phil / Codex
**Date:** 2026-09-11
**Related:** LLP 0066, LLP 0067, LLP 0085, LLP 0256, LLP 0395

## Requested behavior {#contract}

A confirmed `hyp session ignore` must survive recorder and daemon restarts.
The user requested this after finding that a restart or separate manual
backfill could re-import a private session. The user also reported that
Claude Desktop's local Code tab has no `CLAUDE_CODE_SESSION_ID` in Bash.

This extends LLP 0066 #ephemeral, LLP 0067's in-memory lifetime and manual
backfill exception, and LLP 0395 #in-memory-only and #manual-lane. The opaque
ID match, recorder discovery, membership-only receipt, and explicit unignore
remain. Forks with a new session ID require another exclusion. Ignoring does
not purge earlier rows, native transcripts, or exported copies. Unignoring
makes the whole transcript eligible again.

## Private durable state {#storage}

Each participating recorder loads `<HYP_HOME>/hypaware/session-ignores/` on
activation. Each excluded ID has one marker, named by SHA-256 of its JSON
string encoding plus `.json` and containing that encoding. JSON preserves
opaque IDs exactly. New files are mode 0600 and directories mode 0700.

Independent markers prevent whole-list lost updates between recorders writing
different IDs. Mutations atomically replace or remove only the named marker,
then update memory. A control request succeeds only after saving; failure
returns HTTP 500, emits `session_ignore_persistence_failed`, and preserves the
previous in-memory membership. Atomic writes protect against partial files
on process restart, not storage loss or power failure.

Live membership remains an in-memory Set lookup. Startup and backfill refresh
use a streamed directory iterator and refuse invalid markers or more than
10,000 IDs, 64 KiB per ID, or 4 MiB total. Capacity failures never evict existing
exclusions. Each writer checks capacity against its own snapshot; concurrent
writers can exceed the aggregate limit, causing a later load to refuse rather
than silently omit exclusions. Unreadable or corrupt state is an error, never
an empty list. Atomic-writer temporary files are not committed markers.

## Transcript recovery {#backfill}

Claude, including Desktop transcripts, Codex, and OpenCode activation load the
same store. Providers refresh at the start of each run, so manual CLI imports
also honor saved IDs. Checks occur before projection; Codex uses the session
container ID rather than its thread ID. The CLI continues to address all live
control routes so every live recorder updates its in-memory view.

An import already in flight uses its run-start snapshot. No cross-process
cancellation is added. OpenClaw and Hermes session opt-out support remains
outside scope. Previously in-memory exclusions must be reapplied after upgrade;
there is no old persistent state to migrate. Purge does not remove markers.

## Claude hook identity {#hook-identity}

The existing managed `claude-hook session-context` command receives the exact
`session_id` on hook stdin. On SessionStart, append a shell-quoted export of
`CLAUDE_CODE_SESSION_ID` to the absolute `CLAUDE_ENV_FILE` path Claude supplies.
Claude sources it for later Bash tools. Reuse the existing hook and variable;
never infer a Claude conversation from cwd, transcript recency, or Desktop's
list of multiple conversations.

This uses Claude's [documented hook environment mechanism](https://code.claude.com/docs/en/hooks#persist-environment-variables).
Preserve other hook statements, including an unterminated final line. Treat
IDs as literal shell data; refuse empty IDs, NULs, malformed Unicode, and IDs
above 64 KiB. Export after minimal context capture and before git enrichment.
Write failure reports a diagnostic and leaves context capture and spool
maintenance running. Hook success is not an opt-out receipt.

A new start or resume refreshes the ID after upgrade. Hosts that disable hooks
or omit the hook environment file still require an explicitly verified ID.
This addresses LLP 0395's Desktop discovery gap for attached local Code
sessions that execute the hook, not cloud or Cowork sessions.

## Verification {#verification}

Tests cover control POST and DELETE across fresh gateways, separate-process
reads, exact IDs, independent writers, corrupt/oversized state, and failed
mutations. A fresh Claude importer and a pre-existing manual provider honor
saved exclusions, while unrelated sessions import. Codex checks the container
ID and refreshes changes. The hook regression sources its output in a real
shell and runs the actual ID resolver, including resume, quoting, preservation
of other exports, unavailable files, and no per-turn export work.

Real Desktop verification is still required: start a local Code session after
installing the updated hook, compare the exported ID with its native transcript
ID, then confirm ignore for that exact ID. A fixture cannot establish that a
particular Desktop build executes user hooks.

CPU and memory: live reads retain O(1) Set membership with no I/O. Mutations
write one bounded ID. Startup and backfill refresh are linear in the bounded
stored set. The hook adds one bounded string and append per SessionStart,
with no scan, new subprocess, timer, or work per captured message.
