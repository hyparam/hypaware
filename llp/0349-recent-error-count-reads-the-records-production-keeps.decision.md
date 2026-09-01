# LLP 0349: `recent_error_count` counts the failures the install actually recorded

**Type:** Decision
**Status:** Accepted
**Systems:** Daemon, CLI
**Generated-by:** neutral
**Author:** Phil / Claude
**Date:** 2026-09-01
**Extends:** [LLP 0348](./0348-a-live-pid-is-not-a-live-daemon.decision.md)
(#not-settled left this counter open after the sibling half of issue #1003 was
fixed; this is the decision that section said would have to be made)
**Related:** LLP 0330 (#warning-diagnostic: the flush-failure diagnostic whose
shape this one follows), LLP 0322 (#clearing: the sibling record that is read
off disk rather than through `status.json`), LLP 0017
(#the-primary-daemon: the daemon log this now reads)

> `hyp status` reported `recent_error_count: 0` during a brownout in which the
> central sink failed 1,016 exports with `429 gateway_pending_high_water` and
> 849 with `fetch failed` (issue #1003, split out as #1182). Every one of those
> failures had already been written to a file on that machine. The counter was
> reading a different directory, one that does not exist there.

## Context {#context}

**The counter read a directory only a developer has.** `countRecentErrors`
walked `<stateRoot>/dev-telemetry/` for `logs-*.jsonl` records with
`severityText: "ERROR"`. That directory is written by `JsonlLogRecordExporter`,
which `installLoggerProvider` attaches only when `HYP_DEV_TELEMETRY=1`. With
neither that variable nor an OTLP endpoint set, `installLoggerProvider` returns
no provider at all, so on an ordinary install the OTel logger writes nowhere
and the directory is never created. The counter's `ENOENT` branch then returned
`0`, and `hyp status` printed it as a fact.

This is worse than a missing feature. `0` and "we did not look" render
identically, and the field's name promises the first. For an observability
product, a monitoring number that reads clean because nothing was measured is
the failure mode with the highest cost: it is consulted exactly when something
is wrong.

**The failures were recorded, in two places, on the same machine.**

- `<stateRoot>/logs/daemon.log`. `openDaemonLog` runs on every boot in every
  mode, gated on nothing, and `fileLog.error` writes one JSON line per failure:
  `daemon.boot_failed`, `daemon.tick_failed`, `daemon.reconcile_failed`,
  `daemon.source_start_failed`, `daemon.maintenance_failed`,
  `daemon.sink_materialize_failed`, `daemon.reload_failed`, and their siblings.
- `<stateRoot>/sinks/<instance>/outbox/<batchId>.json`. The sink driver's
  `persistOutbox` writes one file per failed export batch, carrying the sink
  instance, the partitions to retry, and the error string. This is the store
  that held the #1003 incident: the driver's own `sink.export_batch.failed`
  goes to the OTel logger, which on that machine had no exporter, but the
  outbox file was written regardless. README has listed the directory as
  "Failed export rows awaiting retry" since V1.

**The counter had no horizon either.** It returned every ERROR record still on
disk, with no upper bound on age, so a machine that failed once and was
repaired would have carried the warning until someone deleted the file. The
name says "recent" and nothing implemented it.

## Decision {#decision}

<a id="read-the-records-production-keeps"></a>**`recent_error_count` counts the
error records this install actually keeps: the daemon log, the sink outboxes,
and dev telemetry.** The three stores are disjoint by construction, so no
failure is counted twice. `daemon.log` carries what `fileLog` emits; the outbox
carries one file per failed export batch and nothing else writes one; and
`dev-telemetry/logs-*.jsonl` carries the OTel logger's records, which reach no
file at all without `HYP_DEV_TELEMETRY=1`. Dev telemetry is kept as one input
among three rather than removed: when it is on, it holds the `getLogger` errors
that no other file receives.

The alternative was to make the field honestly unavailable: `null`, with the
render saying "not measured". Rejected, because an adequate signal exists and
is already on disk. An `unknown` is the right answer only when nothing can be
read, and it would have changed `recentErrorCount` from `number` to
`number|null` for every consumer of `--json` to buy less information than this
costs.

<a id="the-window"></a>**"Recent" means the last 24 hours, stated.** It is the
shortest horizon that still spans an overnight brownout (the #1003 incident ran
for hours with nobody watching), and it is self-clearing, so an install that
has been repaired stops warning without anyone deleting a file. The window is
what makes a count off the outbox mean "now" at all: nothing drains those
files, so the directory is a growing ledger rather than a queue depth.

A record whose timestamp is missing or unreadable is counted, not dropped. The
defect being fixed here is a counter that stayed silent about failures it did
not look at, and an unreadable stamp on a line that says `level: "error"` is
still an error someone should see. An outbox filename that does not match the
`<instance>-<iso>-<seq>.json` the driver writes is skipped instead: that is not
a batch this daemon recorded, so it is not evidence of anything.

<a id="bounded-reads"></a>**Every read is bounded, because `hyp status` is a
report.** The daemon log is appended to for the life of the install and nothing
rotates it, so it is read from the tail: the last 256 KiB, with the fragment
before the first newline discarded so a half-line cannot parse as a whole one.
The outboxes cost one directory listing per configured sink and open no file,
because `persistOutbox` bakes the batch's timestamp into its filename. Nothing
here grows with the age of the machine, and the collector already pays more
than this for `measureCacheStats`, which stats every file in the cache tree.

<a id="one-number"></a>**The report still carries one number.** The diagnostic
message names the breakdown ("3 in the daemon log; 2 failed sink export
batches") because those are different places to look and different repairs, and
a bare total sends the operator to the wrong one. That breakdown is prose. No
new field is minted for it, and `recentErrorCount` stays a `number`.

The diagnostic stays a `warning` and stays out of `degradingKinds`, unchanged
from before: it is a pointer, not an outage claim, the same footing
LLP 0330#warning-diagnostic settled for a standing flush failure. A daemon that
is genuinely not serving is now caught by LLP 0348's heartbeat, at `error`.

## What this does not settle {#not-settled}

**Nothing drains the outbox.** The driver writes those files and no code path
reads or removes them, so a machine that has ever failed an export keeps the
record forever. The window makes that harmless for this counter and does not
make it right. Retention or replay for the outbox is its own change.

**The daemon log is still unrotated.** The tail read bounds this command's cost
and does nothing about the file's size on disk.

**Sink export failures still do not reach `daemon.log`.** They are counted here
through the outbox, which is the durable record, but an operator tailing the
daemon log during an incident will not see them. Whether the driver should log
to the daemon log as well as to the OTel logger is a separate question.

## Consequences {#consequences}

- A wedged or failing install now reports a non-zero `recent_error_count` on an
  ordinary machine, with a `recent_errors` diagnostic naming where to look.
- An install that failed a day ago and recovered reports `0` again on its own.
- `hyp status` gains one bounded file read and one directory listing per
  configured sink; it opens no outbox file and reads no more of the daemon log
  as the machine ages.
- Any future writer of the sink outbox inherits the filename contract: the
  batch id carries the timestamp this count reads, so a batch id built some
  other way becomes invisible to the counter rather than mis-dated by it.
