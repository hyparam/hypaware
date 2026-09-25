# LLP 0438: The GitHub backlog verdict is durable, not a daemon memory

**Type:** Decision
**Status:** Accepted
**Systems:** Plugins, Sources
**Author:** Neutral / Claude
**Date:** 2026-09-25
**Related:** LLP 0367, LLP 0409; hyparam/hypaware#2145, hyparam/hypaware#1305,
hyparam/hypaware#1316
**Extends:** LLP 0360, LLP 0361

> LLP 0361#cadence promises that bounded work remaining resumes within fifteen
> minutes and that the configured interval returns once it is gone. LLP
> 0360#cadence promises that a failure retries on the ordinary cadence instead.
> Neither says where that verdict lives. It lives in the cursor sidecar: the
> tick that sized the work records it, and every reader derives the cadence
> from that record rather than from a boolean in one process's memory.

## Context {#context}

The two promises above were implemented as closure state in
`startGithubSource`. A returning tick assigned its own `result.pending`, and a
throwing tick restored the last returning tick's value. That is an accurate
answer only for a single daemon that never restarts and shares its sidecar with
nobody, and the GitHub plugin is neither:

- **Another process writes the same sidecar.** `hyp github sync` and
  `hyp github backfill` run `runCaptureTick` against `github-cursors.json` in
  their own process (LLP 0361#budget). One that retires the last outstanding
  continuation cannot clear a boolean held in the daemon's memory, so the
  daemon kept the fifteen-minute cadence, and `hyp status` kept reporting
  `backlog_pending: true`, for work that no longer existed. Forty consecutive
  throwing ticks were measured re-asserting it (#2145).
- **The daemon restarts.** A fresh closure starts at `false` and `reload()`
  resets nothing, so durable budgeted work on disk lost its backlog cadence
  whenever the boot tick also threw, falling back to a full poll interval
  (#2145, measured identically across three heads).

The exact answer is not derivable from the rest of the sidecar. A rotation
stopped by an exhausted budget and a rotation that finished both leave
`cursors.next_repo` set (#1316), and a repository cursor holding `work` is
equally the residue of a *failure*, which LLP 0360#cadence explicitly refuses
to call backlog. So scanning cursors for `work` over-reports in one direction
and under-reports in the other, which is exactly the open question #1305 poses
about `pending` after a failed enumeration.

Two mechanisms were admissible: a durable pending marker, or a `pending:
undefined` "this tick learned nothing" contract threaded through `tick.js`,
`commands.js` and `source.js` so the source keeps its previous flag.

## Decision {#decision}

### The verdict is a cursor field {#durable-verdict}

`CursorState` gains one optional boolean, `pending`. It is the last capture
verdict any process reached over the whole inventory: true when that tick
ended with bounded work remaining in the LLP 0361#budget sense, false when it
did not.

The durable marker is chosen over the "learned nothing" contract because the
"learned nothing" contract only preserves state a process already holds. It
answers neither of the two failures above: a restarted daemon has learned
nothing *and* remembers nothing, and a sidecar retirement is something the
daemon must *learn*, not something it can preserve. The marker answers both,
because it is the one place both processes already meet.

A new field is added rather than derived because nothing on disk distinguishes
budget residue from failure residue (#1316), and the difference is precisely
what LLP 0360#cadence turns on. `pending` records the distinction at the only
moment it is known: when the tick that made it commits its cursors.

### Who writes it {#writers}

The tick that persists cursors writes the verdict alongside them, under the
same lock and the same whole-file rewrite, so a reader never sees cursors and
verdict disagree.

A tick narrowed by `hyp github backfill owner/repo` may *set* the marker and
never clears it, for the reason a narrowed run does not publish `next_repo`
(LLP 0361#budget): its verdict covers a subset, so work remaining in it is real
while work absent from it says nothing about the rest of the inventory.

A tick that throws sized nothing, so it has no verdict of its own to carry into
the closing write it still makes to save per-repo progress. That write deletes
the marker from its snapshot before committing, so `writeCursors` takes
whatever verdict is on disk at that moment instead of re-asserting the one this
tick read at the top, minutes earlier on a long-running tick, and possibly
already retired by another process. This is the "learned nothing" contract,
obtained the same way as before: the field is data, so recording no opinion
about it is the same thing as preserving whatever is already there.

The early return taken when a `session_repos` inventory read fails deliberately
does **not** write the marker. That path holds a snapshot read before it
failed, and it is the one tick path that never persists cursors at all, so
writing there would trade a stale report for a clobbered sidecar.

### Who reads it {#readers}

`startGithubSource` derives `backlog_pending` from the marker whenever it has
no verdict of its own: at source start, and after any tick that threw. A tick
that returned still reports its own `pending`, which is the same value it just
committed.

The failed-`session_repos`-inventory path reads the marker in preference to its
own cursor scan, and falls back to that scan only for a sidecar that carries no
marker at all. The scan's scoping (LLP 0367, #1316) remains correct for a
sidecar written before this field existed, and no migration is needed: the
first tick that persists cursors supplies the marker.

### The accepted lag {#lag}

The marker is re-read at tick boundaries, not continuously. A sidecar
retirement therefore reaches the daemon's cadence and `hyp status` at its next
tick of either kind, so the report lags durable truth by at most one scheduled
delay, which is `min(poll_interval, BACKLOG_RETRY_MS)`. This is bounded and
deliberately not closed by polling the sidecar from `status()`: the residual
error is one extra scheduled tick, and the tick that observes it is capped by
the same request budget as any other.

## Consequences {#consequences}

- The worst-case request rate is unchanged. The cadence still floors at
  `min(poll_interval, BACKLOG_RETRY_MS)` and every tick is still capped by the
  per-tick request budget, so the 1,600 requests/hour ceiling LLP 0361#cadence
  sanctions is the same ceiling, reached in the same way. The marker makes the
  backlog cadence reachable in states where a restarted daemon previously
  waited longer, which is the promise being kept, and removes it from states
  where the work is already gone.
- A failure never sets the marker, so failure residue no longer pins a daily
  source to the backlog cadence through the cursor scan once the sidecar
  carries a verdict. This settles the open contract question in #1305 in both
  of its directions, and #1305 needs no separate answer.
- `github-cursors.json` grows by one boolean. An older reader ignores an
  unknown top-level key, and this reader treats an absent one as "no verdict
  recorded", so the sidecar stays readable across a downgrade.
- The daemon's in-memory `backlogPending` is now a cache of durable state
  rather than the only copy of it. Nothing else in the source needs to survive
  a restart, so no other flag changes.
