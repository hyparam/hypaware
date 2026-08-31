# LLP 0333: A forced refresh reaches every table before it fails

**Type:** Decision
**Status:** Accepted
**Systems:** Cache, Query, CLI, Daemon
**Generated-by:** neutral
**Author:** Phil / Claude
**Date:** 2026-08-31
**Extends:** [LLP 0321](./0321-auto-refresh-serves-confirmed-cache.decision.md)
(#alternatives: the Rejected "swallow forced-refresh failures too" stands as
an outcome rule - a run with any failure still fails and still reports the
original errors - and this document settles that the outcome is reached only
after every table gets its attempt); [LLP 0330](./0330-the-flush-failure-stamp-is-an-operator-surface.decision.md)
(#warning-diagnostic: the advertised retry now reaches every registered
table in one run, and the diagnostic's message states what the stamp asserts
instead of a present-progressive claim; #query-quotes-the-reason: the
overview's one-reason-per-cause rendering is settled as intended)
**Related:** LLP 0322 (#clearing: the completed attempt that clears a stamp,
which an aborted run denies to every table behind the first failing one),
LLP 0225 (the label policy every stderr interpolation below rides through),
hyparam/hypaware#1116

> `hyp query refresh` is the retry half of the repair pair LLP 0330's
> `cache_flush_failing` diagnostic advertises, and as shipped it could not
> repair the incident that raises the diagnostic: its partition loop awaited
> each forced flush unguarded, `spool.flushTable` stamps and rethrows, so
> with several tables carrying standing failures the first throw aborted the
> run and the rest went untried, on every run, forever. This document
> settles the shape: attempt every table, accumulate the errors, report each
> one, and still exit non-zero. Nothing is swallowed; what changes is only
> how much of the repair happens before the failure is declared.
> `spool.flushAll` shares the shape. Two smaller calls on adjacent surfaces
> ride along: the diagnostic's message drops "is failing" for the
> attempt-tense fact the stamp actually records, and the overview keeping
> one reason line per distinct failing cause is settled as intended.

## Context {#context}

LLP 0321 made `auto` refresh best effort and `always` strict: a caller who
explicitly required the newest data gets the original error, never older
data with a warning. Its Alternatives section rejects "swallow forced-refresh
failures too" on exactly that ground. LLP 0322 stamped each failed flush so
the automatic gate can pace itself, and made any completed attempt clear the
stamp. LLP 0330 rendered the stamps to the operator and settled the repair
pair: enumerate with `hyp status --json`, retry with `hyp query refresh`.

The retry could not do its job. `runQueryRefresh` awaited
`dataset.refreshPartition` and the forced `storage.flushTable` inside its
loops with no guard, and `spool.flushTable` rethrows after stamping. When
several tables carry standing failures and the underlying cause persists,
the first throw aborts the run, the remaining tables go untried, and
repeated runs make no progress past that table. Worse, the abort works
against LLP 0322#clearing: a table behind the first failing one whose own
cause is already fixed never gets the completed attempt that would clear its
stamp, so the diagnostic keeps counting a failure the operator already
repaired. `spool.flushAll` had the same unguarded loop, so a storage-level
flush-everything call also stopped at its first failing table.

The strictness question and the completeness question are different
questions. LLP 0321's rejection is about the *outcome* of a forced refresh
that hit a failure: it must not read as success, and the error must not be
replaced by a warning. It says nothing about whether the other tables in the
same run get their attempt before that outcome is declared. Aborting at the
first table was never the settled behavior, only the unguarded-loop default.

## Decision {#decision}

<a id="every-table-before-failure"></a>**The forced refresh attempts every
table, accumulates every error, reports each one, and still fails.**
`hyp query refresh` guards each dataset's partition discovery and each
partition's refresh-plus-forced-flush attempt. A throw records the failure
(the `dataset/partition` label and the error message) and the loop
continues. After the last attempt, each failure prints one stderr line:

    hyp query refresh: <dataset/partition>: <reason>

with both interpolations cleaned through the label policy (LLP 0225,
`sanitizeLabel`: the label to 120, the reason clamped to 200), because the
reason is whatever the cache rejected with and reaches a TTY. The stdout
summary names the failure count beside the totals, and the run exits 1. A
run with no failures is byte-identical to before and exits 0.

This is an extension of LLP 0321, not a reversal. The rejected alternative
rejected *success over a failure*: returning older data with a warning and a
zero exit. That outcome rule stands whole: any failure means a non-zero
exit, and every original error is preserved and reported rather than
replaced. What this settles is that strictness constrains the outcome, not
the abort order: declaring the failure only after every table has had its
attempt repairs more per run (each completed attempt clears its own stamp,
LLP 0322#clearing) and diagnoses more per run (the operator sees every
standing cause at once instead of one per invocation).

`spool.flushAll` shares the shape: it attempts every table, aggregates the
totals of the tables that flushed, and rethrows the first error after the
last attempt. Its callers keep the throw-on-failure contract they had; what
changes is that the tables behind a failing one keep their flush, and every
failing table gets its stamp refreshed in one pass rather than one per call.

Scope notes. A `refreshPartition` that *returns* `status: 'failed'` rather
than throwing is unchanged by this document, as is the reach gap LLP
0330#warning-diagnostic already concedes: the diagnostic counts stamps found
by the spool walk while this command iterates registered datasets, so a
stamp on an undeclared or deactivated table is still cleared by neither
command, and widening the refresh to the spool walk still belongs to its own
document.

<a id="attempt-tense"></a>**The diagnostic's message states what the stamp
asserts.** The `cache_flush_failing` message read "spool-to-cache flush is
failing for N tables". The stamp cannot witness an ongoing condition: it
asserts that the last attempt failed and that no attempt has completed
since (any completed attempt clears it, LLP 0322#clearing). When the
underlying cause is fixed and nothing has attempted a flush yet, "is
failing" outlives the condition it claims. The message becomes

    last spool-to-cache flush attempt failed for N table(s) (newest: <table>)

which is true in every state the stamp can be read in. The message does not
read `stillCoolingDown`: that is per-table pacing state, it can differ
across the N tables a one-line summary spans, and the capture-health line
directly above already renders it per table as the `[refresh cooling down]`
tag. Everything else LLP 0330#warning-diagnostic settled is untouched: the
kind, the warning severity, the count-plus-newest-table shape, the repair
pair, and `overall` never flipping.

<a id="overview-keeps-distinct-reasons"></a>**The overview keeps one reason
line per distinct failing cause, and that is intended.** LLP
0330#query-quotes-the-reason bounds the reason at one line per query run.
`hyp query overview` issues many runs over disjoint datasets through one
runner, whose `said` set dedupes byte-identical lines; when different
datasets fail for different reasons, each distinct reason surfaces once.
That is the right reading of the bound: the per-run line exists so query
stderr is not an incident dashboard, and the overview's page stays bounded
by the number of distinct causes, not the number of statements (five
sections over the same failing partitions still print one warning and one
reason). Collapsing to the first reason at the runner would tell a person
repairing cause A nothing about cause B, reopening the #1082 gap for every
cause after the first. `hyp status` remains the full per-table list.

## Alternatives considered {#alternatives}

### Keep the first-throw abort

Rejected. The command LLP 0330 advertises as the repair for an N-table
incident could never retry past its first still-failing table, so the
advertised repair was unreachable for exactly the incident that raises the
diagnostic, and a repaired table behind a failing one kept its stale stamp.

### Continue past failures and exit zero with warnings

Rejected, twice over: LLP 0321 already rejected success-over-failure for a
forced refresh, and a repair command that exits 0 while tables still refuse
writes tells a script the repair worked.

### Stop advertising `hyp query refresh` in the diagnostic instead

Rejected. The reach gap LLP 0330 concedes (spool walk versus registered
datasets) is a scope boundary; aborting at the first failure was a defect
inside the command's own scope. Narrowing the advertisement would leave the
defect and remove the repair.

### Fold `stillCoolingDown` into the diagnostic's message

Rejected. It is per-table state summarized by a line spanning N tables, and
the per-table rendering already exists one section up. The fix for the
over-claim is stating what the stamp asserts, not asserting more.

### Dedupe overview reasons by the reason-line prefix

Rejected. It suppresses distinct real causes, and the second cause only
becomes visible after the first is repaired, one repair cycle late each.

## Consequences {#consequences}

- One `hyp query refresh` run now retries every registered table: an
  incident with several standing failures is diagnosed in one run, and a
  table whose cause is already fixed gets its stamp cleared even when an
  earlier table still fails.
- The command exits 1 with each failure on stderr instead of throwing on the
  first. Scripts keying on a non-zero exit are unchanged; the thrown-error
  rendering is replaced by one line per failure plus a count in the summary.
- A clean run's stdout and exit are byte-identical to before.
- `spool.flushAll` still throws on failure (the first error, after every
  table has been attempted), so no caller's error handling changes shape.
- The diagnostic's `message` string changes tense on both planes; its kind,
  severity, repair array, and every other status key are unchanged.
- The overview surface is unchanged in code; its per-cause reason rendering
  is now settled rather than incidental.

## Tests {#tests}

Traditional tests pin: a refresh over one failing and one healthy table
attempts both, flushes the healthy one, exits 1, and reports the failing
table's label and reason on stderr with hostile bytes cleaned; a refresh
with no failures keeps the old stdout line and exit 0; `spool.flushAll`
reaches the table behind a failing one and rethrows the first error;
the diagnostic message carries the attempt-tense wording; and one overview
runner surfaces two distinct reasons from two failing datasets exactly once
each.

The label policy and the guard on discovery get their own pins too, because
neither shows in the happy shape of a failure line: a dataset name carrying
an escape opener, a bell, a zero-width space and a right-to-left override
reaches stderr with all four stripped, and a 500-character reason arrives
clamped to 200 and marked truncated; and a dataset whose
`discoverPartitions` throws is recorded under its own name while the dataset
behind it still gets its forced flush.

The N-table incident this document is written for gets its own two pins,
because a single failure only proves the loop does not break on a throw and
not that the pass survives the failure after that: a refresh over two
failing tables either side of a healthy one reports both causes on separate
stderr lines and counts two in the summary, and a `flushAll` over the same
shape flushes both healthy tables, stamps both failing ones in the one pass,
and still rethrows the first error.
