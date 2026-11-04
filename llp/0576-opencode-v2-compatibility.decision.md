# LLP 0576: OpenCode 2 compatibility

**Type:** Decision
**Status:** Draft
**Systems:** Sources, Plugins, Backfill
**Author:** Phil / Codex
**Date:** 2026-11-03
**Related:** LLP 0306, LLP 0502

## Public interfaces {#interfaces}

Extend LLP 0306 for OpenCode 2's rewritten plugin and transcript APIs. One
managed file exports a default definition with `id`, a V1 `server` factory,
and a V2 `setup` function. Both use LLP 0502's bounded queue. V2 subscribes to
the abortable event iterator, reads `session.get` and `session.context`, and
returns cleanup that aborts the subscription and pending capture. V2 runs
`setup` once per booted location in one server, and every subscription sees
every location's events, including sessions in locations that never booted.
A process-wide registry on `globalThis` lets only the oldest live setup
schedule snapshots, so a server keeps one capture queue; a location filter
would drop those unbooted sessions. A closing setup drops its queued
wake-ups, as V1 dispose does; the next event or an export recovers them. A shared
server does not identify the originating frontend, so V2 records `unknown`.
Active context excludes messages before compaction; exact-session full export
remains their recovery lane.

The projector accepts both V1 `{info, parts}` messages and V2 typed messages,
and reads V2 cwd from `session.location.directory` before policy evaluation.
V1 native part IDs stay unchanged. V2 content has no part IDs, so the message
ID plus authoritative content ordinal supplies a stable part ID on both
lanes. Tool call IDs remain native. A V2 assistant is not eligible until
`time.completed`: `finish` can be populated before tool settlement, when an
append-only message dedupe would freeze incomplete output. No dataset fields
or configuration keys are added.

## Global discovery {#discovery}

`opencode session list` is scoped to the caller's project and excludes child
sessions on both majors. Recovery instead reads global bounded metadata: the
V1 public `db` CLI runs a read-only metadata SELECT; the V2 public `api
session.list` CLI requests descending metadata without project or parent
filters. Both retain the 1,000-session ceiling and existing time-window and
privacy checks. Version is probed once per import; V2 uses `session export`
and V1 uses `export`. V1 before 1.3 has no `db` command and keeps its
project-scoped root list. No fallback selects a latest unrelated chat.

## Validation and cost {#validation}

Traditional tests cover both module contracts, settled projection, both cwd
shapes at the privacy seam, stable live/export identity, global discovery and
bounded scheduling. The capture smoke exercises the real adapter, loopback
listener, import runner, row dedupe and telemetry with a fake native CLI.
Isolated OpenCode 2.2.4 server checks additionally exercised real plugin loading,
synthetic message delivery, global listing and exact exports of parent and
child sessions. They made no authenticated inference requests.

The queue still stores at most 128 IDs, runs one snapshot at a time, and starts
at most once per second with five-second I/O budgets. Explicit history import
holds at most 1,000 metadata entries and one exported session at a time, with
the existing 32 MiB subprocess output ceiling. The extra version subprocess
runs once per import. V1 global metadata selection visits the session metadata
table; it does not parse unrelated transcripts. No uptime-dependent cache is
introduced.
