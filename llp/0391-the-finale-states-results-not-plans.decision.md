# LLP 0391: The wizard finale states results, not plans

**Type:** Decision
**Status:** Accepted
**Systems:** Onboarding, CLI
**Author:** Kenny / Claude
**Date:** 2026-09-08
**Related:** LLP 0180 (extended here: the finale's sweep disclosure), LLP 0174 (the manual path's disclosure, unchanged), LLP 0170 (the sweep itself), LLP 0021 (observability)
**Tracker:** hyparam/hypaware#1479

> Every setup run printed a scan report per backfill provider, and a
> sweep-backed provider printed a disclosure line above it as well. On the
> common install - a fresh machine with no local history - that is three
> lines of zeroes and schedule prose for something that did nothing.

## Context {#context}

[LLP 0180 §decision](./0180-finale-attaches-openclaw.decision.md#decision)
settled that a sweep-backed provider is disclosed rather than asked: the
finale prints "the enabled periodic sweep imports its history on schedule"
and runs the first import immediately. It also recorded where the consent
for that import comes from: the pick itself, "whose row summary discloses
the sweep".

Both halves of the backfill output have since been overtaken by the finale
around them. The import now runs under a spinner that names the provider
and says an import is running, so the disclosure line duplicates the fact
that something is happening and adds only the schedule. And the result line
printed `ok (scanned N, wrote N, skipped N)` unconditionally, so a run that
imported nothing - the usual case on a fresh install - closed the wizard
with a row of zeroes.

The one thing 0180 assumed and the code did not deliver: the OpenClaw
picker row's summary said the adapter "imports its session history", which
does not disclose that the import recurs. Dropping the finale line without
that would have left the wizard path with no statement of the schedule at
all.

## Decision {#decision}

- **The finale announces nothing before an import.** The spinner is the
  announcement. Sweep-backed and consented providers run through the same
  loop with the same output, so there is no provider-class-specific prose
  in the finale.
- **The sweep disclosure moves to the pick**, which is where 0180 already
  located the consent. The OpenClaw picker row summary states the import
  recurs on a schedule. The manual `hyp client attach` path keeps its own
  enable-prompt disclosure unchanged ([LLP 0174 §openclaw](./0174-attach-prompts-to-enable.design.md#openclaw)).
- **The result line keeps only counts that carry news.** A failure prints
  all three counts. A run that wrote or skipped rows prints what it wrote
  and what it scanned and skipped. A clean zero over an empty scan prints
  `nothing to import`.
- **A zero write over a nonzero scan is news.** It prints
  `nothing new to import (scanned N)`. "No history on disk" and "history
  found and none of it imported" are different faults with different fixes
  (a wrong path or an unreadable home, against a projection or dedupe that
  swallowed every row), and this line is the only place a user sees either.
  Collapsing them into one silent phrase would be a diagnostic loss, which
  is the constraint the quieting has to respect.
- **One helper, both surfaces.** `describeBackfillResult` renders the line
  for the finale and for `hyp client attach`'s post-enable import, so the
  two cannot drift.

## Consequences {#consequences}

- LLP 0180 gains a forward-ref on its 3b bullet; what that bullet settled
  about **consent** (sweep-backed providers are not asked, and their first
  import is brought forward) is unchanged and still in force. Only the
  finale's printed disclosure moves.
- 0180's verification note reads "unit tests assert a picked OpenClaw
  reaches the attach lane and the sweep-disclosure path". The sweep path is
  still asserted, now by its result line plus the absence of the announce
  prose.
- The per-provider entry in the finale summary keeps all three counts, and
  the `walkthrough.backfill` span keeps `rows_written`, so nothing this
  quieting removes from the screen is removed from telemetry.
- `walkthrough_backfill_client_history` asserts the new result wording.

## References

- LLP 0180, LLP 0174, LLP 0170, LLP 0021
