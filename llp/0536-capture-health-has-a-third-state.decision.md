# LLP 0536: Capture health has a third state, `unknown`

**Type:** Decision
**Status:** Accepted
**Systems:** Daemon, Observability, Plugins
**Author:** neutral
**Date:** 2026-10-18
**Extends:** LLP 0257 (#status-and-health: S17's two-way capture-health line
gains a third answer for a comparison the bounded read could not settle)
**Related:** LLP 0262, LLP 0271, issues #2295, #2296, #2302

> [LLP 0257](./0257-claude-telemetry-listener-source.spec.md) is Accepted, so
> it is not edited. Its S17 compares the last telemetry event against last
> transcript activity and raises a diagnostic past a threshold: two answers,
> healthy or gap. The shipped collector answers a third way when it cannot tell,
> and that third answer carries rules S17 never had to state. This records the
> decision as it shipped in #2295 and #2296. Nothing here changes behavior.

## Context {#context}

S17's comparison starts from file metadata. The newest transcript mtime under
the client's `activity_probe.dir` is cheap to read, but it only raises a
suspicion: a transcript is rewritten for plenty of reasons that are not a turn
(a metadata record, a local slash command, a notice, a plain touch), and none
of those owe telemetry. So when the mtime pass suspects a gap, `hyp status`
reads transcript content to confirm it. The read is bounded because
`hyp status` runs often, and a bounded read can run out before it has settled
the question.

PR #2295 initially had two states, and two review rounds produced six
blocker-severity findings. Each one was a path where an unsettled read was
reported as either "not being captured" or "healthy". The rules below are the
invariant those findings converged on. Before this doc they were recorded only
in JSDoc.

## Decision {#decision}

### Three states, and what each one claims {#three-states}

**`capture_health[].state` is `'ok' | 'gap' | 'unknown'`.** It is a published
contract: the `--json` output carries it, and `CaptureHealthReport` in
`src/core/daemon/types.d.ts` declares it.

- `ok`: either the mtime pass found nothing past the threshold (no file is
  opened), or the confirmation read covered every post-baseline byte that could
  hold a turn and found none past the threshold.
- `gap`: a conversation record, a `user` or `assistant` record that is not
  `isMeta`, is dated past the threshold. An mtime alone never produces `gap`.
- `unknown`: the suspicion was neither confirmed nor ruled out. It claims
  neither an interruption nor a working capture path. When the read found no
  turn at all, `gapMs` stays the filesystem's unconfirmed suspicion. When it
  found a turn inside the threshold but could not rule out a later one,
  `gapMs` is measured from that turn. Either way `state`, not `gapMs`, says
  whether anything stands behind the number.

### Rendering {#rendering}

**`unknown` raises no `capture_gap` diagnostic, does not degrade `overall`, and
does not count as a gap.** The text line prints
`capture: unknown; ... [capture unconfirmed]`, so the user sees that the
question went unanswered. It does not send them to restart a daemon on evidence
that does not exist. Only `gap` raises `capture_gap`, at the S17 threshold and
severities, and only `gap` puts the heading into needs-attention.

Uncertainty is not a clean bill of health either. An unsettled read is never
rendered as `ok`.

### Positive evidence is not erased by uncertainty elsewhere {#positive-evidence}

**A conversation record found past the threshold reads `gap` even when other
candidates went unread.** The finding is positive. A partial read can only
understate how large the gap is, because a newer turn might also have gone
unseen, and it cannot make the gap disappear.

The rule is not "any uncertainty means `unknown`". It applies in one direction
only:

- If a confirmed turn falls within the threshold and the read was complete, the
  result is `ok`.
- If a confirmed turn falls within the threshold but the read was partial, the
  result is `unknown`, because an unread candidate could still hold a later
  turn past the threshold.
- If no turn is found and the read was complete, the result is `ok`, with
  `gapMs` reset to 0.
- If no turn is found and the read was partial, the result is `unknown`.

### The certainty obligation {#certainty-obligation}

**`certain: true` means nothing that could hold a newer turn went unread, in
a format the parser understands.** The two conclusions earn it differently.
A negative conclusion ("no turn here") needs full post-baseline coverage:
every post-baseline byte that could hold a turn was read. A positive one can
settle earlier. Each tail is scanned backwards, so the first dated
conversation record found is that file's newest turn, and the older bytes the
truncated tail never reached cannot change the answer. A tail longer than
128 KiB that ends in a dated turn is certain without reaching back to the
baseline. Each of the following answers `certain: false`:

- the descriptor's record format is not the one the parser reads
  ([#format-ownership](#format-ownership));
- the probe is missing, or its directory path cannot be resolved;
- the walk skipped part of the tree: a directory it could not list, a file
  it could not stat, a symlink it will not follow, a level past
  `MAX_ACTIVITY_PROBE_DEPTH`, or an entry whose kind readdir did not report;
- more files postdate the baseline than the file cap allows, so some were
  evicted unread;
- a candidate could not be opened, or returned fewer bytes than its size
  promised;
- a line newer than the newest turn found (or anywhere in the tail, when no
  turn is found) could not be parsed, or was a conversation record with no
  usable timestamp;
- a truncated tail that found no turn and never reached back to the baseline.

Some things are passed over without costing certainty:

- A file whose mtime predates the baseline is never opened, because a record
  cannot postdate the file it is in. For the same reason, the walk stops early
  once no remaining candidate's mtime could beat a turn already found.
- An entry that is simply missing (removed between listing and stat) holds
  no records, and neither does a fifo, socket, or device node, so the walk
  counts them as covered. A permission or I/O fault is the walk failing to
  look, and that does cost certainty.
- A tail that reaches byte zero, or whose oldest timestamp already predates
  the baseline, has seen everything that matters for a negative conclusion.

### The read budget and its failure direction {#read-budget}

**At most 16 candidate files (`MAX_CONFIRM_FILES`) are opened, newest mtime
first, and at most 128 KiB (`MAX_CONFIRM_TAIL_BYTES`) is read from the end of
each (plus one boundary byte per tail). The worst case is therefore about
2 MiB read and parsed once per `hyp status`, and only on the path that would
otherwise print a gap. A read the limits leave unsettled, with no turn found
past the threshold, answers `unknown`.** Hitting a limit does not by itself
unsettle the read. Evicting candidates past the file cap always does. A
truncated tail does only when it found no turn and never reached back to the
baseline ([#certainty-obligation](#certainty-obligation)): a tail cut at
128 KiB that ends in a dated turn is settled, and reads `ok` when that turn is
inside the threshold. A turn found past the threshold still answers `gap`
([#positive-evidence](#positive-evidence)). Running out of budget can cost an
answer, but it cannot cancel a finding.

The sizes come from the real transcripts measured for #2295. Sixteen files
cover a sitting's worth of concurrently written sessions (a main transcript
and its subagents). Across 320 transcripts, the newest conversation record sat
within 17 KiB of the end in 99 cases out of 100 and within 40 KiB in the worst
case, and all but a thousandth of records were under 53 KiB. The window clears
both figures by more than 3x.

The budget bounds the content read and the candidate list, which uses bounded
insertion rather than collect-then-sort. It does not make status constant-time.
Directory discovery still walks the probe tree to `MAX_ACTIVITY_PROBE_DEPTH`
and stats each matching file, and that cost grows with the tree. A read the
limits leave unsettled fails toward `unknown` because the read exists only to
keep the gap diagnostic honest. Guessing on an unsettled read would bring back
the false accusation or the false all-clear that the read was added to
prevent.

### Format ownership {#format-ownership}

**The transcript parser reads Claude Code's record shape, and only the built-in
`claude` descriptor contributed by `@hypaware/claude` is confirmed with it
(#2296).** Any other descriptor that declares an `activity_probe` answers
`certain: false` before the filesystem is touched. Its records would never
match, and "no conversation found" would read as a clean bill of health while
hiding a real gap. Such a client's suspected gap therefore always renders as
`unknown`. Confirming another client's transcripts takes a parser for its
format and a decision that extends this one, not a relaxed check.

## Consequences {#consequences}

- `hyp status` raises `capture_gap` only on transcript content, never on an
  mtime. A user is told sessions went uncaptured only when a dated turn says so.
- A machine whose transcript tree leaves the bounded read unsettled, with no
  turn found past the threshold, sees `[capture unconfirmed]` with an `overall` that is not
  degraded. That is the honest result for a question that was not answered. If
  the read did find such a turn, the machine sees `capture_gap` at its S17
  severity, budget or no budget.
- Any future change that adds a client format, widens the budget, or adds a
  status value has to keep the certainty obligation. The regression tests in
  `test/core/status-capture-health.test.js` pin each uncertain path to
  `unknown`.
