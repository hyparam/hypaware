# LLP 0218: A compaction retry spent by a failed attempt is a stated skip reason

**Type:** Decision
**Status:** Accepted
**Systems:** Cache
**Author:** Kenny / Claude
**Date:** 2026-08-13
**Related:** LLP 0217 (the effectiveness verdict and the retry stamp this extends), LLP 0199 (the baseline gate both sit on), LLP 0207 (the recognition path that writes the same stamp)
**Extended-by:** [LLP 0220](./0220-maintenance-walk-survives-a-partition.decision.md) (the tick in which the attempt fails is reported too: `failed` is this tick's error, beside the `compactionAttemptFailed` skip an earlier one recorded); [LLP 0226](./0226-maintenance-skips-are-a-standing-surface.decision.md) (the standing record this document describes stops being a `hyp query maintain` line and a span attribute: the daemon tick summarizes both skip reasons into `status.json`, where `hyp status` finds them)

> The stamp a failed compaction retry writes records the moment the attempt
> failed, so the ticks that skip the partition afterwards can say why. A
> partition frozen by a rewrite that threw is reported for as long as it stays
> frozen, exactly as one frozen by a recorded ineffective verdict already is.

## Context {#context}

LLP 0217 made a partition maintenance deliberately leaves fragmented a stated
outcome: the cursor records what the last rewrite achieved, and a tick that
skips a partition on that verdict reports `compactionIneffective` rather than
folding it into a "0 partitions compacted" summary.

That covers the partition whose rewrite ran and accomplished nothing. It does
not cover the partition whose rewrite threw. LLP 0217#retry-on-writer-change
settled that the *attempt* spends the writer generation's retry, so a rewrite
that fails stamps the cursor on the way out, and it settled that the stamp
carries no effectiveness claim, because a rewrite that threw part-way proves
nothing about whether the partition can be shrunk. Both halves are right, and
together they leave a hole: the skip report requires a recorded verdict, and
the failure path deliberately records none, so from the next tick on the
partition is skipped with no report, no `hyp query maintain` line, and no span
attribute.

Reproduced from PR #735's own fixture (#739): after a torn data file makes the
retry throw, the following tick's partition report is byte-identical to a
healthy converged partition's, while the partition still holds the torn file
and is still fragmented. The failing tick logs `daemon.maintenance_failed` and
its partition span carries the error, so the evidence exists exactly once, in
a log line that scrolls away. The ongoing state does not. That is the same
legibility gap #723 was filed about, one layer down.

## Decision {#decision}

<a id="report-the-spent-attempt"></a>**A spent attempt is recorded and
reported.** The stamp gains `attemptFailedAt`, the timestamp of the failure
that spent the retry, written beside `writerGeneration` and beside nothing
else: the baseline and any recorded effectiveness stay exactly as they were.
A tick that skips a partition whose cursor carries that stamp reports
`compactionAttemptFailed` with the recorded timestamp, `hyp query maintain`
prints it, and the partition span carries `compaction_attempt_failed`. The
message names `--force`, which is the documented and unchanged way to ask for
another attempt.

Like the ineffective skip report, this reads the cursor and nothing else.
Proving the partition is *also* still fragmented would mean stat-ing every
data file of every converged partition on every tick, which is the cost the
LLP 0199 gate exists to avoid.

<a id="verdict-outranks-error"></a>**A verdict outranks an error.** When the
record carries an effectiveness claim the report is that claim, not the
failure that followed it. A rewrite can throw after committing its cursor (the
case LLP 0217 re-reads the cursor for), and it can throw long after some
earlier rewrite recorded a verdict that still stands. In both the recorded
claim says something about the partition and the error says only that an
attempt ended, so `compactionIneffective` is what a reader sees and
`compactionAttemptFailed` is suppressed. A stamp naming a writer generation
this build does not run is suppressed too: that partition is owed a fresh
attempt, so it is not frozen by the old failure at all.

The recognition path (LLP 0207) drops `attemptFailedAt` where it already drops
effectiveness. A recognized partition keeps the foreign compactor's layout by
design, so a failed kernel rewrite has stopped being the reason it is skipped.

## Consequences {#consequences}

- Nothing about when a partition is compacted changes. The new field is read
  by the reporting branch only: it is not consulted by the baseline gate, by
  `compactionVerdictStale`, or by any dueness heuristic, so it cannot grant a
  retry and cannot reopen the rewrite-forever loop LLP 0199 closed. The retry
  is still one per writer generation, spent by the attempt.
- The report clears itself when the condition does. A rewrite that commits
  writes a fresh compaction record rather than amending the old one, so a
  later success (from `--force`, from new data flushing in, or from the next
  writer generation) drops the note with the same write that supersedes it.
- The cursor stays compatible both ways. An older build reads the compaction
  record by probing the fields it knows, so one extra string key is ignored;
  this build treats a cursor with no `attemptFailedAt` as one whose last
  attempt is not known to have failed, which is what every cursor written
  before this document is.
- A partition can be reported as skipped for a failed attempt indefinitely,
  which is the point: it stays frozen indefinitely. The line is the standing
  record of a partition maintenance has stopped working on, and it costs one
  cursor read that the tick already does.

## Extends {#extends}

LLP 0217 settled that a partition skipped by maintenance is skipped for a
stated reason, and that the retry is spent by the attempt rather than by its
success. Both stand. What this document adds is the reason for the case those
two decisions create between them: an attempt that was spent and proved
nothing is itself the reason, and saying so is not a claim about
effectiveness.
