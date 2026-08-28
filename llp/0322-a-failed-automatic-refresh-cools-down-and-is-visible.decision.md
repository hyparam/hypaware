# LLP 0322: A failed automatic refresh cools down, stops fragmenting the spool, and reaches the status signals

**Type:** Decision
**Status:** Accepted
**Systems:** Cache, Query, Observability
**Author:** Phil / Claude
**Generated-by:** neutral
**Date:** 2026-08-28
**Related:** LLP 0319 (the cursor-stamped cooldown idiom this reuses on a hotter path), LLP 0321 (the degrade this bounds), LLP 0021 (the span helpers this widens), LLP 0027

> Extends [LLP 0321](./0321-auto-refresh-serves-confirmed-cache.decision.md).
> The automatic degrade it settled is right per query and unbounded in time: a
> standing cache rejection makes every later query rotate one more spool file,
> retry the same doomed append, and pay a growing stat sweep, while the span
> status code and the run metric still read clean. A failure is now stamped,
> the stamp holds the flush gate closed for a window, a retry under a standing
> stamp reuses the files already rotated instead of minting another, and the
> degrade reaches the span status code and the `queryRunsTotal` dimension.

## Context {#context}

LLP 0321 made an `auto` query survive a spool-to-cache write that the cache
rejects: the flush error is caught, the last confirmed cache is read, and the
user gets one warning. That is the right answer for one query. It says nothing
about the hundredth.

The freshness step is per query, and under a standing rejection every query
takes the same path, because nothing the failed attempt did is remembered:

- `flushTable` rotates the active spool file before any append can fail
  (`src/core/cache/spool.js`). Under live capture the active file is non-empty
  on each attempt, so each attempt renames it to a fresh `flush-*` file.
- The `fs.rm` that retires a flush file and the `writeLastFlush` that advances
  `lastFlushAtMs` are both on the success side of the append. A rejected append
  reaches neither.
- So `lastFlushAtMs` never moves. The `QUERY_FLUSH_DEBOUNCE_MS` gate in
  `settlePendingCacheForQuery` reads a null-or-ancient timestamp and opens on
  every query, forever.
- `pendingBytesSync` readdirs the spool directory and stats every file on it,
  and it runs on every append and every flush. The set it walks is the set the
  rotations keep growing.

The result is a spool that fragments in proportion to query traffic, an append
that is retried as fast as queries arrive, and a per-query cost that climbs
with the number of files the failure has already stranded. The rows are safe
(that is LLP 0321's spool-owns-durability rule and it is untouched here), but
the cost of holding them is not bounded.

[LLP 0319](./0319-resettle-scan-failure-cooldown.decision.md) settled exactly
this argument for the maintenance re-settle scan: a retry that is correct on
each tick and unpaced across ticks is not bounded, and the fix is to stamp the
failure and make the next attempt wait out a window. That decision governs the
hourly path. This one is the same shape on the path that runs once per query,
where the unpaced rate is not "every hour" but "as fast as anyone types".

A second gap rides along. LLP 0321#observability says the active span is marked
`status=degraded`. It is, as an attribute. But `withSpan`
(`src/core/observability/span_helpers.js`) decides the OTel status code from the
attribute snapshot taken when the span was created and never re-reads it, so a
`status` attribute written later lands on a span that still ends
`SpanStatusCode.OK`. The success path likewise records
`queryRunsTotal.add(1, { status: 'ok' })`. An operator alerting on span status
or on the metric's `status` dimension sees a clean fleet while every cache in it
is refusing writes. The signal LLP 0321 specified exists only in the log line
and in an attribute nobody alerts on.

## Decision {#decision}

<a id="stamp-the-failure"></a>**A failed flush is stamped, and the stamp holds
the query flush gate closed.** `flushTable` writes `last-flush-failure.json`
into the table's spool directory when the flush throws, carrying the failure
time and a bounded error message, and rethrows unchanged. `pendingInfo` reports
it as `flushFailedAtMs`. `settlePendingCacheForQuery` under `auto` treats a
stamp younger than `QUERY_FLUSH_FAILURE_COOLDOWN_MS` (ten minutes) as a closed
gate: it does not call `flushTable` at all, and it reports the query as degraded
by the same rule a live failure would.

Ten minutes, not the six hours of LLP 0319, because the two paths are paced by
different clocks. The re-settle scan already had a cadence (the hourly
maintenance tick) and needed one that was slower; the query gate has no cadence
at all, so the window is the cadence. It is set below the maintenance interval
deliberately: LLP 0311's repartition migration runs during maintenance, and a
repair that lands there must be picked up by the next query in the same hour
rather than an hour later. At most six attempts an hour instead of one per
query, and the attempt that follows a repair still arrives promptly.

The window is a constant, not config, for LLP 0319's reason: it is a retry
cadence for a broken-cache corner, and a caller who needs the newest rows sooner
has `--refresh always`, which never consults the stamp.

<a id="what-the-stamp-is-not"></a>**The stamp is a pacing record, not a verdict
about the data.** It says when a flush attempt last failed. It says nothing
about what is in the spool, nothing about what is in the cache, and no path
reads it as either. `pending` and `pendingBytes` are unchanged, the spool still
owns durability, and no row is dropped, rewritten, or acknowledged because a
stamp stands. Exactly LLP 0319's separation: the delay is on the retry, never a
claim about the thing being retried.

<a id="clearing"></a>**The stamp clears on a flush that completed.** Any
`flushTable` that returns without throwing removes it, including a call that
found nothing to move: the stamp asserts that the last attempt failed, and a
completed attempt makes that false. That is the same "something proved the path
works" rule as LLP 0319#clearing, and here it is cheap and exact rather than
inferred, because a flush that completed is direct evidence about the very
operation the stamp paces. The daemon's own scheduled flush clears it too,
which is the intended reading: it is the same append against the same cache,
and if it succeeded, queries have no reason to keep holding off.

<a id="stamps-that-cannot-be-read"></a>**A stamp that cannot be read as a recent
failure is no stamp.** Absent, unparseable, or dated in the future by a clock
that moved: all three answer "not cooling down" and the flush is attempted.
Carried over verbatim from LLP 0319#unreadable-stamp-scans, for the same reason:
suppressing work on state this build cannot interpret is the direction that
silently withholds rows, while attempting it is only ever a cost.

<a id="coalesce-the-retry"></a>**An unforced retry under a standing stamp reuses
the files already rotated instead of minting another.** When `flushTable` starts
without `force`, finds a failure stamp, and finds flush files already waiting, it
skips `rotateActiveFile`. New rows keep accumulating in `active.jsonl` and are
picked up by the first rotation after the cache is repaired.

This is the half the cooldown alone does not fix. The cooldown lowers the rate
of rotations, but each one still strands one more file forever, and the flushes
the daemon schedules for itself (the spool's size threshold, the sink driver's
discovery settle) do not consult the query gate at all. Those are the calls that
repeat, and the rule removes their growth instead of slowing it: while a failure
stands, the number of `flush-*` files is fixed at whatever the failure stranded,
so the `pendingBytesSync` sweep stops growing too.

**A forced flush always rotates.** `force` is what every caller passes that
needs "everything captured so far is committed once this resolves":
`--refresh always`, `hyp query refresh`, the commit after a backfill, and the
sink and table-format export paths that read the table immediately afterwards.
Suppressing their rotation would let a flush that succeeds against a
freshly repaired cache return `flushed: true` having left the newest rows in
`active.jsonl`, with no error and no warning - the "committing without the
flushed rows would report success while silently dropping data" case the export
paths flush to prevent, and a violation of the strictness LLP 0321#decision
settled for `always` and this document claims to leave standing. Forced calls
are user- or tick-paced rather than query-paced, so exempting them costs at most
one stranded file per explicit request and does not restore the growth this rule
exists to stop.

Nothing is lost by not rotating. The rotation exists to close a file so it can
be read, and the files already waiting cannot be read past their first append.
A rotation now would only add a file to a set nothing is draining. The rows are
equally durable in `active.jsonl` (the append path fsyncs them there before it
returns, and `pendingBytesSync` counts the active file, so the spool byte
threshold still applies backpressure), and they are equally visible to
`readSpooledRows`. In the healthy case the rule is inert: a completed flush
leaves no stamp and no files, so the condition is never met.

<a id="degrade-reaches-the-signals"></a>**The degrade reaches the span status
code and the run metric.** Two narrow changes, and deliberately not one broad
one:

- `span_helpers` gains `markSpanStatus(span, status)`. It writes the `status`
  attribute as before and records the status as the span's terminal one;
  `withSpan` and `runRoot` both read that in preference to the creation-time
  snapshot, because the helper takes a span rather than a frame and a caller
  cannot tell which of the two opened the one it holds. The
  degrade path calls it, so a degraded query ends `SpanStatusCode.ERROR` with
  the status as its message.
- `settlePendingCacheForQuery` returns whether it degraded, and the SQL run
  records `queryRunsTotal` and `queryDurationMs` with `status: 'degraded'`
  rather than `'ok'` when it did.

The narrowness is the point. Making `withSpan` re-read the live `status`
attribute for every span would have been one line, and it would have silently
reclassified every span in the repo that writes `status` late: the wizard's
`skipped`, the context-graph maintenance walk's `partial`, the sink driver's
`degraded`. Those are LLP 0021 spans whose status codes were never argued about
here, and this document does not get to decide them by side effect. An opt-in
call changes exactly the call site that asked.

`ERROR` is the code because the repo's own `withSpan` rule already reads any
non-`ok` status that way, and because OTel has no third code between `OK` and
`ERROR` for "answered, but not from current data". A degraded query still
returns rows and still exits zero. The status code is where the fleet-wide
signal lives, and a broken cache is a condition an operator should be paged
about even though each individual query looked fine to the person who ran it.

## Consequences {#consequences}

- Under a standing cache rejection the spool stops fragmenting, the doomed
  append is retried at most six times an hour per table instead of once per
  query, and the `pendingBytesSync` sweep stops growing. Before this, all three
  scaled with query traffic.
- A query that arrives inside the window still says the cache may be stale. It
  is degraded for the same reason and reports it the same way, so the user-facing
  behaviour LLP 0321 settled does not flicker with the window. The cooled case
  is separable in telemetry by `cache_refresh_cooling_down` on the span and by
  its own `query.cache_refresh_cooling_down` log event.
- A repair is picked up by the first query more than a window after the last
  failed attempt, or immediately by any `--refresh always`, or immediately after
  the daemon's next successful scheduled flush clears the stamp.
- Rows captured while a failure stands sit in `active.jsonl` rather than in a
  rotated file. They are fsynced, counted toward the spool threshold, readable
  by `readSpooledRows`, and flushed by the first forced attempt, or by the first
  unforced attempt after the repair has drained the stranded set.
- Spans and run metrics for degraded queries change classification. A dashboard
  counting `queryRunsTotal{status="ok"}` as "all successful runs" will see
  degraded runs move to their own bucket, which is the correction, and error-rate
  alerts on query spans will now fire on a broken cache.
- The spool directory gains one small JSON file per table, and only while a
  failure stands. An older build ignores it; this build treats its absence as
  "the last attempt is not known to have failed", which is what every spool
  written before this document is.
- No cache schema, partition layout, spool record format, sidecar format, config
  key, or runtime dependency changes.

## Alternatives considered {#alternatives}

### Advance `lastFlushAtMs` on a failed flush

Rejected, and it is the tempting one because it needs no new file: the existing
debounce would then close on its own. But `lastFlushAtMs` is read as the age of
the last *write to the cache*, and the staleness line the user is shown quotes
it directly (`cache: last write to query cache was N minutes ago`). Stamping a
failure into it would make that line assert a write that did not happen. A
separate field keeps the freshness report honest and keeps the pacing state from
being mistaken for a verdict, which is LLP 0319's core caution.

### Hold the cooldown in memory instead of on disk

Rejected. `hyp query` is a short-lived process, so an in-memory stamp is
discarded before the next query reads it, which is the entire population the
cooldown exists to pace. LLP 0319 put its stamp in the cursor for the same
reason.

### Stop rotating entirely while a failure stands, with no file condition

Rejected. When the failure stamp is stale by a window and the flush is being
retried for real, the rotation is exactly what lets newly captured rows be part
of that retry. Gating on "files are already waiting" keeps the retry able to
rotate once there is nothing stranded.

### Delete or coalesce the stranded `flush-*` files

Rejected. Their contents are captured rows that were never committed, so
deleting them loses data, and rewriting them into one file means re-reading and
re-writing records the append path is careful never to tear. Not minting new
ones bounds the set without touching the records, and the first successful
flush drains the whole set anyway.

### Re-read the live `status` attribute in `withSpan` for every span

Rejected. See #degrade-reaches-the-signals. It reclassifies unrelated spans
across the repo as a side effect of a decision about queries.

## Tests {#tests}

Traditional tests pin: the failure stamp written on a thrown flush and cleared
on one that completes; the cooldown gate skipping `flushTable` entirely inside
the window and attempting it again once the window is past; an unreadable or
future-dated stamp reading as "not cooling down"; the cooled query still
reporting degraded; the suppressed rotation leaving the flush-file count fixed
across repeated failing flushes under live appends; a forced flush against a
repaired cache still committing rows captured while the failure stood;
`withSpan` and `runRoot` both ending a `markSpanStatus`-marked span as `ERROR`
while an ordinary late `setAttribute` is left alone; and `queryRunsTotal`
carrying `status: 'degraded'`.

## Extends {#extends}

LLP 0321#decision settled that an automatic refresh failure serves the confirmed
cache with one warning, that forced refresh stays strict, and that the spool
owns durability on the failure path. All three stand unchanged. What this
document adds is the bound on the repetition that decision creates, in LLP
0319's idiom, and the delivery of the degraded signal LLP 0321#observability
already specified to the two places an operator actually watches.
