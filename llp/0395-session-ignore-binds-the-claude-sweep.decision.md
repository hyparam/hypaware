# LLP 0395: The automatic Claude sweep consults the session drop set

**Type:** Decision
**Status:** Accepted
**Systems:** Privacy, Plugins, Sources, Backfill
**Author:** Phil / Claude
**Date:** 2026-09-10
**Related:** LLP 0049, LLP 0066, LLP 0067, LLP 0256, LLP 0306, LLP 0358,
LLP 0359
**Tracker:** hyparam/hypaware#1606

> `@hypaware/claude` holds one ignored-session set per activation. The
> telemetry listener's control route writes it and the transcript backfill
> provider reads it, so a session the user ignored is not re-imported by the
> daemon's own five-minute sweep. The set stays in memory and dies with the
> process, so an operator-typed `hyp backfill claude` in its own process still
> re-imports, exactly as LLP 0067 said it would.

## Problem {#problem}

LLP 0067 §"What is deliberately not covered" recorded backfill re-import as
the ephemerality contract rather than a defect, on a stated premise: "the set
is gateway memory; `hyp backfill` is a **separate process** reading local
transcripts". It added "Recorded here so nobody 'fixes' it by persisting the
set."

That premise described the only backfill lane that existed. LLP 0358
§scheduled-sweep then gave the Claude transcript provider a `sweep` field, and
LLP 0359 gave the daemon a driver that fires it. The re-import is no longer a
separate process a human decides to run: it is an in-daemon timer at
`*/5 * * * *` by default, in the very process that holds the drop set.

The observable result is that `hyp session ignore` suppressed nothing durable
for Claude Code. The live drop kept the exchange out of `ai_gateway_messages`;
because it kept it out, native `part_id` dedupe had nothing to dedupe the
re-import against, and the ignored user prompt and assistant reply landed
verbatim on the next tick.

Two things follow from where the drop set lives, and they point in opposite
directions. The set is reachable: the sweep runs in the daemon process whose
plugin activation holds it, so consulting it needs no persistence and no new
contract. And the set is not reachable from a CLI process: `hyp backfill
claude` activates the plugin in its own process, with its own empty set, so the
manual lane cannot see a daemon-held opt-out however it is wired.

## Decision {#decision}

### One drop set per activation, read by both lanes {#sweep-consults-the-set}

**`@hypaware/claude` creates one `Set<string>` in `activate()` and hands it to
both the telemetry listener and the backfill provider.** The listener hosts
`/_hypaware/ignore/session` over it (LLP 0256 #control-route-on-listener), so
the write path is unchanged: `hyp session ignore` posts to every recorder
advertising the route and nothing about the CLI, the route, or the reply
changes. The provider tests each grouped session id against the set before it
projects anything.

This is the shape `@hypaware/opencode` already ships (LLP 0306): one set in
`activate()`, handed to the listener and the importer alike. Claude is brought
to it rather than given a mechanism of its own.

The check is the first statement in the session loop, ahead of the window
filter, the session-context join, the entrypoint gate, and the git probe, so an
ignored session costs one `Set.has` and no projection. The pass reports
`sessions_ignored` in `claude.backfill.scan_complete` beside the existing
`sessions_gated`, and each drop logs
`claude.backfill.session_ignore_drop` with `policy_source: 'session_opt_out'`.

### The set is still memory only {#in-memory-only}

**Nothing is persisted.** No file, no cache column, no config key. The set dies
with the daemon, so a restart drops the opt-out exactly as LLP 0066
§ephemeral requires and as `hyp session ignore`'s receipt already says. The
durable expressions of the same intent remain `.hypignore` and the
machine-local list, which the backfill provider already threads through its
usage-policy resolver.

LLP 0067's warning stands unamended: the fix is not to persist the set.

### The manual lane is unchanged, and that is not a compromise {#manual-lane}

**`hyp backfill claude` still re-imports an ignored session.** This is not a
choice between binding one lane and binding two: a CLI invocation activates
the plugin in a fresh process holding an empty set, so a daemon-held opt-out is
structurally invisible to it. LLP 0067's sentence about a separate process is
therefore still literally true of the lane it was written about; what this
decision closes is the lane that did not exist when it was written.

The consequence is a coherent one to state: while the daemon holds the id,
nothing that daemon runs on its own initiative imports the session; a
deliberate re-import remains the user's call.

### Not covered {#not-covered}

- **Claude Desktop.** Its only capture lane is this sweep (LLP 0358
  #transcript-primary), so a Desktop session id supplied explicitly is now
  honored by it. But `hyp session ignore` still cannot resolve a Desktop
  session id (`resolveSessionIdForCli` reads `CLAUDE_CODE_SESSION_ID`, which
  only the Claude Code CLI states), so in practice Desktop remains uncovered.
  Making the verb resolve or refuse a Desktop session is a separate decision,
  not a consequence of this one.
- **OpenClaw and Hermes** honor the session opt-out in no lane, live included.
  Separate gap, separate decision.
- **An already-written row** is untouched. This decision withholds a future
  import; `hyp purge` is the verb for what is already recorded.

## Consequences {#consequences}

- A file whose only session was dropped by the opt-out is still fingerprinted
  as seen for the daemon's lifetime (LLP 0359 #file-fingerprints), so a later
  `hyp session unignore` does not resurrect an idle session on the next tick,
  once a tick has read the file in the state it is now in. That proviso is
  load-bearing: a session ignored and unignored inside one tick interval was
  never fingerprinted in its current state, so the next tick does take it.
  Otherwise the session is recovered by the deliberate re-import above, or by
  the session continuing (a changed transcript is read again). Within one
  daemon lifetime the direction of the surprise is therefore withheld data,
  not recorded data.
- **Withholding is not a tombstone, so whatever ends the hold imports what was
  held back**, rather than only resuming from that point. Nothing records which
  turns were withheld, the transcript on disk is unchanged by any of this, and
  the sweep projects a session's whole window rather than a delta. Two things
  therefore import the withheld turns retroactively: a daemon restart, which
  starts both an empty set and an empty fingerprint map so every file is a
  candidate again, and an `hyp session unignore`, after which the next tick
  reads the whole session as soon as the transcript differs from what a tick
  last fingerprinted. Further work in the session guarantees that difference,
  but it is not required for it: unignoring before the next tick already
  leaves it true. This is LLP 0066 §ephemeral read forward rather than a defect
  of this decision: the set is the whole of the mechanism, so it can only
  withhold while it holds. It is called out because the drop now looks durable
  while it holds, which is exactly when a user stops expecting it to lapse.
  `docs/PRIVACY.md` says this in the user's words and points, as it already
  did, at marking the directory for the answer that survives a restart.
- Per tick the sweep pays one `Set.has` per grouped session, over a set that is
  empty on almost every machine. No allocation is added to the scan, and an
  ignored session's projection, git probe, and yield are skipped outright, so
  the change can only reduce per-tick work.
- The listener's set moves from `start()` to `activate()`. A source restart no
  longer silently clears live opt-outs, which is the reason LLP 0067 #set gives
  for putting the gateway's set on `GatewayState`.

## Verification {#verification}

`test/plugins/claude-session-ignore-sweep.test.js` drives both real lanes: it
starts the real telemetry listener, posts the real control request the CLI
posts, then runs the real provider through the kernel's sweep runner and the
real gateway materializer over on-disk transcripts. It pins the ignored
session's turns out of the appended rows, an ordinary session in on the same
tick, an unthreaded provider unchanged, and the drop reversible.
