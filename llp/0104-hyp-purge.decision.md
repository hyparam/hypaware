# LLP 0104: `hyp purge` deletes cached rows, explicitly and only locally

**Type:** Decision
**Status:** Accepted
**Systems:** CLI, Usage-Policy, Sources
**Author:** Phil / Claude
**Date:** 2026-07-13
**Related:** LLP 0049, LLP 0030, LLP 0069, LLP 0100, LLP 0103

> Retroactive deletion arrives as its own destructive verb. `hyp purge`
> removes already-cached rows by subtree, by session, by resolved-`ignore`
> sweep, or wholesale, and never touches sinks or the remote. This
> deliberately extends [LLP 0049 non-goal 2](./0049-hypignore-usage-policy.spec.md#non-goals)
> ("prospective-only; no purge"), which stands for the *marking* verbs:
> `hyp ignore` remains non-destructive.
>
> @ref LLP 0049#non-goals [implements] - ships the "separate, destructive capability" non-goal 2 explicitly deferred.

## Context

The privacy review ([LLP 0100](./0100-enrollment-privacy-review.spec.md))
makes 0049's residual-rows stance untenable for the `ignore` class: a user
who marks `~/journal` ignored during the review window means "this must not
sync at the deadline", and export-seam withholding is the `local-only`
contract, not the `ignore` one. "Never recorded" must not silently degrade
to "recorded, but withheld". The cache needs a way to actually forget.

## Decision

**A standalone `hyp purge`, keyed off targets, not off marking events:**

- `hyp purge <path>`: delete cached rows whose `cwd` equals or descends from
  the path (the [LLP 0049 §scope](./0049-hypignore-usage-policy.spec.md#scope)
  ancestor rule), **regardless of the path's class**. Explicit purge may
  remove any data, `local-only` and synced included; the command is the
  user's, not the policy's.
- `hyp purge --session <id>`: delete one session's rows. This is the whole
  per-session retroactive story: session-scoped `local-only` was considered
  and deferred (a session-id withhold list at the export seam is a new
  mechanism for a rare want; the live case is already
  [LLP 0066](./0066-session-opt-out.spec.md)). `session_id` is the partition
  key ([LLP 0030](./0030-session-id-partition-key.decision.md)), making this
  the cheapest possible target.
- `hyp purge --ignored`: delete every cached row whose `cwd` currently
  resolves to `ignore`, from either source (dotfile or machine-local entry,
  [LLP 0103](./0103-machine-local-policy-classes.decision.md)). This is the
  review skill's bulk step, and it finally serves users who dropped a
  `.hypignore` after history was captured.
- `hyp purge --all`: empty the recorded datasets wholesale.
- Bare `hyp purge` with no target errors with usage; there is no implicit
  scope for a destructive verb.

**Boundaries:**

- **Cache-only.** Purge never contacts a sink or the remote and never deletes
  exported copies; server-side deletion stays out of scope
  ([LLP 0069 §non-goals](./0069-local-only-dir-selection.spec.md#non-goals)).
  During the review window ([LLP 0101](./0101-first-sync-review-window.decision.md))
  nothing has synced yet, so purge-before-deadline means genuinely
  never-forwarded.
- **Marking stays non-destructive.** `hyp ignore` in any form never deletes;
  a mistyped path must cost a config entry, not history. The skill composes:
  mark, confirm, then purge, each separately confirmed
  ([LLP 0100 R7](./0100-enrollment-privacy-review.spec.md#requirements)).
- **Resurrection warning.** Purging a subtree whose class still resolves to
  `full` is soft: the next backfill re-imports it from client logs. The verb
  warns and suggests marking `ignore` first; purge of an `ignore`d subtree is
  durable because the capture seam blocks re-import
  ([LLP 0049 R1](./0049-hypignore-usage-policy.spec.md#requirements)).

Mechanics (partition rewrite, `part_id` identity of rewritten parts,
watermark and settlement-buffer interaction) belong to the design doc that
follows, not this record.

## Consequences

- `hyp ignore --check`'s residual count stops being a dead end: it can now
  point at the verb that clears it.
- The forward-sink dedupe story must be checked in design: a purge-then-
  re-record of the same directory must not produce server-side duplicate
  identities the chunk-level dedupe cannot absorb.
