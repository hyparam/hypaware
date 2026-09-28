# LLP 0444: OpenClaw transcript capture follows SQLite storage

**Type:** RFC
**Status:** Accepted
**Systems:** Plugins, Sources, Gateway
**Author:** Phil / Codex
**Date:** 2026-09-28
**Extends:** LLP 0158, LLP 0170, LLP 0205, LLP 0085
**Related:** LLP 0157, LLP 0159, LLP 0122, LLP 0441

## Context

OpenClaw 2026.9.6 stores authoritative session history in each agent's
`agent/openclaw-agent.sqlite`. Scanning only `sessions/*.jsonl` silently loses
recovery, native identity settlement, and the session cwd needed to enforce
`.hypignore`. The existing JSONL tests do not cover that upstream boundary.
A real isolated 2026.9.6 CLI run confirmed the session header, nested message
records, tool calls/results, and compressed assistant payload in SQLite.

## Precedence {#precedence}

Both consumers use the same plugin-local session reader. SQLite session
windows own their native session id even when migration left JSONL copies.
JSONL-only sessions, including supported reset/deleted names, remain readable.
The SQLite file path is provenance, never the session identity. Header and
message normalization and native part ids remain the LLP 0158/0159 contracts.
`OPENCLAW_STATE_DIR` takes precedence for transcript discovery. The existing
`OPENCLAW_HOME` interpretation remains for older HypAware configurations.

Quiescence uses the window's `transcript_updated_at`, falling back to its
`updated_at` where unavailable. It is rechecked inside the payload snapshot.
Database mtime cannot identify which session changed. Per-message retention
and CLI-backend exclusion remain unchanged.

## Reads {#reads}

Use Node's built-in SQLite in read-only, query-only transactions. Do not
migrate, checkpoint, install extensions, or write to OpenClaw's database.
Inspect required tables/columns and reject incompatible stores explicitly.
Retry SQLITE_BUSY/LOCKED at most three attempts, waiting 25 then 50 ms after
closing the failed read. No busy loop or unbounded retry.

Enumerate metadata in 128-session pages; fetch transcript payloads by indexed
session id and sequence. Limit a transcript and the total SQLite payload
indexed by one settlement call to 64 MiB, and a transcript to 100,000 events.
Keep the existing 32 settlement candidates. Exceeding a bound is a visible
storage failure, never truncation or success with empty history. Retained
state is scoped to a scan/flush, not daemon uptime.

Decode `event_json` or bounded `event_zstd` payloads. The latter must match
`event_utf8_bytes` and the upstream 4 MiB compressed-event bound. If Node has
no built-in zstd support, explain the runtime requirement on encountering
compressed history; do not add a runtime dependency or silently skip it.

## Archives {#archives}

Cold sessions remain authoritative. Read the file or SQLite blob selected by
`session_transcript_cold_archives`, verify its byte length and SHA-256, and
bound decompression to 64 MiB. Verify the envelope version, session id,
generation, increasing event sequence, count, last sequence, and raw bytes.
Read event records without restoring or deleting anything in OpenClaw.
Missing, corrupt, and unsupported archives are visible read failures.

## Failure policy {#failure-policy}

An absent installation remains an ordinary empty scan. An unreadable or
unsupported present store is an error. Backfill fails visibly and retries on
the existing schedule; it never falls back to stale JSONL for a SQLite-owned
session.

Phil explicitly chose bounded read retries plus recovery over holding the
shared gateway spool. If a storage failure prevents OpenClaw settlement from
establishing directory policy, return the existing terminal drop sentinel
for its provisional/unknown-cwd rows and emit a structured
`plugin.openclaw.storage_unavailable` warning, with no payload or raw cwd.
The authoritative transcript is recovered by the scheduled backfill when
readable. Permanent unreadability can therefore lose the live copy; this is
the approved privacy-over-availability tradeoff, not a guarantee of eventual
recovery. Already native rows with their own cwd remain untouched (LLP 0441).

The sentinel is honored only at pre-commit flush. Maintenance must not purge
already committed rows. Other clients keep flushing, with no new spool format,
queue, schema column, or background retry loop. A healthy scan with no content
match retains the existing fallback behavior; this decision addresses storage
failures, not the separate unmatched-session ambiguity.

## Verification

Traditional tests cover both formats, ownership during migration, compressed
and cold records, quiescence, retention, WAL writes, policy drops, read errors,
and recovery. The existing full backfill smoke also runs with SQLite-only
storage and asserts imported rows, telemetry, and an idempotent rerun.
A real-client check uses the actual current OpenClaw CLI in an isolated state
directory with a local mock provider and verifies its written database and
legacy migration. Mock traffic does not verify upstream vendor compatibility.
LLP 0430 retired the old manual procedures; this change does not restore them.
