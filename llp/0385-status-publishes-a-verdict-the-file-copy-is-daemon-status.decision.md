# LLP 0385: `hyp status --json` publishes the collector's verdict; the file's own copy is `hyp daemon status --json`

**Type:** Decision
**Status:** Accepted
**Systems:** CLI, Daemon
**Generated-by:** neutral
**Author:** Phil / Claude
**Date:** 2026-09-05
**Extends:** [LLP 0348](./0348-a-live-pid-is-not-a-live-daemon.decision.md)
(#stale-heartbeat-is-unresponsive said the state `hyp status` reports is the
collector's verdict rather than a transcription of the file, about
`daemon.state`; this settles that the same holds of `sources[].state`, and on
the machine plane as well as the text one)
**Related:** [LLP 0164](./0164-status-names-recent-clients-from-gateway-entrypoints.decision.md)
(#status-reads-it-from-the-status-file: the file this reads, and
#not-liveness-gated: the reads that do want the record, and go to the file for
it), [LLP 0225](./0225-captured-text-is-escaped-for-display.decision.md)
(the machine copy that must stay byte-exact, and which surface it is),
[LLP 0383](./0383-status-reads-the-daemons-last-state-to-tell-a-crash-from-a-stop.decision.md)
and [LLP 0384](./0384-a-stopping-snapshot-that-stopped-ageing-is-a-stop-that-never-completed.decision.md)
(the other two readings of a dead daemon's terminal snapshot);
hyparam/hypaware#1416, hyparam/hypaware#1410, PR #1412

> The #1410 fix gave the `status.json` fallback a liveness gate: with the daemon
> gone, a snapshot's `started` source renders `stopped`. `renderStatusJson`
> emits the same array, so `hyp status --json` changed with the text plane, and
> a machine consumer can no longer read the state a killed foreground
> `hyp daemon run` recorded off this surface (#1416). This settles which of the
> two `sources[].state` is: a verdict, or a transcription.

## Context {#context}

**`report.sources` was never a transcription.** It has three producers. With a
runtime registry attached, each entry's state is computed live, `started` or
`stopped` from `sources.started(name)`. With neither a registry nor a readable
snapshot list, `inferConfiguredSources` invents an entry per active source
plugin and writes `stopped` on it, which no file ever said. Only the middle
branch, the `status.json` fallback, read a word off disk, and only one word of
it: `failed` was passed through then and is passed through now, because it
records why the last run went wrong and claims nothing about the present. The
#1410 fix changed the one branch on which the array had ever been a copy, which
is why the issue records it as making `--json` more consistent, not less.

**One report stands behind both renders.** `collectHypAwareStatus` builds a
single `HypAwareStatusReport`, and `renderStatusText` and `renderStatusJson`
both read it. Splitting `sources[].state` per plane means one command answering
one question two ways depending on the flag. The repo has already paid for that
shape once: during the #1003 wedge `hyp status` said `degraded` while
`hyp daemon status` transcribed `healthy` with a climbing uptime, one operator
and two answers, which is what LLP 0348 was written to end.

**The recorded value is not lost, and it is one command away.**
`runDaemonStatus` writes `{ running, ...status }` for `--json`: the parsed
status file, whole, field for field, no cleaning and no derivation. LLP 0225
names that payload the machine copy and requires it stay byte-exact, and it is
untouched by the #1410 fix. So the machine plane already carries both readings
of a dead daemon's snapshot, on the two commands that mean two different things:
`hyp status` reports on the install, `hyp daemon status` reports the daemon's
own file.

**The reads that want the record already bypass the array.** `hyp status`'s own
last-seen entrypoints are derived from `daemonStatusFile.sources` directly and
deliberately not liveness-gated, because "last seen at T" survives its daemon
([LLP 0164](./0164-status-names-recent-clients-from-gateway-entrypoints.decision.md#not-liveness-gated)).
That is the established route for a fact that outlives the process: read the
file, not the report array.

## Decision {#decision}

<a id="sources-state-is-a-verdict"></a>**`sources[].state` is the collector's
verdict on both planes.** `hyp status --json` publishes the same value
`hyp status` prints, for the same reason: a source whose daemon is not running
is not started, whatever the file left behind says. `--json` is a machine
rendering of this report, not a second data source with a different epistemics,
and there is no plane on which `hyp status` answers with a claim it has already
determined to be false.

`failed` continues to pass through untouched, and this decision does not widen
the gate: it settles what the existing gate's output is, and adds no reading of
the snapshot that LLP 0383 and LLP 0384 have not already settled.

<a id="no-recorded-state-field"></a>**No second key carries the recorded state,
because two of the three producers have no recorded state to put in it.** A
`recorded_state` beside `state` would be populated only on the snapshot-fallback
branch. On the runtime branch there is no file value at all, and on the
inference branch there is no file, so the field would be absent or null on every
healthy machine and its absence would mean two unrelated things: "the daemon is
running" and "nothing recorded this source". A consumer cannot tell those apart
without reading the rest of the report, at which point it could have read
`hyp daemon status --json` instead and got the file with no ambiguity. The
repo's rule against inventing schema fields applies with full force to a field
whose value is already published, complete, one command over.

<a id="the-file-copy-is-daemon-status"></a>**A consumer that wants the terminal
recorded state reads `hyp daemon status --json`.** That is the surface whose
contract is the file: every field the daemon wrote, including each
`sources[].state` as recorded, so a post-mortem asking what was up at the moment
of death reads the run's own last write rather than a report's opinion of it.
The pairing is the same one the flush-failure and maintenance surfaces already
use, where the text line is the judgement and a named machine surface carries
the full detail ([LLP 0330](./0330-the-flush-failure-stamp-is-an-operator-surface.decision.md),
[LLP 0228](./0228-maintenance-skips-are-a-standing-surface.decision.md)); the
difference here is only that the detail lives on a sibling command because the
file is that command's whole subject.

## Consequences {#consequences}

- A machine post-mortem of a killed daemon reads two commands, not one, and
  gets an unambiguous answer from each: `hyp status --json` for what is up now
  (nothing), `hyp daemon status --json` for what the dead run last recorded.
- Both halves are pinned by one test on one fixture, so a future change that
  reverted either half, re-transcribing `started` into `hyp status --json` or
  deriving a verdict into `hyp daemon status --json`, fails rather than quietly
  contradicting this decision.
- The obligation this puts on `hyp daemon status --json` is the one LLP 0225
  already put there: it stays a copy. Adding a derivation to that payload now
  also removes the only surface carrying the recorded value, so it is a change
  that has to be made against this document, not alongside it.
- Nothing here is settled about a `sources` entry whose recorded `state` is a
  word no build ever wrote. It reaches the report unchanged today, as `failed`
  does, and is the hostile-file question LLP 0164 owns rather than this one.
