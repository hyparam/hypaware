# LLP 0583: Bounded Codex rollout capture and visible file failures

**Type:** Decision
**Status:** Draft
**Systems:** Plugins, Sources, Backfill, Daemon
**Date:** 2026-11-04
**Related:** LLP 0429, LLP 0567, LLP 0546

## Evidence {#evidence}

A synthetic 743 MiB JSONL rollout with a September session header and two
settled November messages reproduces `Invalid string length` on Node 24.
The provider yields no messages and the runner reports success. The same
records without padding capture both messages. The failure comes from the
whole-file UTF-8 read, before date filtering. The existing warning does not
change the run result or transcript capture status.

## Bounded projection {#bounded-projection}

Extend LLP 0429's rollout reader with sequential, bounded JSONL reads.
One pass collects session metadata, first usable context fields, turn
representation evidence (LLP 0567), and the last settlement position. A
second pass resolves usage onto record positions after representation,
settlement, and window filtering. A third emits at most 128 messages or
4 MiB of source records per batch, allowing one larger bounded record.
No conversation bodies survive a batch. The shared materializer's run token
retains cross-batch identity and tool lookup; explicit message indices retain
whole-conversation positions. Titles are appended only to the final batch.

Read one file descriptor at its initial size throughout the passes. Appends
are read on the next sweep. Existing fingerprints still record the initial
stat, so changes during consumption are retried. Abort signals are checked
while reading. Session opt-outs and directory policy are checked before each
batch is yielded.

A line is limited to 16 MiB; metadata indexes to 100,000 entries and 8 MiB
of turn identifiers. Exceeding a bound is an explicit retryable file failure,
never a silent skip. Legacy single-document JSON keeps a bounded 16 MiB
fallback. Invalid/truncated JSONL records retain the existing tolerant policy.

Three reads trade sequential I/O and JSON parsing for bounded body memory
and correct late usage/mirror decisions. Unchanged files keep the existing
fingerprint fast path. All parser indexes are released after each file.
No dependency, dataset field, config option, or transcript rewrite is added.

## Failures {#failures}

Finish other files, then fail a scan with at least one unreadable rollout. Keep
failed files unfingerprinted and mark `scan_complete` failed. The runner's
existing failure and partial-write flush paths apply.

The sweep reports its latest outcome to daemon bookkeeping. Reuse the
existing status snapshot `warnings` array for one `backfill_failed:<provider>`
entry per failing provider. Emit a daemon-file warning only on transition,
remove it on recovery, and expose it as a degrading diagnostic in `hyp status`.
A newest row from another healthy thread cannot conceal a failed scan.
The snapshot stores no content or raw exception strings. It resets on boot
and is refreshed by the next scheduled sweep; no history grows with uptime.

## Verification {#verification}

Traditional tests cover batching, usage before a boundary, cross-batch tool
links and lineage, existing privacy/window/TurnItem semantics, read failure
retry, failure-to-recovery status, and per-record limits. A synthetic 743 MiB
acceptance run under a constrained Node heap checks the original failure,
tail capture and idempotent durable writes. Customer data is not required.
