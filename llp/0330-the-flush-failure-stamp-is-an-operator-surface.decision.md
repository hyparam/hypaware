# LLP 0330: The flush-failure stamp is an operator surface, on both planes, with a diagnostic and a quoted reason

**Type:** Decision
**Status:** Accepted
**Systems:** Cache, Daemon, CLI, Query
**Generated-by:** neutral
**Author:** Phil / Claude
**Date:** 2026-08-30
**Extends:** [LLP 0322](./0322-a-failed-automatic-refresh-cools-down-and-is-visible.decision.md)
(the stamp it minted as pacing state is now also rendered to the operator,
without gaining any new meaning)
**Related:** LLP 0225 (the prose-versus-values plane split applied here), LLP
0228 (#last-tick-only: the count-plus-pointer shape the cap follows), LLP 0321
(the degrade whose warning gains a reason), LLP 0257 (#status-and-health: the
capture-health section the line joins), LLP 0164 (labels cleaned before a
terminal)

> LLP 0322 stamped a failed spool-to-cache flush so the automatic query gate
> could pace its retry, and deliberately scoped the operator signal to the span
> status code and the run metric. That left the stamp's one human-readable
> fact, *why* the flush failed, readable by nothing: a query said "the cache
> may be stale" with no way to learn the reason short of opening
> `_hypaware_spool` by hand (issue #1082). PR #1086 rendered the stamp on the
> `hyp status` capture-health line and in `--json` with no design record; this
> document is that record, and it settles the three calls the fix loop was
> right not to make: a standing failure raises a warning-severity diagnostic
> and no more, the `--json` list is uncapped so the text cap's pointer has
> somewhere to point, and the query-time warning quotes the stamped reason.

## Context {#context}

Three facts frame every choice below.

**The stamp is pacing state, and it must stay that.** LLP
0322#what-the-stamp-is-not is categorical: the stamp says when a flush attempt
last failed, nothing about what the spool or the cache holds, and no path reads
it as either. Rendering it anywhere is therefore constrained rather than
implemented by LLP 0322, and every surface this document adds has to hold the
same line: a reason for a paced retry, never a freshness claim. The freshness
line quotes `lastFlushAtMs`, which only a completed write moves, and the stamp
must never feed it.

**Every sibling section on this surface has a design record.** The maintenance
block is LLP 0228, captureHealth is LLP 0257, proxyTrust is LLP 0237/0239. PR
#1086 shipped the flush-failure section without one because LLP numbers were
colliding across concurrent branches and because its three open design
questions (a diagnostic, the overflow pointer, the query-side consumer) were
behaviour changes a capped fix loop was right not to decide. Both marker-signed
review records on that PR's thread hold the raw rationale; this document is
where it becomes settled.

**The interim shape was honest about being half a shape.** LLP
0228#last-tick-only settled that a capped list carries the exact total beside
it *and a pointer to where the rest are listed*; the maintenance renderer
spends its pointer on `hyp query maintain --dry-run`. As shipped, the
flush-failure section had the count and no pointer: the text line said "... and
N more tables whose last flush failed" and `--json` was capped at the same
eight, so an operator learned the scale of an incident and could not learn the
identity of the tables past the cap. The comment at the overflow block said so
rather than implying otherwise.

## Decision {#decision}

<a id="capture-health-line"></a>**The stamp renders on the `hyp status`
capture-health line, and rides `--json` as two stable keys.** Each stamped
table gets one line in the capture-health section: the table label, the age of
the failed attempt, the stamped reason, and a `[refresh cooling down]` tag
while the stamp is inside the LLP 0322 window. The machine copy is
`cache_flush_failures` (an array of `table`, `failed_at`, `error_message`,
`still_cooling_down`) plus `cache_flush_failures_total`, both always present,
empty and zero on a healthy install.

Capture health is the right section because it is the same question the otel
lines answer, is what was captured reaching the place queries read, and it is
deliberately nowhere near the freshness timestamp: that line quotes the last
write that actually happened and would become a lie if a failed attempt fed
it. The daemon's status collector reads the stamps from the spool directly
rather than through `status.json`, because the stamp is written by whichever
process attempted the flush and no single process sees them all.

<a id="count-beside-cap"></a>**The text plane lists at most eight, the exact
total rides beside the list, and the machine plane is uncapped, which is where
the pointer points.** The eight-line cap (`MAX_CACHE_FLUSH_FAILURES`) is a
terminal-legibility bound, following `MAX_SKIPPED_PARTITIONS_REPORTED`: a
cache whose every table refuses writes has one cause, and eight lines names it
without burying the rest of the report. The total is exact, so the cap bounds
the block and never the size of the incident. That was the shipped half of LLP
0228's shape; this settles the other half. The overflow line reads

    ... and N more tables whose last flush failed (hyp status --json lists them all)

and `hyp status --json` carries every readable stamp, not the first eight.

Uncapping the machine plane is the cheaper and more honest pointer than the
two alternatives. Minting a listing command is a new surface with its own
contract, parser, and tests for a corner state, when the machine plane of this
very command already exists and is exactly where a program or a scripted
operator would look; LLP 0228's own pointer went to a command that already
existed, not one minted for the purpose. And the bound question is real but
answered: the population is spool tables, which scales with dataset times
partition, but each entry is individually bounded (a 120-character label, a
512-character message, one timestamp, one boolean), the collector already
builds the full array in memory before any cap is applied, and this report is
built fresh per invocation and never persisted, so there is no `status.json`
growth and no read-back to re-clamp, which is the pressure that forced the
maintenance snapshot's cap to apply on both planes. A `--json` payload that
scales with the number of failing tables is the correct cost of asking for the
machine copy of an incident whose size is the news.

`cache_flush_failures_total` stays even though it now always equals the
array's length. It shipped as a stable key, it is the number the text plane's
arithmetic reads, and its equality with the length becomes an invariant a
consumer may rely on rather than a redundancy to remove.

<a id="plane-split"></a>**LLP 0225's plane split, as applied here.** The stamp
is a file on disk that some other process wrote, so its message reaches a TTY
with no guarantee of being short, printable, or single-line. The text plane
passes both interpolations through the label policy (`printable`, that is
`sanitizeLabel`): the message clamped to 200 characters where it is quoted,
the table label to 80. The `--json` plane is byte-exact as stamped and is not
unbounded either: `readFlushFailure` clamps the message to 512 on the way in,
because the stamp is a file this build may not have written, and the table
label was cleaned and clamped by the collector where the path was assembled.
Prose versus values, not text versus JSON: a person's terminal must not be
repainted, and a program must receive what was actually recorded.

<a id="never-a-freshness-claim"></a>**Every rendering keeps LLP 0322's
separation intact.** The line quotes a failed *attempt* and its age, the
diagnostic below names a failing *flush*, and the query warning quotes why the
last *attempt* failed. None of them asserts anything about what the cache or
the spool holds, none of them feeds `lastFlushAtMs` or the staleness line that
quotes it, and no gate, durability, or freshness decision reads any of them.
A surface that wants to say "your data is stale" must derive it from a write
that happened, never from this stamp.

<a id="warning-diagnostic"></a>**A standing flush failure raises one
warning-severity diagnostic, and warning is where it stays.** When at least
one table carries a readable stamp, `hyp status` pushes a `StatusDiagnostic`
with `kind: 'cache_flush_failing'`, `severity: 'warning'`, a message naming
the count and the newest failing table, and the repair pair the maintenance
analog established: enumerate first (`hyp status --json`, per
#count-beside-cap), retry second (`hyp query refresh`, whose forced flush
clears the stamp on success per LLP 0322#clearing). The `[refresh cooling
down]` tag on the capture-health line now points at a diagnostics block that
carries something for it, which is the contract the `[capture gap]` tag it was
modelled on already had.

Warning and not error, for the same reason `maintenance_partitions_skipped`
is: the daemon is running, capture is working, rows are durable in the spool
(LLP 0321's spool-owns-durability rule, untouched by all of this), and queries
answer from the confirmed cache. A standing rejection is a thing to know about
and repair, not an outage in the install. `overall` degrades only on an
error-severity diagnostic, a non-empty v1 report, or the two config kinds, so
a warning puts the repair in front of the operator without flipping a real
install to `degraded`. The contrast case is `capture_gap`, which may escalate
to error because it means silent session *loss*; here nothing is lost, only
deferred. And the paging-grade escalation already exists on the channel LLP
0322#degrade-reaches-the-signals chose for it: every degraded query ends its
span `ERROR` and moves `queryRunsTotal` to `status: 'degraded'`, which is what
a fleet alerts on. `hyp status` is the local repair surface, and its severity
mirrors data-loss risk, not operator annoyance. If the spool byte threshold
ever gains a "capture is about to be refused" state, an escalation keyed on
*that* is the additive extension; a flush failure alone never flips `overall`.

<a id="query-quotes-the-reason"></a>**The query-time warning consumes the
stamped reason, on both branches, routed as part of the disclosure.** The
cooldown branch of `settlePendingCacheForQuery` has `flushFailureMessage` in
hand (it already read `pendingInfo` for the stamp's time) and passes it to
`reportRefreshCoolingDown`, which appends one additional stderr line after the
LLP 0321 warning:

    cache: last refresh attempt failed: <reason>

and records the reason on its `query.cache_refresh_cooling_down` log event as
`error_message`, closing the asymmetry with the live-failure event, which
always carried one. The live branch (`reportAutoRefreshFailure`) appends the
same line from the error it has in hand, so the wording does not flicker with
the cooldown window, which is the "reports it the same way" consequence LLP
0322 already promised. At most one reason line per query run, first stamp
wins: the warning is a nudge toward `hyp status`, which carries the full
per-table list, and query stderr is not the incident dashboard.

The reason line is prose a person reads, assembled from a file some other
process wrote, so it goes through the same label policy as the status line
(strip and clamp to 200); a reason the policy empties to nothing appends no
line, and the LLP 0321 warning stands alone exactly as before, which is also
the shape when the stamp carries no readable message. On the overview surface
the reason routes as `refresh-failed`, beside the disclosure it explains, not
as the droppable `freshness` kind: a caller allowed to drop the advisory
debounce line must not be able to keep "rows may be missing" while dropping
the why, or the #1082 gap reopens one surface down. The exported constant
`AUTO_REFRESH_FAILURE_MESSAGE` is unchanged; the reason is a second line, not
a rewrite of settled text.

## Alternatives considered {#alternatives}

### Escalate the diagnostic to error, so a broken cache degrades `overall`

Rejected for now, see #warning-diagnostic: nothing is being lost, the
error-grade fleet signal already exists on the span and the metric, and the
`overall` line's own comment scopes degradation to what an operator must fix
to call the install set up. Escalation keyed on approaching capture
backpressure is left as an additive extension with its own trigger.

### Mint a listing command as the overflow pointer

Rejected: a new surface with its own contract and tests for a corner state,
duplicating what `hyp status --json` already is. LLP 0228 pointed at an
existing command too.

### Keep `--json` capped at eight, or raise it to a bigger constant

Rejected. Capped at eight it hides identity, which is the defect; at any
larger constant it hides identity later, with an arbitrary number to defend.
The cost of the uncapped array is paid only in an incident and only by the
caller who asked for the machine copy, and each entry is bounded.

### Quote the reason inside `AUTO_REFRESH_FAILURE_MESSAGE` itself

Rejected: the constant is exported, matched by identity to route the notice
kind, and pinned by tests as the one deduplicated warning. Making its text
vary with the stamp breaks the identity match and the dedupe; a second stable
line keeps both.

### Have only the cooldown branch quote the reason

Rejected: the live branch has the error in hand too, and quoting on one branch
and not the other makes the user-facing text flicker with the window, which
LLP 0322's consequences promised it would not.

## Consequences {#consequences}

- On a healthy install nothing changes on either plane: no capture-health
  flush lines, an empty `cache_flush_failures` array, a zero total, no
  diagnostic, no reason line on queries.
- A program consuming `--json` may now receive more than eight entries in
  `cache_flush_failures`. The keys, the entry shape, and the total are
  unchanged; `cache_flush_failures_total === cache_flush_failures.length` is
  now an invariant.
- `hyp status` on an install with a standing failure shows one warning
  diagnostic with a copy-pasteable repair, and `overall` still reads
  `healthy`. A monitor that treats any diagnostic as actionable now catches a
  rejecting cache without a query ever running.
- `hyp query` under a standing failure prints two stderr lines instead of one:
  the LLP 0321 warning and the reason. Scripts parsing stderr for the exact
  old text still match it, since that line is unchanged.
- The reason reaches the MCP tool result too, not only a terminal.
  `freshnessMessages` is a field of what `query_sql` and `grep` return from
  `verb.operation`, and the stdio host serializes the whole result, so the
  line rides along there as well. It is the first entry in that array whose
  text varies with a local error rather than being a constant or a count, and
  the MCP path pins `refresh` to `auto`, so the failure that produced it had
  no route to a caller before. Accepted on the same ground as the terminal:
  it is HypAware's own bounded, stripped error text about its own cache, the
  host is local and stdio-only, and a caller who may read the rows may read
  why the rows are incomplete. Any transport that is not local (the `--http`
  host the stdio comment leaves room for) must decide this again.
- The stamp gains a second production consumer (`reportRefreshCoolingDown`)
  beside the status collector, and `PendingInfo.flushFailureMessage` stops
  being a field only tests read.
- No cache schema, spool format, stamp format, config key, or pacing behaviour
  changes. The cooldown window, the coalescing rule, and the clearing rule are
  exactly LLP 0322's.

## Tests {#tests}

Traditional tests pin: the capture-health line and both `--json` keys for a
stamped table; the hostile stamp driven through the real collector and
renderer, one assertion per LLP 0225 character group, with `--json` byte-exact
at the 512 clamp; the text cap at eight with the exact total, the overflow
line carrying the `hyp status --json` pointer, and `--json` carrying all
twelve of twelve; the warning diagnostic present with its two repairs while
`overall` stays `healthy`, and absent on a clean cache; the cooled query and
the live failure both appending the same reason line, deduplicated, stripped
of terminal-driving bytes, and absent when the stamp carries no readable
message; and the reason line routing as `refresh-failed` on the overview
surface.

## Extends {#extends}

LLP 0322 settled the stamp, the cooldown, the coalescing rule, and the
delivery of the degraded signal to the span status code and the run metric.
All of it stands unchanged, including #what-the-stamp-is-not, which every
surface here is constrained by. What this document adds is the operator-facing
rendering LLP 0322 deliberately did not decide: where the stamp is shown, how
the list is bounded, what the diagnostics block says about it, and how a query
tells the person at the keyboard why the cache may be stale.
