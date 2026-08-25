# LLP 0217: A compaction records what it achieved, and an ineffective verdict expires with its writer

**Type:** Decision
**Status:** Accepted
**Systems:** Cache
**Author:** Kenny / Claude
**Date:** 2026-08-13
**Related:** LLP 0199 (the baseline gate this extends), LLP 0209 (the writer change that made a stale verdict reachable), LLP 0027 (the re-settle baseline the gate was built from)
**Extended-by:** [LLP 0218](./0218-compaction-failed-attempt-reported.decision.md) (the stamp a failed retry writes carries no effectiveness claim, so the skip report below cannot speak for it: the stamp records when the attempt failed and the skip is reported on that instead); [LLP 0228](./0228-maintenance-skips-are-a-standing-surface.decision.md) (the verdict's skip report stops being visible only to whoever runs `hyp query maintain` or queries the trace: the daemon tick summarizes it into `status.json` and `hyp status` renders it); [LLP 0310](./0310-in-place-subset-compaction.decision.md) (routine dueness is served by an in-place subset rewrite, and a partition at its identity-partitioning floor receives the ineffectiveness verdict by inspection, without the rewrite that used to reproduce its layout; writer generation 3)

> The partition cursor records the data-file count a rewrite started from
> beside the count it produced, so "the live count sits on its baseline" can be
> read as either *this partition converged* or *this rewrite achieved nothing*.
> A partition skipped for the second reason is skipped explicitly, is reported
> as such, and is owed exactly one retry when the compaction writer that
> reached that verdict is replaced.

## Context {#context}

LLP 0199 made every compaction heuristic conditional on the live data-file
count differing from the count the last rewrite recorded
(`compaction.resettleBaselineFiles`). The premise is that a partition sitting
on its baseline is converged, because rewriting it would reproduce the same
generation.

That premise silently covers two different partitions. One was rewritten from
900 files into 12 and has had nothing flushed into it since. The other was
rewritten from 1,521 files into 1,521 files, because under the pre-LLP-0209
writer a 32 MB in-memory batch landed as a ~200 KB data file and the rewrite
reproduced its own fragmentation. Both record a baseline equal to their live
count, so the gate treats them identically, and each subsequent rewrite
re-freezes the second one at whatever count it produces.

Reported from a real cache (#723): `ai_gateway_messages/source=claude` holding
1,521 parquet files averaging 214 KB against a 32 MB target, both generations
on disk with identical counts, `hyp query maintain --dry-run` reporting 0
partitions compacted, and `--force` immediately flagging the same partition as
due. Nothing in the cursor, the report, or the trace distinguished the frozen
partition from a healthy one; the evidence had to be reconstructed by counting
files on disk.

LLP 0209 has since removed the reason that partition could not be shrunk, which
turns the silence into a durable defect rather than a cosmetic one: the writer
improved underneath a verdict that no longer holds, and there is no mechanism
by which the partition can ever be tried again.

## Decision {#decision}

<a id="record-effectiveness"></a>**A compaction records what it achieved.**
The cursor's compaction record gains `dataFilesBefore`, the live data-file
count the rewrite started from, written beside the existing
`resettleBaselineFiles` (the count it produced). A rewrite is *effective* when
it strictly reduced the count. Any reduction counts: shaving one file off is
progress, and the LLP 0199 gate still requires the live count to move before
the next attempt, so a marginal gain cannot become a rewrite loop. A rewrite of
a partition holding at most one data file is neither: it had nothing to reduce
and is evidence about nothing. One file is a partition's floor, not
fragmentation, and the avg-file-size heuristic flags any partition whose files
sit under `compact_avg_file_bytes`, so without that carve-out every low-volume
partition would take one 1 to 1 rewrite on its first tick and then be reported
as unshrinkable for the rest of its life.

The verdict is reported, not only stored. `MaintenancePartitionReport` gains
`compactionIneffective`, set on a rewrite that reproduced its own count and on
a tick that skipped a partition whose cursor already records that verdict, and
`hyp query maintain` prints both. A partition the kernel is deliberately
leaving fragmented is now a stated outcome rather than an absence in a
"0 partitions compacted" summary. The skip case reads the cursor only: proving
the partition is *also* still fragmented would mean stat-ing every data file of
every converged partition on every tick, which is the cost the gate exists to
avoid.

<a id="retry-on-writer-change"></a>**An ineffective verdict binds only its own
writer.** The compaction record also carries `writerGeneration`, an integer
naming the rewrite implementation that reached the outcome. Generation 1 is
one output file per flushed batch; generation 2 is LLP 0209's streaming
writer, which closes a file on bytes actually written. When a partition sits on
its baseline and its last rewrite is *not* recorded as a reduction (it achieved
nothing, or it predates this record and so is unknown) and the running writer
generation differs from the recorded one, the partition is due again if the
size heuristics still flag it. The retry re-stamps the cursor, so it is one
attempt per writer generation, never one per tick.

The *attempt* spends the retry, not its success. A rewrite that throws (a torn
data file, a settle hook that fails) commits no cursor of its own, so the stamp
is written on the way out of the failure too, carrying no claim about
effectiveness. Otherwise the stale verdict would stand and the partition would
be retried, and fail, on every tick forever; and because the walk goes
neediest-first (LLP 0199#neediest-first) and there is no per-partition catch,
that is the whole maintenance tick lost behind it, every hour.

A rewrite recorded as effective is never retried on this path, whatever
generation produced it. Convergence is what LLP 0199 exists to protect, and an
improved writer is not a reason to rewrite a partition that is already as
compact as its data allows.

The LLP 0207 recognition path writes the same stamp when it re-baselines a
foreign sorted layout, and drops any effectiveness the kernel's own earlier
rewrite recorded there. A recognition is a verdict too, and an unstamped one
would read as owing a retry on every tick, paying a metadata load and a cursor
write forever.

## Consequences {#consequences}

- A partition frozen by a rewrite that achieved nothing thaws once when the
  writer under it changes, and re-freezes with a fresh verdict if the new
  writer also fails to shrink it. The 1,521-file partition in #723 is
  retried under LLP 0209's writer; whether that writer can shrink it depends
  on its distinct partition-tuple count, which LLP 0209#tuple-bound settles
  and this document does not.
- Every cursor written before this document has no `writerGeneration`, so
  every partition the size heuristics still flag compacts one more time and
  then converges. That is the same one-off upgrade cost LLP 0199 accepted for
  cursors written before its baseline field existed, and here it is also the
  point: those cursors are exactly the ones whose verdict came from a writer
  that could not do the job.
- Bumping `COMPACTION_WRITER_GENERATION` is the whole retry mechanism, so it
  is a deliberate act with a cost: it re-opens every ineffective partition in
  every installed cache. Bump it when the rewrite gains the ability to shrink
  a partition it previously could not, and not for changes that cannot affect
  the output file count.
- The cursor stays backward and forward compatible. `tryReadCursorSync`
  passes `compaction` through untyped, every reader of the record probes the
  fields it needs, and a cursor written by this build carries two extra keys
  an older build ignores.
- This is not a fix for compaction that cannot shrink a partition; it makes
  the failure legible and retryable. Falling back to a file-count target when
  the byte target is unreachable (#723's third suggestion) remains open.

## Extends {#extends}

LLP 0199 settled that compaction due-ness is gated on the recorded baseline,
and that stays true: nothing here compacts a partition whose live count has not
moved and whose last rewrite worked. What this document adds is that the
baseline is no longer the only thing recorded about a rewrite, so the gate can
tell convergence from a rewrite that accomplished nothing, and so a verdict
reached by a writer that no longer exists does not outlive it.
