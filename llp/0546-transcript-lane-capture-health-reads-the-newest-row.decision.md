# LLP 0546: Transcript-lane capture health reads the newest cached row

**Type:** Decision
**Status:** Accepted
**Systems:** Daemon, Observability, Plugins
**Author:** neutral
**Date:** 2026-10-19
**Extends:** LLP 0257 (#status-and-health: a marker-less transcript-lane client
gets a capture-health line, answered by one bounded cache read), LLP 0164
(its non-goal of a cache read in `hyp status`, narrowed for this one line)
**Related:** LLP 0536, LLP 0474, issue #2069

> [LLP 0257](./0257-claude-telemetry-listener-source.spec.md) and
> [LLP 0164](./0164-status-names-recent-clients-from-gateway-entrypoints.decision.md)
> are Accepted, so they are not edited. S17 answers capture health "from the
> status file only", and LLP 0164 rules out giving `hyp status` a cache read.
> This doc makes one narrow exception to both, for one client lane.

## Context {#context}

Default-mode Codex captures by a scheduled sweep of `~/.codex/sessions`. It
writes no marker into the client's settings and sends no telemetry, and it goes
through no gateway. So none of the signals `hyp status` already reads can say
it is working: the otel capture-health line needs a marker and a listener, and
the recent-clients row needs gateway entrypoints. A working install showed
`configured` and nothing else (issue #2069), which reads the same as one that
captured nothing.

The only durable evidence this lane produces is the row its sweep lands in
`ai_gateway_messages`. Nothing in the status file records it, and adding a
persisted field for it was ruled out.

## Decision {#decision}

### Read the newest date partition, once {#newest-partition}

**When a configured client writes no marker, `hyp status` reads the
`message_created_at` of the newest row in that client's `ai_gateway_messages`
source table, and reports it on the client's capture-health line.** The read
is bounded: table metadata names the live data files and their `date`
partitions, and only the newest partition's one timestamp column is scanned.
`date` is the UTC day of `message_created_at`, so an older partition cannot
hold a newer row.

- A row found is `state: 'ok'` with `lastEventAt` set to its timestamp.
- No row, a missing table, or a read that fails is `state: 'unknown'`
  ("capture unconfirmed"). Configured is not captured, so the line never reads
  `ok` without a row behind it. Like LLP 0536's `unknown`, it raises no
  diagnostic.
- The entry keeps the existing `CaptureHealthReport` shape. Its transcript,
  attach and listener fields are null and `gapMs` is 0: this lane has no
  telemetry to compare against transcript activity, so there is no gap to
  measure. No field is added to the report, the JSON output, or the status
  file.

### What stays the same {#unchanged}

Every other client, and Codex in gateway mode, is untouched: their lines still
come from the status file alone, and no cache read happens for them. The
summary view does not change. The read is a status answer, not a freshness
claim about the cache.

## Consequences {#consequences}

- Rows still in the spool are not counted, so a turn the sweep just captured
  shows up after its flush.
- Only a timestamp is read, so purged sessions are not filtered beyond the
  committed delete positions the scan already applies. A newest partition whose
  rows are all deleted reads `unknown`, never a false `ok`.
- `hyp status` pays one metadata load and one single-column partition scan for
  each marker-less configured client, which today is Codex alone.
