# LLP 0542: The wizard output guard covers the orchestrator's streams

**Type:** Decision
**Status:** Accepted
**Systems:** Onboarding, CLI
**Author:** neutral
**Date:** 2026-10-18
**Extends:** LLP 0341 (#absorb and #consequences: the wrapper covers the
streams the orchestrator hands its lanes and phases, not every output path a
phase reaches through a dispatcher-owned command; #warnings: the lane-level
guard enumeration there is a snapshot under the warn-and-continue rule, not a
closed list)
**Related:** issue #1158, issue #1163

## Context {#context}

LLP 0341 #consequences says new lanes and phases inherit the output guard
by being driven through `runInitWizard`. Read broadly, that covers a
phase's sub-command output too. It does not, and the guard was never
widened to make it so: the maintainer decided on issue #1158 to keep the
current command and stream behavior and to record the boundary instead.

`runInitWizard` (`src/core/cli/wizard/index.js`) wraps `opts.stdout` and
`opts.stderr` once with `guardWizardOutput` and drives the orchestrator body
with the wrapped pair, detaching the guard's `error` listeners in a
`finally`. Two kinds of output in a wizard run do not go through that pair:

- **Dispatcher-owned command closures.** The disconnect teardown runs
  `hyp leave` through `opts.ctx.commands.run`, and the configure phase runs
  each picker row's `configure_command` the same way
  (`src/core/cli/wizard/configure.js`, `runOneConfigure`). That seam is
  built in `src/core/cli/dispatch.js` and calls `runCommandByName` with the
  dispatcher's own `stdout` and `stderr`. Spreading guarded streams into a
  copy of `ctx` does not redirect it.
- **The raw-context status callback.** `hyp init` passes `runInitWizard` a
  `runStatus` closure (`src/core/commands/init.js`) that writes to
  `ctx.stdout` and runs `hyp status --verbose` against the raw `ctx`.

The login lane is not on this list. `defaultRunLogin`
(`src/core/cli/wizard/join.js`) runs `hyp remote login` against a copy of
the wizard's context whose `stdout` and `stderr` are the wizard's guarded
streams (stderr through a capturing tee), so its writes are lane writes.

## The guard covers the streams the orchestrator hands the wizard {#scope}

**The wrapper of LLP 0341 #absorb covers the two streams the orchestrator
hands its lanes and phases, and every write made through them.** Output a
phase reaches through a dispatcher-owned command closure such as
`ctx.commands.run`, or through the raw-context `runStatus` callback, is
outside it. "Inherit both by being driven through `runInitWizard`" in
LLP 0341 #consequences means the lane or phase's own writes on those
streams, and the boundary checks in front of its acts. It does not mean the
output of a command that phase invokes.

That output is still covered on every shipped path, by other mechanisms:

- `runInitWizard` is reached only through `hyp init`
  (`src/core/commands/init.js`), so only through `dispatch`. No `exports`
  subpath in `package.json` reaches the wizard.
- On real OS streams, `bin/hypaware.js` installs
  `installStreamErrorHandlers` on `process.stdout` and `process.stderr`
  before anything writes, so an asynchronous EPIPE from a sub-command's
  write is absorbed rather than thrown uncaught.
- The public `hypaware/integration` seam (`src/core/cli/integration.js`,
  `run`) hands `dispatch` in-memory buffer sinks whose `write` appends to a
  string and returns `true`, so it cannot fail.

A dead consent surface still stops these acts before they begin: the
disconnect teardown and the configure phase each sit behind a boundary
check (LLP 0341 #dead-surface). What a sub-command writes once it is
running is that command's output, governed by the process-level handlers
above.

## The warning-guard enumeration is a snapshot {#finale-warnings}

LLP 0341 #warnings names three lane-level warning guards and calls that
"the whole of the lane-level guard list". The finale has since gained two
more, both in `runFinaleBackfill` (`src/core/cli/walkthrough.js`): the
dead-surface notice that names the providers whose local history import
was skipped, and the per-provider `backfill <provider> failed` warning.

Both are warn-and-continue arms in the sense the operative rule names: a
lane guards a write only when the write qualifies a failure the arm exists
to survive. The first exists so a finale whose stdout died still runs the
sweep import and the daemon restart; the second so one provider's failure
costs neither its siblings nor the daemon restart. LLP 0341 #consequences
already allows a new arm of that kind its own guard. **The enumeration in
#warnings records the guards that existed when it was written; it is not a
closed list.** The rule decides whether a guard belongs, not the count.

## Non-goals {#non-goals}

- No broadening of the guard to the dispatch seam. Wrapping the streams
  `runCommandByName` closes over would change guard coverage for every
  command run through `ctx.commands.run`, not only the wizard's.
- No enforcement of a closed list of lane-level warning guards.
- No change to scripted-run semantics. A scripted run completes with its
  writes best-effort through the wrapper, as LLP 0341 #dead-surface decides.
- No recovery path for a transient non-EPIPE stream error on a live
  terminal. None has been reproduced on real OS streams, so a dead mark
  stays permanent for the run.

## References

- LLP 0341
- hyparam/hypaware#1158, hyparam/hypaware#1163, PR #1155, PR #1161
- `src/core/cli/wizard/index.js` (`runInitWizard`, the disconnect teardown),
  `src/core/cli/wizard/configure.js` (`runOneConfigure`),
  `src/core/cli/wizard/join.js` (`defaultRunLogin`),
  `src/core/cli/dispatch.js` (the `commands.run` seam),
  `src/core/commands/init.js` (the `runStatus` closure),
  `src/core/cli/walkthrough.js` (`runFinaleBackfill`), `bin/hypaware.js`,
  `src/core/cli/integration.js`
