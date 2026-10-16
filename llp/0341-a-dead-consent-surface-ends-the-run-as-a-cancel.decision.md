# LLP 0341: A dead consent surface ends the wizard run as a cancel

**Type:** Decision
**Status:** Accepted
**Systems:** Onboarding, CLI
**Generated-by:** neutral
**Author:** Phil / Claude
**Date:** 2026-08-31
**Extends:** [LLP 0135](./0135-install-experience-overhaul.design.md)
(#orchestration built the lane machine and its cancel exits without saying
what the run does when the stream those lanes narrate into dies. This
decision names the rule)
**Related:** LLP 0188 (#never-silent: the floor that forbids acting after
the run can no longer state anything), LLP 0191 (#consequences: the
ctrl+c cancel whose semantics this reuses), LLP 0200 (#wizard, the
failed-write arm; #machine-local, why a stranded preference is safe),
LLP 0201 (#narrate: the statements that are the fast path's consent
surface), LLP 0338 (#context: the sibling decision from the same review),
hyparam/hypaware#1151, hyparam/hypaware#1147

> Driving `runInitWizard` against a pipe whose read end closes killed the
> run with an uncaught EPIPE after the folder-ask lane had persisted its
> answer and before the composed config was committed. Guarding the one
> write that threw does not fix it: the run then dies on the next phase's
> write instead, so a local guard relocates the halt rather than removing
> it. This decision settles the run-level rule both reviews of PR #1149
> deferred: the wizard's stdout is its consent surface, and when that
> surface dies the run ends the way ctrl+c ends it - cleanly, at the next
> boundary, acting on nothing further.

## Context {#context}

The wizard is a consent surface first (LLP 0188 #never-silent: say what
will ship before anything ships) and a configurator second. Its writes
fall into three kinds: statements and receipts on stdout, warnings on
stderr, and the acts behind them - store writes, the config commit, the
configure phase, the finale's attach and daemon work, the closing sync
offer.

PR #1149 guarded the folder-ask failed-write arm's two writes, because
that arm's documented contract is to warn rather than fail the run, and
its own writes were the one way it could still fail it. The review rounds
that produced it, and issue #1151's triage, then established the wider
fact: the same stream failure at any *unguarded* write (the folder-ask
success receipt, `narrateAcceptedGate`, the sync lane's unreadable-store
warning one lane earlier) still takes the run down as an uncaught throw,
and adding the obvious guard at any one site only moves the crash to the
next site. The failure was reproduced through a real closing pipe: exit
by EPIPE stack trace, the folder-ask preference persisted, the composed
config uncommitted.

Two facts about that split state shaped the decision. The persisted value
is the user's own answer to a question they answered on a live screen,
recorded in a machine-local store (LLP 0200 #machine-local) that
`hyp status` and `hyp policy list` surface and a re-run round-trips. And
nothing ships on its strength while the config is uncommitted. The split
state is, exactly, the state a ctrl+c at the same moment leaves behind -
a state the wizard already designs for (LLP 0191).

## A dead stdout cancels the run at the next boundary {#dead-surface}

**When the wizard's stdout dies, the run ends as a cancel: exit 130,
`cancelled: true`, nothing further asked, persisted, or configured.** The
narration is the consent surface - on the express path it is the whole of
it (LLP 0201 #narrate) - and a wizard that can no longer say what it is
doing may not keep doing things. Completing silently was rejected
outright: it would commit a config whose overwrite confirm could not be
shown, and then attach clients, install a daemon, and offer an upload on
a machine where the never-silent floor (LLP 0188) has no floor to stand
on.

The halt is taken at the run's boundaries, not mid-sentence: before each
question lane opens and before each acting phase (the config commit, the
configure phase, the finale, the closing offers). A lane the surface dies
inside finishes its own bookkeeping and returns; the orchestrator then
stops the run instead of entering the next step. Boundaries are where the
run can stop *cleanly* - between a question answered and an act begun -
and checking there is what removes the halt instead of relocating it: a
site-level guard leaves every later site to crash, while the boundary
check ends the run on purpose wherever the death occurred.

**The rule binds attended runs, and its boundaries run through the
finale.** A scripted run (`--yes`, presets, `--from-file`) has no
consent surface to lose: its consent is its flags (LLP 0131
#attended-only), no prompt can go unseen, and a pipeline that stops
reading its output must not cost it the install it explicitly asked for -
so it completes, its writes best-effort through the same wrapper. And
past the finale an attended run is committed, configured, and reported;
what remains is output and one closing question. The sync-now offer
simply does not open on a dead surface, and the run returns its result
rather than a cancel, because a 130 over work that was completed and
narrated while the surface lived would be the lie in the other direction.

A run that already joined narrates the enrolled-abort statement
(LLP 0190 #abort-narration) on stderr, the surviving stream, best-effort:
the one fact that outlives the run - this machine is enrolled and its
configured sources sync by default - must be attempted somewhere a
`2>log` invocation could still catch it. The cancel itself is named on
stderr the same way the ctrl+c cancel is.

## Stream failures are absorbed once, at the orchestrator {#absorb}

**The orchestrator wraps both streams before any lane runs; a wizard
stream write never throws into a lane, and a stream error never surfaces
as an uncaught exception.** The wrapper records the death and turns
further writes into no-ops. This is what makes the boundary rule
implementable without the site-by-site guards that produced the current
mix: lanes keep writing as if the surface were healthy, and the
orchestrator alone decides what a dead surface means.

The wrapper also listens for the stream's own `error` event, because that
is how a real pipe actually reports EPIPE: the write call returns and the
failure arrives a tick later. Between a failed write and the run learning
of it there is therefore a gap, and the config commit must never win that
race - so the boundary check in front of every acting phase first settles
the stream's pending writes (bounded, so a slow-but-alive reader only
delays the run rather than wedging it) and only then reads the verdict.
A stub sink that throws synchronously takes the same path through the
same wrapper: the throw is caught, the death recorded, the next boundary
cancels.

## What was persisted before the death stands {#retained}

**Answers recorded before the surface died are kept, deliberately.** Each
one was written in response to an answer the user gave while the surface
was live, into a machine-local store that is discoverable (`hyp status`,
`hyp policy list`) and round-tripped by the next run (LLP 0200 #wizard,
LLP 0188 #opt-out). Rolling them back would discard answers the user did
give in order to protect against a value the user cannot be surprised by,
and would make the output-death cancel *stronger* than the ctrl+c cancel
it reuses - which also keeps every store an answered lane already wrote.
The invariant that matters is the one the split state never breached:
nothing ships, and no config commits, on the strength of a run the user
never saw finish.

## Warnings stay best-effort, on every arm {#warnings}

**stderr is the qualifying stream, and its death never ends the run.** A
warning exists to qualify a decision already made; a warning that cannot
be written must not unmake the decision (the rule PR #1149 recorded for
the folder-ask arms, now the corpus rule). The orchestrator's wrapper
enforces this for every lane it drives.

Lanes whose documented contract is warn-and-continue additionally guard
their own warning write, so the contract holds for direct callers too -
the folder-ask failed-write and cancel arms (guarded by #1149) and the
sync lane's unreadable-store arm (guarded by this decision, closing issue
#1151's first finding). That is the whole of the lane-level guard list,
and the rule that keeps it from growing back into a mix: a lane guards a
write only when the write qualifies a failure the arm exists to survive;
every other write is protected by the run-level wrapper and owes no guard
of its own.

Rejected: treating a dead stderr like a dead stdout (it loses qualifiers,
not consent; the unreadable-store fact it might drop is also named by
`hyp status` and enforced fail-closed at the export seam). Rejected:
guarding every write site-by-site with no run rule (twice demonstrated to
relocate the halt, and the origin of the inconsistent mix this replaces).
Rejected: completing the run with writes swallowed (#dead-surface above).

## Consequences {#consequences}

- `hyp init` driven against a closing pipe now exits 130 with
  `cancelled: true` instead of crashing on an uncaught EPIPE, and never
  commits the composed config after its output dies. The reproduced split
  state (preference persisted, config uncommitted) remains reachable and
  is now the documented ctrl+c-equivalent state rather than an accident.
- The run is resumable the way any cancelled run is: re-running the
  wizard round-trips every store the dead run wrote, and the returning
  gate sees whatever the run committed before the death.
- `src/core/cli/wizard/output_guard.js` is the one wrapper; the
  orchestrator's boundary checks are the one halt. New lanes and phases
  inherit both by being driven through `runInitWizard`, and add no guards
  of their own unless they add a warn-and-continue arm.
- Mid-prompt death is resolved by the prompt itself: a terminal that goes
  away takes stdin with it, and the prompt's EOF/cancel path is already a
  designed exit. The boundary checks exist so no *new* prompt opens on a
  surface already known dead.
- The wizard's exit codes gain no new value: output death reuses 130.
  Telemetry distinguishes it (`wizard.output_closed`), so "users' pipes
  are dying mid-setup" is observable without a new user-facing state.

## References

- LLP 0135, LLP 0188, LLP 0190, LLP 0191, LLP 0200, LLP 0201, LLP 0338
- hyparam/hypaware#1151, hyparam/hypaware#1147, PR #1149
- `src/core/cli/wizard/output_guard.js` (the wrapper and the settle),
  `src/core/cli/wizard/index.js` (the boundary checks and the cancel),
  `src/core/cli/wizard/sync_scope.js` (the unreadable-store arm's guard),
  `test/core/cli/wizard/output_guard.test.js` (the real-pipe drive and
  the boundary tests)
