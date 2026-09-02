# LLP 0352: Repairing a partition whose cursor cannot be read

**Type:** RFC
**Status:** Draft
**Systems:** Cache, Privacy, Observability
**Generated-by:** neutral
**Author:** Phil / Claude
**Date:** 2026-09-02
**Related:** LLP 0013, LLP 0027, LLP 0069, LLP 0104, LLP 0253, LLP 0310,
LLP 0322, LLP 0323, LLP 0331, LLP 0332, LLP 0334, LLP 0344, LLP 0347;
hyparam/hypaware#1174, hyparam/hypaware#1170, hyparam/hypaware#1131,
PR #1173, PR #1135

> A partition whose `cursor.json` is present and does not read is invisible
> to every reader and, since LLP 0347, closed to every write. Nothing in the
> tree repairs one. That was survivable while the next append rewrote the
> cursor by guessing, and LLP 0347 withdrew that guess because on a compacted
> partition it cost the partition its whole history (#1170). Its own
> `#not-decided` section says what withdrawing it leaves behind: "a deletion
> request against such a partition now silently does nothing for as long as
> the cursor stays broken", and that this "belongs with LLP 0344's repair
> answer, and it is the reason that answer cannot wait indefinitely."
>
> This document is that answer's request. It states the three questions the
> repair answer has to settle, carries the evidence for each, and puts the
> options up with their costs. It decides nothing, and it reopens nothing
> that LLP 0347 settled.

## Context {#context}

Three facts, each already recorded elsewhere, meet on one partition.

**The read side goes quiet.** `resolveIcebergDir` in
`src/core/cache/storage.js` resolves a partition through `readCursorSync`,
which is `tryReadCursorSync(...) ?? { epoch: 0, rowCount: 0, compaction:
null }`. An unreadable cursor therefore arrives as a layout-less epoch-0
cursor, and the resolver answers the partition directory itself. Nothing
holds an Iceberg table there, so query, sinks, sync, compaction planning and
purge all see an empty partition. That is LLP 0344#unreadable-cursor, still
open.

**The write side now refuses.** LLP 0347#file-not-reader draws the
missing-versus-unreadable distinction on the cursor file's presence rather
than on the reader's answer, so an append onto a present-but-unreadable
cursor throws instead of publishing `table` over a live `table-<ms>`
generation. The rows wait in the spool (LLP 0347#rows-wait), durably, under
the LLP 0322 failure stamp.

**Nothing repairs the file.** There is no `hyp` verb that rewrites, rebuilds,
or quarantines a `cursor.json`. `hyp query maintain --force` reads the
partition through the same defaulting reader and plans nothing; the orphan
sweep reaches the refusing gate and declines to call any sibling an orphan
(LLP 0323#one-gate), which is exactly what keeps it from deleting the real
generation. So the state is stable, bounded, visible, and permanent until a
human edits the bytes by hand.

The condition is reported. `tryReadCursorSync` WARNs once per condition per
rewarn window with `error_kind: cursor_unreadable` (LLP 0332
#transition-plus-rewarn), retracted when a read stops refusing (LLP 0334
#recovery-is-announced), and `hyp status` capture-health prints the standing
flush failure quoting the refusal message and naming the table
(`src/core/commands/status.js:809`). What is not reported is the
consequence, and the consequence is what the three questions below are
about.

## What is on disk, reproduced {#evidence}

Independently reproduced against `master` at `7adb07af`, no mocks: a
source-table `ai_gateway_messages` partition holding two rows whose `cwd` is
`/home/u/secret`, then `cursor.json` overwritten with `{ not json`, then a
subtree purge of exactly that directory.

```
rows healthy                2
WARN cache.cursor_read      error_kind=cursor_unreadable  partition_dir=.../source=claude
resolveIcebergDir now ->    (the partition directory itself)
dirs on disk                cursor.json, table
purge summary               {"rowsDeleted":0,"partitionsAffected":0,"purgedCwds":[],
                             "retainedAliasRows":0,"retainedAliasCwds":[]}
rows still on disk in table 2
after repair                2 rows readable again
```

Three things in that trace matter and are not the same thing.

The purge did not fail. `purgeCache` calls `tableExists(resolveIcebergDir(
part.path))` and `continue`s when it is false (`src/core/cache/purge.js:66`),
so the partition is skipped by the same branch that skips a partition holding
nothing. `runPurge` renders the summary as `purged 0 rows from 0 partitions`
and exits 0, which is byte-identical to a purge whose target genuinely
matched nothing.

The rows did not go anywhere. Both are still readable directly out of
`table/`, in the live generation, on the machine the user asked to delete
them from.

And repair restores them to every reader at once, including the ones that
ship. Sink watermarks are per (sink, partition) and advance only over rows a
sink actually read (`readRowsSince` in `src/core/cache/storage.js`), so rows
that were still unshipped when the cursor broke are still newer than the
watermark after it is fixed. Repairing the cursor makes them syncable again,
after a purge that told the user there was nothing to delete.

## Question 1: what repairs a refused partition {#repair}

### What is there

Nothing. LLP 0347 names this in as many words: "A refused partition stays
refused until its `cursor.json` is replaced. Nothing here rebuilds one,
quarantines the partition, or surfaces it anywhere the WARN does not."

The operator has the partition path (from the WARN and from `hyp status`)
and the refusal message, which names both causes the gate cannot tell apart:
bytes that do not parse, and a `tableDir` that parses but escapes its own
partition (LLP 0323#one-gate). What the operator does not have is the one
fact a correct cursor needs, which live generation the partition's rows are
in, on a partition that has been compacted onto a `table-<ms>`. The
directory listing is not much help either way. On a refused partition
nothing ages out as an orphan at all: the orphan branch of `walkForRetired`
runs only when the cursor named a live generation
(`src/core/cache/maintenance.js:2800`), so `ORPHAN_GRACE_MS` never applies
here and only a generation already carrying a `.retired` marker is reclaimed,
after `GRACE_PERIOD_MS`. And the newest directory is not reliably the live
one: a generation swap writes the new generation's data files, then the
cursor, then the old generation's `.retired` marker, so a crash before the
cursor write leaves a newer directory that was never published, and on this
partition it is never swept away.

### Options {#repair-options}

1. **Leave it as a manual edit, and document it.** Write the recovery into
   `docs/` and point the refusal message at it. Cheapest, adds no surface,
   no new state. Costs: the operator is asked to choose a live generation on
   evidence that does not determine one, which is LLP 0344 Option 4's guess
   with none of its care and no code review in front of it; and on a machine
   where nobody reads the WARN the partition simply stays refused, its spool
   growing with ingest until someone notices the pending bytes.
2. **A `hyp` verb that rebuilds the cursor from the directory.** Something
   like a cache repair subcommand that picks a generation and writes a
   well-formed cursor over it, with `rowCount` recounted from the table it
   picked. Ends the suspension without a hand edit. Costs: it is the guess
   LLP 0323#whole-cursor refused to make at read time, moved behind a verb;
   getting it wrong publishes a stale generation and unreferences the real
   one, which the orphan sweep then reclaims, which is #1170 again with a
   human in the loop instead of a schedule. Any version of this that is
   defensible probably has to refuse an ambiguous partition rather than
   guess, which turns it into option 3 for the hard cases.
3. **A `hyp` verb that quarantines rather than repairs.** Move the partition
   directory aside under a name nothing resolves through, so the dataset
   starts a fresh partition and accepts writes again, and the quarantined
   bytes stay on disk for a human or a later tool. Ends the write stall
   without deciding which generation was live, and keeps every row
   inspectable. Costs: the quarantined rows are outside the cache, so they
   are outside retention, outside purge and outside `hyp status` unless
   something is taught to look; and it needs a home on disk plus a rule for
   when, if ever, it is reclaimed, which is LLP 0013 territory.
4. **Repair only the unambiguous cases, refuse the rest.** A partition with
   exactly one plausible generation (nothing compacted, or exactly one
   `table-*` present) is repairable from the directory with no guess at all;
   a partition with several is quarantined or left to a human. Narrowest
   correct rule. Costs: two mechanisms rather than one, and the case that
   most needs help is the one it declines.
5. **An automatic repair on the maintenance tick.** Any of the above without
   a human. Costs: it is the shape of #1170, a schedule acting on a cursor
   nobody could read, and this series has already paid for that once.

### What a decision needs to say

Whether repair is manual, verb-driven or automatic; whether a repair may
choose a live generation on directory evidence alone and what it does when
the evidence does not determine one; where quarantined bytes live and what
governs them; and what the operator-facing instruction is, given that the
refusal message is what an operator actually reads.

## Question 2: a purge cannot say which partitions it could not read {#purge-report}

### What is there

`purgeCache` skips an unreadable partition through the same `continue` that
skips an empty one, and `PurgeSummary` (`src/core/cache/types.d.ts:66`)
carries `rowsDeleted`, `partitionsAffected`, `purgedCwds`,
`retainedAliasRows` and `retainedAliasCwds`. None of them can hold "and
there were partitions I could not read". `runPurge` therefore prints a
truthful count of what it deleted and no indication that the count was taken
over a subset of the cache.

The same gap exists on the retention pass, where LLP 0344
#unreadable-cursor Option 3 already names it, and #failing-partition asks
the same question about partitions a pass could not enforce. That is three
call sites wanting one vocabulary, which argues for one answer rather than
three fields invented separately. PR #1173 deliberately added none of them.

Note that this is the *report*, not the deletion. Whether a purge may delete
through a cursor nobody could read is Question 1's territory and LLP 0344
Option 4's; a purge that cannot resolve the table cannot delete from it
either way.

### Options {#purge-report-options}

1. **Leave it.** The WARN names the partition on the log channel at the
   moment the purge read it. Costs: the user of a privacy verb is told "0
   rows deleted" over rows that are on disk, and the only correction is a
   stderr line from a different subsystem that most callers of `hyp purge
   --json` never see.
2. **Count them on the summary.** One number: partitions skipped as
   unreadable. Smallest addition that makes the count honest, and it renders
   on both the text and `--json` paths. Costs: a field on `PurgeSummary` and
   its two renderers, and a number without names does not tell an operator
   which partition to repair.
3. **Name them on the summary.** The partition paths, the way
   `retainedAliasCwds` already names the rows a subtree purge deliberately
   did not take. Consistent with the surface that exists, and it hands the
   operator exactly the argument a repair verb would want. Costs: a
   string array on the result, and paths on stdout that the `--json`
   consumers will start depending on.
4. **Make the purge exit non-zero when it skipped a partition.** A privacy
   verb that could not see part of the cache did not do what was asked.
   Strongest signal, and the only option a script notices. Costs: a purge
   that deletes most of what was asked now looks like a failure, and
   `hyp purge` is called from the privacy review skill, so the failure has
   to be actionable or it will be worked around.
5. **One vocabulary for all three passes.** Whatever shape is chosen,
   `RetentionResult` and the purge summary use it, and `hyp status` states
   it once. Costs the most and settles the most, and it is the option LLP
   0344 #failing-partition and #unreadable-cursor both point at.

### What a decision needs to say

Whether a pass that could not read a partition reports that fact on its
result, as a count or as names; whether it changes the verb's exit status;
whether purge and retention share one shape; and which surface states it
outside the log channel.

## Question 3: a purge issued while blind must not be satisfied by repair {#purge-then-repair}

### What is there

This is the one with a privacy consequence rather than an operability one,
and it does not go away if Questions 1 and 2 are answered well.

The sequence, every step of it observed in #evidence above:

1. The cursor stops reading. The partition's rows are invisible to every
   reader, and unshipped rows stay unshipped: a sink's watermark advances
   over rows it read, and it read none.
2. The user runs `hyp purge /home/u/secret`. It reports 0 rows from 0
   partitions and exits 0. Nothing on that output says a partition was
   skipped, and after LLP 0347 nothing will later rewrite the cursor on its
   own.
3. Someone republishes a live generation for the partition, by any of
   Question 1's repairing options. Option 3 quarantines instead of
   repairing, so it does not reach step 4 at all: the rows stay out of
   every reader, which is the one thing that option buys here.
4. The rows are readable again, still carrying their original
   `_hyp_ingest_seq`, still newer than the sink watermark, and the next sink
   pass ships them onward.

That sequence has two populations in it, not one. Step 1's rows were
committed before the cursor broke. Everything captured during the window is
in the cache spool instead, because LLP 0347's gate refuses the append and
the chunk waits whole (#spool below). The purge in step 2 misses those for
the same reason it misses the committed ones and one more: `purgeCache`
reads committed Iceberg tables only, `runPurge` settles nothing before it
scans (`src/core/commands/purge.js:90`), and its one spool action sweeps the
raw body spool rather than the cache spool (`:108`, LLP
0253#purge-and-detach-sweep, which sweeps that sibling for exactly this
reason). Step 4 then commits them along with the rest. It is the larger
population, not a corner: #spool records that `active.jsonl` grows with the
dataset's total ingest for as long as the refusal stands.

The user asked for deletion, was told there was nothing to delete, and the
data left the machine afterwards. LLP 0104 draws the purge boundary at the
cache and says server-side deletion is out of scope, so a row that reaches a
sink after a purge is not recoverable by any local verb. That makes the
ordering hazard categorically different from the two questions above: those
cost visibility and disk, this one costs the promise the verb exists to
keep.

Nothing today records that a purge ran while a partition was blind. The
purge is stateless: it deletes and returns. A repair therefore has no way to
know that a deletion request is outstanding against the rows it is about to
make visible, and a sink has no way to know either.

### Options {#purge-then-repair-options}

1. **Leave it, and make the instruction carry it.** The refusal message and
   the docs tell the operator that repairing a partition means re-running
   any purge issued while it was refusing. Cheapest, no new state. Costs:
   correctness rests on a human reading a message and remembering a purge
   that may have been run weeks earlier by someone else, and the failure is
   silent and unrecoverable. It also assumes the operator can time the
   re-run, and for the spooled rows they cannot: the flush that commits
   those answers to the daemon and the query gate under LLP 0322's cooldown,
   so a re-run issued the moment repair lands can still precede the drain.
   The issue that carries these findings proposes exactly this as the
   interim instruction, which is a fair reading of "cheapest thing that is
   better than nothing", not of "sufficient".
2. **A repair re-runs the outstanding purges.** Repair is not complete until
   every purge issued during the blind window has been replayed against the
   repaired partition. Costs a durable record of purge requests, which does
   not exist and which is itself privacy-sensitive: a list of the
   directories and sessions a user asked to erase is exactly the sort of
   thing that should not outlive the erasure. Any version of this has to say
   what that record holds, where it lives, and when it is discarded.
3. **A repaired partition is quarantined from onward flow until re-purged.**
   Rather than recording the requests, mark the partition as having been
   invisible to a purge, and hold it back from sinks and sync until
   something clears the mark. Inverts the problem: no purge history, one
   per-partition bit. Costs a new piece of persisted per-partition state
   (LLP 0013 territory, and the same state #failing-partition's quarantine
   option wants), plus a rule for what clears it, and it withholds rows the
   user never asked to delete.
4. **A purge that could not read a partition does not return success.**
   Question 2 option 4, read as a safety property rather than a reporting
   one: the request is not satisfied, so it is not reported satisfied, and
   the user is the one who decides what to do about it while they still
   remember making the request. Costs what option 4 above costs, and it
   protects only the user who reads the output.
5. **Repair deletes rather than repairs, for the blind window.** If a
   partition was blind while a purge ran, treat its unshipped rows as
   unsatisfiable and drop the partition instead of publishing it. Fails
   toward deletion, which is the direction this whole series refuses: it
   destroys rows the user never asked about, which is #1170's shape.

### What a decision needs to say

Whether a purge issued while a partition was unreadable is treated as
satisfied, outstanding, or failed; if outstanding, what durable record makes
it so and how that record is itself bounded and erasable; whether a repaired
partition may reach a sink before that request is replayed; and what the
operator instruction is in the meantime.

## The spool consequences waiting on the same answer {#spool}

Two further findings from the review of PR #1173 are recorded here rather
than opened separately, because both are properties of LLP 0347's accepted
design and neither can be addressed without the repair answer above.

**One unreadable cursor stalls a whole dataset's flush.** The spool is keyed
by the dataset's spool table, not by destination partition, and every client
writing `ai_gateway_messages` spools to one table
(`hypaware-core/plugins-workspace/ai-gateway/src/dataset.js:57`). The
pre-flight in `appendChunk` asks every partition in a chunk before
committing any of them, so a chunk touching one refused partition waits
whole and `active.jsonl` grows with the dataset's total ingest rather than
with traffic to the bad partition. LLP 0347#rows-wait accepted this
deliberately and said why the alternative was deferred: buying back
containment means "holding just the refused group's rows somewhere durable
while the rest of the chunk commits and checkpoints", which "needs a place
on disk to hold them that does not exist", and it "stays with the repair
question below". This document is that question. A decision that adds a
quarantine location (Question 1 option 3) may or may not be the same
location; a decision that leaves repair manual leaves the stall bounded only
by how fast an operator responds.

**The pre-flight can half-commit once.** `appendRefusalReason` states it in
its own JSDoc: a cursor corrupted between the pre-flight and the commit loop
leaves the groups committed before it under an unwritten checkpoint, so
after repair that chunk replays and those groups gain their share of it a
second time. It is bounded to one occurrence, because the refusal is a
standing condition and every later tick refuses at the pre-flight, and it is
the pre-existing hazard shape of any fan-out append that fails partway (an
ENOSPC mid-loop behaves identically). A real fix is per-partition spool
progress or a transactional multi-partition commit. Neither is worth its
cost against this fault alone; both become cheap to consider if a repair
answer touches the spool, and the duplicate lands precisely at repair time,
which is when a decision here can arrange for it not to.

## What this document does not open {#not-opened}

**LLP 0347's refusal.** The append gate stays exactly as it is. Every option
above is downstream of it, and the two options that would weaken it
(automatic repair on the maintenance tick, and deleting a blind partition's
rows) are listed with the reason they are the shape of the defect the gate
was added for.

**LLP 0344's read-side options.** Whether retention may delete a partition
whose cursor cannot be read is #unreadable-cursor's question and stays
there. This document assumes only what is already true, that a resolver
which cannot find a table deletes nothing from it.

**The unattributed test failure.** hyparam/hypaware#1174 item 4 records one
full-suite failure during review round 2 whose name was not captured and
which did not reproduce in twelve subsequent runs or in CI. It is not
evidence of a defect and it needs no action; if a flake surfaces in this
area again, its name belongs on that issue.

## References {#references}

- [LLP 0347](./0347-an-append-refuses-a-cursor-it-cannot-read.decision.md):
  `#file-not-reader`, the gate whose consequences these questions are;
  `#rows-wait`, the accepted dataset-wide stall and the containment it
  defers here; `#not-decided`, which names repair as due rather than open.
- [LLP 0344](./0344-retention-under-fault.rfc.md): `#unreadable-cursor`, the
  read side of the same fault, and `#failing-partition`, which asks the same
  reporting question about partitions a pass could not enforce.
- [LLP 0323](./0323-cursor-names-a-generation-in-its-own-partition.decision.md):
  `#one-gate`, the reader every destructive path shares; `#whole-cursor`, the
  re-derivation refused at read time that a repair verb would have to make
  somewhere.
- [LLP 0322](./0322-a-failed-automatic-refresh-cools-down-and-is-visible.decision.md):
  the failure stamp and coalesced retry that make a refused append a wait.
- [LLP 0104](./0104-hyp-purge.decision.md): the purge boundary, which
  ends at the local cache and is why a row shipped after a purge is beyond
  local recall.
- [LLP 0013](./0013-local-query-cache.decision.md):
  `#retention-is-the-central-tradeoff`, and the home of any new on-disk cache
  state a quarantine or a blind-window mark would need.
- [LLP 0332](./0332-cursor-refusal-warns-on-transition-then-rewarns.decision.md)
  and [LLP 0334](./0334-the-escape-report-tracks-the-partition-it-names.decision.md):
  the standing refusal report and its retraction, the whole of what is
  reported today.
- hyparam/hypaware#1174: the deferred findings this document takes up, with
  the head each was verified at.
- hyparam/hypaware#1170 and PR #1173: the destruction that made the append
  refuse.
