# LLP 0287: An `undetermined` session has its spooled bodies deleted unread, though it was never opted out

**Type:** Issue
**Status:** Draft
**Systems:** Privacy, Sources, Plugins
**Generated-by:** neutral
**Author:** Brendan / Claude
**Date:** 2026-08-19
**Related:** LLP 0253 (#delete-on-drop: the duty this reuses, and the three verdicts it names; #byte-cap, #eviction-degrades: the bound and the recovery path a retained body would fall back on), LLP 0254 (#policy-inline, #hook-stays: why a missing hook record is not "clean"), LLP 0257 (#ingest: S10, S11), LLP 0286 (the writer-side eviction that produces this state), LLP 0049 / LLP 0066 / LLP 0103 (the opt-outs that *are* drops)

> The Claude telemetry listener has three verdicts and two behaviours.
> `ignore` and `undetermined` both delete the session's spooled bodies without
> reading them, though only the first is a decision the user made. This issue
> states the asymmetry and the options; it does not settle it, because either
> answer moves ground LLP 0253 #delete-on-drop settled.

## The gap {#gap}

At ingest (`applyUsagePolicy` in
`hypaware-core/plugins-workspace/claude/src/telemetry/source.js`) a batch is
split three ways:

1. **kept**: the cwd resolved and the policy allows the row.
2. **dropped** (`policySource: 'usage_policy'`): the cwd resolved to an
   `ignore` under `.hypignore`, the machine-local list, or a per-session
   ignore. `suppressSession` deletes the session's spooled bodies.
3. **withheld** (`policySource: 'undetermined_cwd'`): there is no hook record
   for the session, so no cwd, so no verdict. `suppressSession` runs with
   `withheld: true`, which changes which counter moves and whether the log line
   is `warn` or `info`, and deletes the session's spooled bodies just the same.

LLP 0253 #delete-on-drop names exactly the first case: "when ingest drops a
session (`.hypignore`, the machine-local list of LLP 0049 and 0103, or a
per-session ignore under LLP 0066), it deletes that session's bodies instead of
leaving them unread", and its argument is that "deletion is what makes the
opt-out mean what it says". `undetermined` is not an opt-out. It is our own
inability to answer, and LLP 0257 S11 restates the duty for a *dropped*
session only.

The asymmetry matters because the two verdicts fail in opposite directions. A
dropped session is one whose content the user asked us not to keep, and
deleting is conservative. An undetermined session is one we could not classify,
and deleting is the *most* destructive option available: withholding the events
costs an attribution, deleting the bodies costs the content. The states that
produce it are ordinary, not exotic: the hook not installed yet, the hook
having failed once, the record evicted by compaction (LLP 0286 fixes the worst
of that, and does not remove the cliff).

## Why it is not simply a bug {#why-not-a-patch}

The conservative reading is defensible and is on the record. LLP 0254's
consequences say "a session with no hook record has no cwd and must be treated
as undetermined rather than as clean", and a body that stays in the spool is a
raw prompt sitting in our directory for a session that might, once the hook
record lands, turn out to be one the user opted out of. Deleting is the only
answer that cannot leak.

The counter-argument is that retention here is already bounded and already has
a name: the spool is capped and evicted oldest-first (LLP 0253 #byte-cap), an
evicted body "degrades to backfill, never to loss" (#eviction-degrades), and
the listener's own log line for this case already names `recovery:
'transcript_backfill'`. A retained body would be swept by `hyp purge` and by
detach (#purge-and-detach-sweep) like any other. So the choice is not
"retain forever versus delete now"; it is "let the existing cap decide, or
pre-empt it".

## Options {#options}

1. **Status quo.** Undetermined keeps deleting. Cheapest, and the current
   `warn` plus `events_undetermined` counter make the gap visible to an
   operator who looks.
2. **Retain on undetermined; let the cap evict.** Withhold the events, leave
   the bodies for the spool's own eviction. A later batch for the same session
   (or a backfill run) can then still read them. Needs an answer for how long
   an unclassified body may sit, and whether a subsequent `ignore` verdict for
   that session must sweep them.
3. **Retain briefly, then delete.** A grace window on the theory that the hook
   record is late rather than absent, deleting once it expires. Adds a timer
   and a state to a path whose whole design (LLP 0254 #identity-at-ingest) is
   that it settles once, at ingest.
4. **Ask the file, not the record.** Resolve the cwd for an undetermined
   session from a cheaper second source (the transcript path on the event) so
   the verdict is rarely undetermined at all. Moves the question rather than
   answering it, and re-opens LLP 0254 #hook-stays.

## What a decision has to state {#decision-shape}

- Whether `undetermined` is a drop for the purposes of LLP 0253
  #delete-on-drop, and, if not, an amendment to that section's scope rather
  than a silent divergence in the code.
- What happens to a retained body when the session's verdict later resolves to
  `ignore`.
- Whether `hyp status` capture health should surface standing undetermined
  sessions, since under any retention option the spool now holds content whose
  policy is unknown.

## References

- `hypaware-core/plugins-workspace/claude/src/telemetry/source.js`
  (`applyUsagePolicy`, `suppressSession`)
- `hypaware-core/plugins-workspace/claude/src/telemetry/policy.js`
  (`POLICY_UNDETERMINED`, `partitionByUsagePolicy`)
- Issue #918 finding 2; PR #896 ("not fixed here, deliberately"); issue #880
