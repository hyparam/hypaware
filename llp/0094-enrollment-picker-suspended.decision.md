# LLP 0094: the enrollment picker trigger is suspended pending redesign

**Type:** Decision
**Status:** Accepted
**Systems:** CLI, Onboarding, Usage-Policy
**Author:** Phil / Claude
**Date:** 2026-07-09
**Related:** LLP 0069, LLP 0072, LLP 0080, LLP 0081, LLP 0093

> Turns the login-time local-only directory picker OFF, wholesale, until its
> candidate enumeration and presentation are redesigned. Everything around the
> trigger survives: the durable `hyp ignore --local-only` command, the
> machine-local list ([LLP 0071](./0071-machine-local-exclusion-list.decision.md)),
> the export-seam enforcement ([LLP 0070](./0070-local-only-export-seam.decision.md)),
> and the picker module itself. Only the enrolling-login prompt is withheld.
>
> @ref LLP 0069 [constrained-by] - suspends the §trigger requirement; enumeration, persistence, and enforcement stand.
> @ref LLP 0072 [constrained-by] - the "skippable refinement, never a gate" doctrine is why an outright suspension is safe.

## Context

The fresh-enroll picker path accumulated three fixes in one week (issue #281's
reordering in PR #283, the registry re-boot in PR #286, the export hold in
LLP 0093 / PR #287) and the first real-history enrollment after all three
still misfired, in a new way:

On the 2026-07-09 fresh enroll (v1.13.1, empty cache, ~128k rows of claude +
codex history), the picker appeared but offered only a small handful of
directories. The local cache actually contains **126 distinct captured
`cwd`s**. The cause is structural, not a tuning bug:
`waitForCapturedDirectories` (`src/core/cli/remote_commands.js`) polls the
candidate enumeration every second and returns at the **first non-empty**
result, because its contract is "has backfill started landing rows", while
the picker needs "has backfill *settled*". The daemon's first backfill streams
~119k rows over ~25 seconds; the wait returned within the first tick or two
and its early snapshot was handed to the picker verbatim
(`listCandidates: () => Promise.resolve(captured)`), never re-enumerated. The
user is silently shown a race-ordered slice of their history presented as the
whole thing - worse than showing nothing, because it invites a "pick"
decision over a false picture.

Fixing this properly is not another patch on the wait. The rethink on the
table replaces both halves of the feature:

- **Enumeration**: read candidate directories from the clients' own on-disk
  logs (Claude transcripts carry `cwd` on every line; Codex rollouts carry
  `session_meta.cwd` on line 1, already read by the codex plugin's
  `rollout-cwd.js`) via a plugin-contributed provider, instead of racing the
  cache the backfill is still filling.
- **Presentation**: a searchable TUI (filter-as-you-type) instead of the
  50-item "bounded presentation" cap of [LLP 0080](./0080-local-only-dir-selection.design.md).

Both change Accepted designs (LLP 0069 §enumerate, LLP 0080) and deserve
their own deliberation. Meanwhile every fresh enroll runs a picker that
misrepresents the machine's history.

## Decision

**The enrolling-login picker trigger is disabled behind a single module
constant, `ENROLLMENT_PICKER_ENABLED = false`
(`src/core/cli/remote_commands.js`), until a redesign re-enables it.**

Scope of the suspension:

- Every login fork that would have prompted (fresh enroll, `--no-daemon`,
  daemon-install-failure, re-login editor) prints the picker's existing
  durable-command hint instead: the capability stays discoverable
  (LLP 0072 §tty's never-silent spirit) with zero interactivity.
- The fresh-enroll support machinery is skipped as pure overhead while the
  trigger is off: no captured-directory wait, no `freshenCaptureEnumeration`
  kernel re-boot, and no pick-pending marker (LLP 0093) - with no pending
  pick there is nothing for the marker to guard, so exports proceed exactly
  as they would after a non-TTY skip.
- **Unchanged**: `hyp ignore --local-only` / `hyp unignore`, the
  machine-local list and its editor semantics, status reporting of withheld
  directories, and the export-seam withholding. Existing lists written by
  earlier picks keep working; this suspends refinement *acquisition* at
  enrollment, never enforcement.
- The picker module (`src/core/commands/local_only.js`), the wait, the
  freshen re-boot, and the marker helpers stay in-tree with their unit
  tests: the suspension is one flag flip to revert, and the wiring's
  ordering rationale remains documented in place.

Chosen over the alternatives:

- *Patch the wait again* (poll to quiescence, gate on backfill-done client
  actions): rejected for now; it deepens investment in cache-race heuristics
  the redesign intends to delete.
- *Delete the wiring outright*: rejected; the redesign will want the fork
  ordering, the TTY gating, and the editor semantics as its skeleton, and a
  flag documents "off on purpose" better than an absence.

## Consequences

- Fresh enrolls are simpler and faster (no up-to-30s wait, no second kernel
  boot) and can no longer present a misleading candidate list.
- Privacy refinement at enrollment regresses to opt-in via the printed
  durable command. R6's "never forwarded, not even once" guarantee for
  *would-have-been-picked* directories no longer has an enrollment-time
  acquisition path; a user who wants exclusions before first forward must run
  `hyp ignore --local-only` (or enroll with `--no-daemon`, exclude, then
  `hyp daemon install`).
- LLP 0093's marker mechanism is dormant (the sink-driver hold and TTL
  behavior remain implemented and tested; no login writes the marker).
- Re-enabling is a deliberate act: flip the constant only alongside the
  redesign that fixes enumeration, and record that as a new decision
  superseding this one.
