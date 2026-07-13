# LLP 0100: agent-assisted privacy review before the first fleet sync

**Type:** Spec
**Status:** Accepted
**Systems:** CLI, Onboarding, Usage-Policy, Sinks, Plugins
**Author:** Phil / Claude
**Date:** 2026-07-13
**Related:** LLP 0049, LLP 0063, LLP 0066, LLP 0069, LLP 0070, LLP 0071, LLP 0093, LLP 0094, LLP 0101, LLP 0102, LLP 0103, LLP 0104, LLP 0105, LLP 0106, LLP 0107

> When `hyp remote login` enrolls a machine, the first sync to the org server
> is **deferred to a printed deadline** ([LLP 0101](./0101-first-sync-review-window.decision.md)),
> and the user is directed to run an installed **`hypaware-privacy`** client
> skill that reviews the captured history with them: it finds personal
> information, credentials, and other content a person may not want on a
> central server, explains `local-only` versus `ignore`, and applies the
> user's choices through `hyp` verbs before anything ships. This is the
> redesign of the suspended enrollment picker
> ([LLP 0102](./0102-skill-replaces-enrollment-picker.decision.md)).

## Motivation

The BYOD moment [LLP 0069](./0069-local-only-dir-selection.spec.md) was written
for still exists: an enrolling login starts forwarding a machine's whole
captured history, and per-directory refinement must happen before that
forwarding, or a one-time leak is permanent. The in-login picker answered this
with a synchronous TUI racing the first backfill, and lost
([LLP 0094](./0094-enrollment-picker-suspended.decision.md)): it enumerated a
cache the backfill was still filling and presented a partial candidate list as
the whole truth.

This spec inverts the shape. Enrollment stays one fast command
([LLP 0063](./0063-login-auto-provision-forward-sink.decision.md) unchanged),
but no export tick runs until a deadline hours away. The review happens in the
user's own agent session, after backfill has settled, with the model reading
actual content rather than a path list, and with hours instead of seconds of
attention. The window, not the login process, is what guarantees "reviewed
before forwarded".

## The flow {#flow}

1. **Enroll.** `hyp remote login` provisions the central sink, installs the
   daemon, and the attach cascade wires clients, installing client skills,
   including `hypaware-privacy`, and the session-classification hook
   ([LLP 0107](./0107-skills-ride-attach.decision.md),
   [LLP 0106](./0106-session-start-classification-hook.decision.md)).
2. **Hold.** The login writes the first-sync hold before `enrollCentralSink`;
   the sink driver exports nothing until the deadline
   ([LLP 0101](./0101-first-sync-review-window.decision.md)). Backfill and live
   capture proceed normally into the local cache.
3. **Announce.** The login prints the deadline and the review instruction,
   for example: `first sync to <server> is tonight at 11:59pm - to review
   what ships, open Claude or Codex and run the hypaware-privacy skill`.
4. **Review.** The user runs the skill at their leisure. It opts its own
   session out of capture, surveys the cache, proposes directory classes and
   problem sessions, and applies confirmed choices via `hyp ignore` /
   `hyp purge` ([requirements](#requirements)).
5. **Sync.** At the deadline the hold expires and export begins: `ignore`d
   data was never recorded (or was purged), `local-only` rows are withheld at
   the export seam ([LLP 0070](./0070-local-only-export-seam.decision.md)),
   everything else ships, backfill included
   ([LLP 0037](./0037-backfill-on-join.decision.md)).

A user who does nothing gets exactly the LLP 0063 default at the deadline:
everything forwards. The window is a refinement opportunity, never a consent
gate ([LLP 0072](./0072-enrollment-dir-picker.decision.md) doctrine, upheld).

## The `hypaware-privacy` skill {#skill}

A client skill (Claude and Codex), bundled in the client plugins and
materialized at attach ([LLP 0107](./0107-skills-ride-attach.decision.md)).
Its job, in order:

1. **Protect itself.** Opt the review session out of capture via the session
   opt-out ([LLP 0066](./0066-session-opt-out.spec.md), the
   `/hypaware-ignore` mechanism) and verify the opt-out took effect. The
   review conversation necessarily discusses the most sensitive content on
   the machine; it must never itself become a captured, forwardable
   transcript.
2. **Check settlement.** Confirm the backfill has settled before surveying;
   warn and offer to wait if rows are still landing (the failure mode that
   killed the picker, [LLP 0094](./0094-enrollment-picker-suspended.decision.md)).
3. **Survey.** Enumerate captured working directories (distinct `cwd`, counts,
   last-seen, the [LLP 0069 §enumerate](./0069-local-only-dir-selection.spec.md#enumerate)
   query) and sample content per directory looking for credentials and
   secrets, personal or non-work material, candid discussion of identifiable
   people, and anything else a person may not want on an org server.
4. **Explain.** Before the first marking, explain the classes: `ignore`
   (never recorded; existing rows purgeable), `local-only` (recorded and
   queryable here, never forwarded), sync (ships to the org). Plain language,
   including what the org can and cannot see in each case.
5. **Propose and confirm.** Present findings as short redacted excerpts and
   proposed per-directory classes; apply nothing without per-item user
   confirmation.
6. **Apply via verbs.** Write choices only through `hyp ignore --private`,
   `hyp ignore --local-only`, the explicit-sync marking
   ([LLP 0103](./0103-machine-local-policy-classes.decision.md)), and
   `hyp purge` ([LLP 0104](./0104-hyp-purge.decision.md)) for ignored
   directories and flagged sessions. The skill never authors policy files
   itself.

## Requirements {#requirements}

- **R1.** An attended enrolling login MUST print the first-sync deadline as an
  absolute local time and the skill invocation hint, and MUST state that the
  first sync includes backfilled history. A non-TTY enrolling login gets the
  same hold and the same message on stderr; nothing prompts
  ([LLP 0063 D3](./0063-login-auto-provision-forward-sink.decision.md#d3)
  stands).
- **R2.** No export tick may run before the deadline
  ([LLP 0101](./0101-first-sync-review-window.decision.md)); the hold MUST be
  written before `enrollCentralSink` so no daemon tick can precede it.
- **R3.** The skill MUST opt its own session out of capture
  ([LLP 0066](./0066-session-opt-out.spec.md)) as its first action and verify
  success; on failure it MUST say so and continue only with explicit user
  consent.
- **R4.** The skill MUST quote findings as redacted excerpts (mask credential
  bodies, prefer naming files and directories over reproducing content) so
  even an unprotected transcript stays low-content.
- **R5.** The skill MUST explain `ignore` vs `local-only` vs sync before the
  first marking is applied.
- **R6.** The skill MUST apply markings only via `hyp` verbs, with per-item
  confirmation, targeting the machine-local store
  ([LLP 0103](./0103-machine-local-policy-classes.decision.md)); it MUST NOT
  write files into the user's repositories
  ([LLP 0071](./0071-machine-local-exclusion-list.decision.md)).
- **R7.** For every directory marked `ignore` and every flagged session, the
  skill MUST offer `hyp purge` ([LLP 0104](./0104-hyp-purge.decision.md)) as a
  separately confirmed step, so "completely ignored" also means "not sitting
  in the cache".
- **R8.** The flow MUST work for both Claude and Codex; the skill is
  registered for both clients.
- **R9.** `hyp status` MUST show the pending first-sync deadline while the
  hold is live, so a held machine is never a silent state.

## Non-goals {#non-goals}

1. **No server-side deletion.** Data forwarded by a previous enrollment is out
   of scope, as in [LLP 0069 §non-goals](./0069-local-only-dir-selection.spec.md#non-goals).
2. **No org policy interaction.** Whether an org may shorten, extend, or
   forbid the window, or forbid exclusions, remains the deferred central-policy
   concern of [LLP 0071 §org-policy](./0071-machine-local-exclusion-list.decision.md#org-policy).
3. **No session-scoped `local-only`.** Per-session handling is purge-only
   ([LLP 0104](./0104-hyp-purge.decision.md)); a session-id withhold list can
   be minted later if it earns its keep.
4. **Not a data-loss-prevention system.** The flow governs HypAware's own
   surfaces. A user pasting private content into a synced session outside them
   is out of scope (see [LLP 0105 §scope](./0105-query-seam-local-only-visibility.decision.md#scope)).

## `@ref` annotations code will carry {#refs}

- The hold write in the enrolling login fork and the deadline computation:
  `@ref LLP 0101 [implements]`.
- The login deadline message: `@ref LLP 0100#requirements [implements]: R1`.
- The skill sources (claude/codex plugins): `@ref LLP 0100#skill [implements]`.
- The sink-driver hold check: `@ref LLP 0101#hold [implements]`.
