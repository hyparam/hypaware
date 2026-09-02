# LLP 0359: Scheduled backfill work is bounded by changed input

**Type:** Decision
**Status:** Accepted
**Systems:** Backfill, Plugins, Gateway, Cache
**Author:** Phil / Codex
**Date:** 2026-08-31
**Related:** LLP 0027, LLP 0170, LLP 0172, LLP 0311, LLP 0358

> A scheduled transcript sweep does work proportional to changed transcript
> input, not to all transcript history or all committed gateway rows. Due
> providers run serially in one background queue, scheduled imports use the
> effective retention window, Claude skips files whose process-local
> fingerprint is unchanged, and gateway dedupe probes only the candidate
> identities while keeping in-run state isolated by an opaque run token.

## Problem {#problem}

LLP 0358 deliberately shipped the smallest reliable Claude Desktop sweep: run
the one-shot provider every five minutes and let durable `part_id` dedupe turn
an unchanged pass into zero writes. That bounds output, but not work.

One Claude tick recursively discovers every transcript and agent metadata
file, reads every JSONL byte, parses and hashes every line, and projects every
session before dedupe reports zero new rows. The daemon runner supplies no
retention window, so rows older than cache retention can be reintroduced after
maintenance removes them.

The gateway materializer seeds backfill dedupe by reading every committed
`part_id` and every spooled `part_id` into one process-wide set. A new run id
rebuilds the set. Since the sweep driver starts every due provider without
awaiting the previous provider, Claude and OpenClaw can run together on their
shared five-minute boundary and replace each other's single memo, multiplying
full-cache scans.

The no-overlap guard in LLP 0172 is per provider. It prevents two OpenClaw
runs, but does not protect shared materializers and spool state from two
different providers.

## Decision {#decision}

### Due providers share one background queue {#serialized-providers}

The sweep driver remains non-blocking with respect to the daemon tick, but it
queues due providers in registry order and runs one provider at a time. A
queued provider counts as in flight, so later ticks neither duplicate nor
reorder it. Failure settles that provider, logs normally, and releases the
queue for the next provider.

This changes only concurrency, not cadence or completeness. Every provider due
on a tick is queued. The sink tick, source probes, and status persistence still
do not await transcript work.

### Scheduled runs use retention and identify themselves {#sweep-context}

The driver passes the effective cache retention window to
`runBackfillProvider` and marks the run context as scheduled. A plugin's
existing positive `backfill.window_days` narrows that provider's sweep;
otherwise `query.cache.retention.default_days`, then the kernel default,
applies. A configured zero cache-retention value retains the existing open
window meaning.

Manual and onboarding backfills keep their existing behavior. The scheduled
marker is runtime context, not an operator-facing config key.

### Claude remembers unchanged files for the daemon lifetime {#file-fingerprints}

The Claude provider keeps a process-local map from transcript path to a file
fingerprint of inode, size, and modification time. A scheduled run still
enumerates roots so new sandbox homes and files are found, but it reads and
projects only new or changed JSONL files. A file fingerprint advances only
after that file was read and all of its yielded sessions were consumed.

The map is deliberately not durable. A daemon restart performs one cold full
scan, preserving LLP 0358's correctness argument without creating a checkpoint
whose crash ordering must agree with spool durability. During a healthy daemon
lifetime, unchanged five-minute ticks read no transcript bodies and do not
enter gateway materialization. Manual backfill ignores the map.

Agent metadata is loaded only when at least one transcript file changed, so an
unchanged tick also avoids the second recursive metadata walk. The scan log
reports files discovered, read, unchanged, and failed without recording paths
or content.

### Gateway backfill dedupe is candidate-scoped and run-isolated {#bounded-dedupe}

The runner gives every provider invocation a fresh opaque object as its
materialization run token. The gateway materializer keys its in-run emitted-id
set by that object in a `WeakMap`, so concurrent or nested callers cannot
replace one another and completed runs become collectible without an explicit
cleanup callback.

For each projected session, committed and spooled scans are restricted to that
batch's candidate `part_id`s and session ids. The materializer never preloads
the full gateway identity set. Heap is proportional to identities emitted by
the current run plus one candidate batch, not total cache rows. An unchanged
Claude tick yields no batch and performs no cache scan.

## Consequences {#consequences}

- Two providers due together cannot multiply cache scans through shared memo
  replacement or compete over the same backfill spool flush.
- A steady unchanged Claude install pays root enumeration and file stats, but
  no JSONL reads, parsing, content hashing, projection, or cache dedupe.
- The first sweep after daemon start remains a cold scan. This is the safe
  fallback and the recovery path after any process crash.
- An actively appended transcript is reread in full when its fingerprint
  changes. Durable byte offsets remain a possible later optimization if the
  largest active session, rather than unchanged history, becomes material.
- A metadata sidecar that appears without any transcript change does not by
  itself invalidate the transcript fingerprint. Its optional subagent
  provenance is picked up on the next transcript append, manual backfill, or
  daemon restart; message capture is unaffected.
- Initial and manual historical imports trade one unrestricted cache preload
  for session-scoped candidate probes. This bounds memory and uses the cache's
  `session_id` sort bounds from LLP 0311 to prune unrelated files.

## Verification {#verification}

- A scheduler regression holds the first provider open and proves the second
  due provider is queued, not started concurrently.
- A Claude provider regression runs two scheduled passes over an unchanged
  fixture and proves the second pass reads zero files, then appends a line and
  proves exactly that file is read again.
- A gateway materializer regression uses two run tokens and proves candidate
  scans stay isolated without an unrestricted committed-row read.
- The Claude smoke proves the first tick writes Desktop rows, the second tick
  scans zero items and writes zero rows, and telemetry reports the unchanged
  skip.
