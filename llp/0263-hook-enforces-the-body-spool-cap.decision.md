# LLP 0263: The client hook is the body spool's second cap enforcer

**Type:** Decision
**Status:** Draft
**Systems:** Privacy, Sources, Daemon, Config
**Author:** Phil / Claude
**Date:** 2026-08-18
**Related:** LLP 0085, LLP 0253 (the decision this extends), LLP 0258, LLP 0262

> The raw-body spool's byte cap is enforced by the `hyp claude-hook
> session-context` hook as well as by the daemon. LLP 0253 named the daemon as
> its enforcer and named the daemon-down window as the reason the cap exists,
> which are the same sentence contradicting itself. The hook already runs
> out-of-process at the cadence bodies are written, so it closes the window at
> no new cost and under the operator's existing cap.

## Context

LLP 0253 #byte-cap settles that the spool is bounded, and says why: "The cap is
enforced by the daemon, not by hoping the reader keeps up: the window this
exists for is precisely the one where the reader is not running."

As built, every enforcement of that cap lives inside the listener source: a
one-shot sweep when the source starts and a 60-second timer cleared on stop.
The only other sweeps are `hyp purge` and `hyp detach`, both user-initiated.
Nothing else touches the directory.

So the window LLP 0253 names is exactly the window nothing swept. Claude Code
keeps writing bodies whether or not the daemon is reading (LLP 0253, Context),
at roughly 145 KB per request, and the daemon is legitimately absent in more
than failure states:

- a crashed or stopped daemon service,
- a machine where the daemon was installed but never started,
- an uninstall that never ran `hyp detach`, leaving the settings block in
  place with no reader that will ever return,
- attach before the first daemon start, which
  `resolveAttachTelemetryPort`'s third rung deliberately supports.

This is a privacy defect, not only a disk one. The attach turns on
`OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_ASSISTANT_RESPONSES`, `OTEL_LOG_TOOL_DETAILS`
and `OTEL_LOG_RAW_API_BODIES` (LLP 0258 #env-keys). LLP 0262 accepted that
content sitting in our own directory only because it is transient, and LLP 0253
promised "Nothing in the spool outlives the user's decision to remove it".
With no daemon it is neither transient nor bounded, in a directory a
non-excluding backup tool will copy.

## Decision

### The client hook enforces the cap too {#hook-enforces-the-cap}

**`hyp claude-hook session-context` enforces the spool's byte cap on every
invocation, in addition to the daemon.** The hook is chosen over the other
daemon-less touchpoints because it is the only one whose cadence is tied to the
writing itself: attach installs it on `SessionStart`, `CwdChanged`,
`UserPromptSubmit`, and `PostToolUse` for Bash (LLP 0085), so bodies cannot
accumulate between enforcements. Enforcing at `hyp attach` or `hyp status`
instead was rejected: both are typed rarely or once, so a machine that attaches
and is never inspected again gets no bound at all, which is the case this
exists for.

**A hook may delete spool files, and only spool files.** It calls the same
`enforceClaudeBodySpoolCap` over the same directory, at the same cap, in the
same oldest-first order. The hook never widens the deletion rule; it runs the
daemon's existing rule while the daemon cannot. Everything LLP 0253
#eviction-degrades already says about an evicted body applies unchanged: the
content is recoverable from the transcript by the backfill path.

**The cap the hook applies is the operator's.** It reads the same
`telemetry.spool_max_bytes` key out of the `@hypaware/claude` slice of the v2
config, with the same validation and the same 512 MB default, so lowering the
cap on a small disk binds both enforcers. A malformed value falls back
silently rather than warning: the listener already warns on this key, and a
hook has no output surface that would not push text at Claude Code.

### The sweep runs last and may always fail {#never-interrupts}

**The sweep runs after the session-context records are written, and a failure
is swallowed.** Ordering is not incidental: LLP 0085 exists to shrink the
window in which the projector reads a cwd-less record, so nothing may be added
ahead of those appends. Nothing waits on the sweep, so it goes last, and it
runs even on the invocations that record nothing, because a malformed event or
a missing `--state-file` says nothing about whether the spool is filling.

The cost is one `readdir` plus a `stat` per file, against a directory the
listener keeps near-empty whenever the daemon is up, and which does not exist
at all on a proxy-attached or unattached machine (the sweep returns on its
`ENOENT` arm without a single stat). That is well under the two git
subprocesses the same hook already spawns.

## Consequences

- LLP 0253's stated bound holds in the window it was written for, so LLP 0262's
  acceptance of transient spool presence rests on something true.
- A machine whose daemon never runs again still converges to the cap, at the
  cost of one directory listing per hook event.
- Deleting captured data is no longer daemon-only. The rule is unchanged and
  the directory is the one `hyp purge` and detach already empty, but a reviewer
  looking for "who may delete captured content" now has two answers, both
  pointed at this anchor.
- The two enforcers can disagree about the cap only if the hook and the daemon
  read different configs or different `HYP_HOME`s, which is already true of the
  state file and the cache and is not made worse here.
