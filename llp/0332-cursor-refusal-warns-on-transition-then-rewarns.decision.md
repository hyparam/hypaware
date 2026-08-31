# LLP 0332: The cursor refusal warns on transition, then at most once per rewarn interval

**Type:** Decision
**Status:** Accepted
**Systems:** Cache, Observability
**Generated-by:** neutral
**Author:** Phil / Claude
**Date:** 2026-08-31
**Extends:** [LLP 0329](./0329-a-containment-refusal-reaches-stderr.decision.md)
(#consequences: the per-refusal price is kept, but for the cursor guard the
unit of "a refusal" is rebased from one cursor read to one standing
condition, warned on transition and re-warned on an interval)
**Related:** LLP 0323, LLP 0326, hyparam/hypaware#1115

> LLP 0329 prices the standing refusal signal at one stderr write per
> refusal, and for three of the four guards in the series a refusal is a
> pass: one flush, one sweep, one detach. The cursor guard has no pass. It
> fires inside `tryReadCursorSync`, which every destructive path shares by
> design (LLP 0323 #one-gate), so its unit is the read, and one condition is
> read many times: twice in a single `hyp purge --all`, and at up to seven
> call sites on one daemon maintenance tick, into a log the service manager
> never truncates. The report now keeps per-partition state at the emitting
> site, the shape `REWARN_MS` already settled for the daemon control channel:
> warn when the refusal appears or changes, then at most once per rewarn
> interval while it persists, and reset the moment any read of that
> partition stops refusing, so the next refusal warns afresh. Every
> distinct condition still reaches stderr; what stops is the same fact
> restated because two callers happened to share a function.

## The read is not the operator-meaningful unit {#per-read-bill}

LLP 0329 #consequences says the refusal line repeats because the condition
persists, at one stderr write per refusal, and calls that the standing
signal working. For the flush and sweep guards that price is also the
operator-meaningful rate: each line is one pass that did no work, so lines
count lost passes.

The cursor guard's refusal is not shaped like that. `reportEscapingTableDir`
fires inside `tryReadCursorSync`, the one shared gate LLP 0323 #one-gate
deliberately routed every destructive reader through, and those readers do
not coordinate. Measured through the packaged CLI at PR #1110's head, one
`hyp purge --all` over one poisoned partition prints the identical line
twice: once from partition discovery (`discoverCachePartitions`) and once
from the purge's post-delete recount (`refreshCursorRowCount`). Under the
daemon, one maintenance tick reads cursors from five `maintenance.js` sites
plus `retention.js` and `storage.js`, so a persistently poisoned partition
pays up to seven identical lines per tick into a daemon log the service
manager never truncates (`src/core/daemon/linux.js`). None of those lines
tells the operator anything the first did not: they differ only in which
internal caller happened to read.

That is the same failure shape the daemon control channel already met and
settled: an unconsumable request file under the win32 1s poll would have
appended ~86k identical lines a day, and `src/core/daemon/control.js` answers
with warn-on-transition plus a `REWARN_MS` floor, reset on recovery. The
issue that carried this finding (hyparam/hypaware#1115) recorded the triage
verdict: each per-read line is genuinely a separate refusing read, so the
current behaviour is within what LLP 0329 priced, and changing the rate is a
design decision, not a review edit. This decision is that change.

## Warn on transition, rewarn on an interval, reset on heal {#transition-plus-rewarn}

`reportEscapingTableDir` keeps module-level state, one entry per partition
(keyed by the resolved partition directory), holding the rejected value it
last warned about and when. The rules:

- **A new refusal warns immediately.** No entry for the partition, or an
  entry whose rejected value differs from this one: the line is written and
  the entry is set. A poison that changes shape is a new fact and is never
  absorbed into the old one's window.
- **An unchanged refusal rewarns at most once per `ESCAPE_REWARN_MS`**
  (10 minutes, the same floor `control.js` chose and for the same reason: a
  standing condition must not be mute for the daemon's whole lifetime, and
  must not be a line per poll either). Under the default 60-minute
  maintenance interval this lands on one line per refusing tick, which is
  exactly the per-pass rate the other guards in the series already pay.
- **Any read that does not refuse for escape resets the entry.** A read
  that returns a cursor, finds no file, or fails to parse means the escape
  condition is no longer what this partition exhibits, so the entry is
  deleted and the next escape warns afresh. This is the self-heal path in
  practice: the next append rewrites `cursor.json` with a contained
  `tableDir`, and a re-poisoned partition announces itself again.

Two further rules fall out of the same principle, that this throttle's only
permitted degradation is an extra line (#not-a-pass-object). Both make the
window narrower than the three rules above alone would:

- **An entry whose age reads negative is not a window.** `Date.now` is
  wall-clock and NTP-steppable, and a daemon that starts before the first
  sync reads into the past. A backwards step under a live entry would make
  the recorded warn look like it happened in the future, and a bare
  "younger than the interval" test would then hold indefinitely. A negative
  age therefore rewarns.
- **An entry is armed only once the line is out.** The report records what
  it said, not what it attempted. `getLogger`'s OTel emit runs before the
  stderr mirror and the whole call is guarded, so a provider that throws
  takes both channels with it; arming the window there would spend a full
  interval on a refusal that reached nobody.

The throttle gates the whole report, the structured WARN and the stderr
mirror together, because they are one signal on two channels (LLP 0329
#stderr-mirror: the mirror is an addition, not a rerouting) and `control.js`
throttles its whole warn the same way. The state is process-local and
unsynchronized: a fresh CLI process always warns its first refusal, which is
the property the interactive case needs, and the daemon is one long-lived
process, which is the case the interval bounds. Entries are deleted on heal
and one at most exists per partition that ever refused, so the map is
bounded by the number of partitions this process saw refuse. That is not a
static bound: retention deletes whole date partitions
(`src/core/cache/retention.js`), and a partition removed while poisoned
never gets the non-refusing read that would clear it, so a daemon running
for months against a persistently poisoned source strands about one entry
per day. Accepted at that size: the leak is a fraction of the log the same
condition is writing, and probing the filesystem to prune it would put a
syscall in a hot synchronous reader.

## Not a pass object threaded through the readers {#not-a-pass-object}

The alternative that would make the cursor guard literally per-pass is a
pass token: thread a budget or dedup object into `tryReadCursorSync` from
each top-level operation, so purge's two reads share one token and a
maintenance tick's seven share another. Rejected on the same grounds LLP
0329 #not-the-verb rejected verb-shape plumbing: the readers are roughly a
dozen unrelated call sites (both appends, discovery, purge's recount,
retention, five maintenance sites, storage) that share no object today, and
every current and future caller would have to construct and pass one to
deliver a signal the emitting site already possesses in full. A caller that
forgot the token would silently reopen the per-read rate. Time as the proxy
for a pass costs one module-level map and no signature changes, degrades
only toward an extra line (never toward silence), and cannot be forgotten
by a new reader.

Also rejected: throttling only the stderr mirror while the structured WARN
stays per-read. It would make the two channels disagree about how often the
condition was observed, and the structured substrate pays the same
duplicate-fact bill in a dev-telemetry JSONL export. One signal, one rate.

## The other guards keep their per-pass rate {#other-guards}

The flush guard (`spool_dir_is_symlink`), the sweep guard
(`sweep_path_is_symlink`), and the capture-spool guard
(`capture_spool_path_is_symlink`) are untouched. Their refusals already have
a pass, one line per pass is already the rate LLP 0329 priced, and the
existing tests pin that the next pass says it again. This decision rebases
only the guard whose unit was wrong, not the series' rate.

## A rate is something a test can count {#testable}

LLP 0329 #testable made the refusal observable; this decision makes the rate
assertable, in both directions, because the dangerous failure mode of any
throttle is suppressing the signal outright:

- Through the packaged CLI: one `hyp purge --all` over one poisoned
  partition writes **exactly one** `cursor_table_dir_escapes_partition`
  line, not zero and not two.
- In-process: two consecutive `tryReadCursorSync` calls on one poisoned
  partition cost one line; a heal-then-repoison sequence warns again; a
  changed rejected value warns immediately; and with mocked time, the same
  standing condition warns again after `ESCAPE_REWARN_MS`, so the throttle
  is a floor and never a lifetime mute.
- Each reset exit is pinned by the sequence it guards, not only the healthy
  one: a poison whose `cursor.json` then vanishes, and one whose
  `cursor.json` then turns unparseable, both warn afresh when the poison
  returns inside the window. A reset that a refactor drops must fail a
  test, because the failure it reopens is a swallowed refusal.
- The two narrowing rules are pinned in the direction that costs silence: a
  wall clock stepped backwards under a live entry still warns, and a warn
  the log channel could not deliver arms no window, so the next read says
  it for real.

## Consequences {#consequences}

- `hyp purge --all` over a poisoned partition prints the refusal once. The
  exit code, stdout JSON, and the line's content are unchanged.
- A daemon with a persistently poisoned partition logs one line per
  10 minutes at most, in practice one per refusing maintenance tick at the
  default interval, instead of up to seven per tick. The log still grows
  while the condition persists, deliberately: a standing refusal stays a
  standing signal.
- A refusal that appears, heals, and reappears warns each time it appears.
  A rejected value that changes warns without waiting out the window.
- Two poisoned partitions warn independently: the state is per-partition,
  so one partition's window never absorbs another's refusal.
- Within a window this process can prove it holds, a refusing read is
  silent on both channels. An operator counting lines can no longer count
  reads; they were never a meaningful count, which is what this decision
  settles. The two exceptions both err loud: an entry whose age reads
  negative under a stepped clock, and a warn that never left the process.
- Recovery is not announced, unlike `control.js`'s
  `daemon.control_scan_recovered`. Silence after a refusal therefore reads
  as either "healed" or "still poisoned, the next line is not due yet", and
  telling them apart means knowing `ESCAPE_REWARN_MS` and the maintenance
  interval. Accepted here rather than settled: a recovery line is a signal
  this decision does not need in order to rebase the rate, and adding one
  is its own decision about a channel every healthy cursor read would sit
  on.
- The state is process-local, so `N` distinct short-lived CLI invocations
  still pay `N` lines. Accepted: each process's first line is the one an
  interactive operator needs, and the unbounded accumulation this bounds
  was the single long-lived daemon.

## References {#references}

- [LLP 0329](./0329-a-containment-refusal-reaches-stderr.decision.md): the
  channel and the price this decision rebases for one guard.
- [LLP 0326](./0326-generation-name-is-the-directory.decision.md): the
  symlink half of the cursor gate this report speaks for.
- [LLP 0323](./0323-cursor-names-a-generation-in-its-own-partition.decision.md):
  #one-gate, why every destructive reader shares `tryReadCursorSync`, which
  is why the guard has no pass; #say-it, the loud-refusal pattern.
- `src/core/daemon/control.js`: the `REWARN_MS` precedent, transition plus
  interval plus reset-on-recovery.
- hyparam/hypaware#1115: the deferred finding, with the measured two lines
  per purge and the per-tick read census.
