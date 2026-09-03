# LLP 0364: A stored refusal re-arms itself when the build's re-arm generation moves past it

**Type:** Decision
**Status:** Accepted
**Systems:** Config, Daemon, Clients
**Generated-by:** neutral
**Date:** 2026-09-03
**Related:** LLP 0036, LLP 0041, LLP 0138, LLP 0163, LLP 0184, LLP 0186, LLP 0250, LLP 0258, LLP 0262, LLP 0295, LLP 0363

> Extends [LLP 0186](./0186-reconciler-refused-marker.design.md)
> `#follow-up-candidate-not-built-here` and
> [LLP 0363](./0363-version-floor-refusal-is-retryable.decision.md)
> `#markers-already-refused-are-not-migrated`. Both are Accepted and neither
> changes: LLP 0186's `refused` state, its explicit-`hyp client attach` re-arm,
> and its rule that the freshness hook is never consulted for a refusal all
> stand, and so does LLP 0363's classification of the version floor as
> retryable. This document settles the one thing they each named and each
> declined to build: how a refusal a *shipped* release already wrote on disk
> becomes retryable again. Raised as residual 2 of
> [hyparam/hypaware#999](https://github.com/hyparam/hypaware/issues/999) and
> scoped by [hyparam/hypaware#1247](https://github.com/hyparam/hypaware/issues/1247).

Coverage anchor:

`@ref LLP 0186#follow-up-candidate-not-built-here: the named follow-up is built here, but as a release-scoped generation bump rather than the per-handler isCurrent contract that document sketched`

## Context

[LLP 0363](./0363-version-floor-refusal-is-retryable.decision.md) unmarked the
Claude OTEL version-floor throw, so a below-floor machine records LLP 0041's
retryable `failed` marker and re-attaches by itself the first pass after Claude
Code updates. It reaches no machine that recorded the refusal earlier. The
marked throw shipped in v1.24.0 through v1.30.0; a joined host that ran one
reconcile pass on any of them below the floor holds

```jsonc
{ "attach": { "claude": { "status": "refused", "request_key": "claude", "reason": "...", "at": "..." } } }
```

in `<stateRoot>/config-control/client-actions.json`, and three properties
compose to keep it there forever: the store carries no schema version so a
package upgrade does not invalidate it, `refused` short-circuits before
`markerIsCurrent()` or `perform()` is consulted (LLP 0186
`#how-the-reconciler-distinguishes-it-from-done`), and the only clearing path
is an explicit `hyp client attach claude` the user has no reason to run. The
host reports `attach claude [refused]` on a client that is now years past the
floor, and captures nothing.

The obstacle is the same one LLP 0363 refused to improvise around: **no error
code is persisted on a marker**. Nothing on disk tells a floor refusal, which a
later release decided is retryable, from a JSONC or `CA_MISSING` refusal, which
is still terminal. Every design below starts from that.

## Decision

<a id="the-generation-bit"></a>

### One integer, on the marker, bumped by the release that reclassifies

`ActionMarker` gains one optional field, `rearm_generation: number`, and the
reconciler gains one exported constant, `REFUSAL_REARM_GENERATION`, currently
`1`. Every `refused` marker the reconciler writes is stamped with the constant.
The forward-gap short-circuit reads it:

- `markerRearmGeneration(existing) >= REFUSAL_REARM_GENERATION`: skip
  unconditionally, exactly as LLP 0186 wrote it.
- below it (which includes **absent**, read as generation `0`, the whole
  pre-LLP-0364 fleet): fall through to `perform()` once, logging
  `client_action.refusal_rearmed`.

The constant is bumped in the same release that moves a throw site out of
`markActionRefused`, because that is precisely the event that makes the markers
already on disk wrong. Generation `1` is LLP 0363's reclassification of the
version floor.

The re-arm rewrites nothing. It only declines to short-circuit, and the
outcome branches LLP 0186 already designed do the rest: a `done`, `failed`, or
`refused` marker written over the old one carries `installed_assets`
(LLP 0138 `#marker-undo`) and `prior_done` (LLP 0250 `#the-bit`) forward the
way every terminal rewrite already does. So the automatic re-arm is not a
second path beside `rearmRefusedActionMarker`; it is strictly less machinery
than that function needs, because that one runs *outside* a pass and has to
leave a store the next pass will read, while this one is the pass.

<a id="one-retry-not-a-retry-loop"></a>

### Exactly one retry, ever, whatever the refusal turns out to be

Because the marker carries no error code, the re-arm cannot be selective: a
JSONC refusal is re-armed alongside a floor refusal. It costs one
re-`perform()`. The re-armed pass asks the handler, the handler refuses again,
and the fresh `refused` marker is stamped at the current generation, so every
later pass short-circuits on it as before. The refusal is terminal again, at a
cost of one read-only re-check per marker per bump.

That bound is what keeps [LLP 0184](./0184-reconciler-retries-permanent-failures.issue.md)
closed. LLP 0184's complaint is a permanent failure retried on *every* boot,
loud and unfixable; one retry per reclassifying release is not that, and it is
the smallest price the absence of a persisted error code allows. The retry is
also cheap and side-effect-free by construction: every refusal site refuses
before touching the client's file (LLP 0163's JSONC check reads and refuses,
LLP 0258 `#version-floor`'s preflight runs before any settings I/O, OpenClaw's
ownership conflict is a read of `openclaw.json`), and every attach adapter is
already required to be idempotent over its own output
(LLP 0086 `#re-attach-on-drift`).

The re-armed pass is not exempt from anything else. It re-enters `perform()`
through the normal forward gap, so the handler's own guards, the endpoint
check, and the outcome branches all apply unchanged.

<a id="why-not-the-alternatives"></a>

### The three routes not taken

- **Migrate on the reason text.** A one-shot pass that re-arms markers whose
  `reason` matches the floor message. Rejected: it promotes a runtime string
  written for a human into a persisted contract, it is silently wrong the first
  time the message is reworded, and it buys nothing over the generation bit,
  which reaches the same hosts without reading the field.
- **Persist the error code on the marker.** The field LLP 0363 declined to add.
  Rejected here too, and for a reason that survives that document: a code
  persisted from now on is absent from every marker in the affected population,
  which is the whole population this document exists for. It would be a new
  per-adapter contract that fixes nothing already broken.
- **Consult `isCurrent` for `refused` markers**, the shape LLP 0186
  `#follow-up-candidate-not-built-here` sketched. Rejected: the freshness hook
  answers "did the input drift?", and the attach handler's answer for a
  `claude` marker whose `mode` is not `otel` is "stale" on every pass
  (LLP 0262 `#migration`). Wiring it to the refusal short-circuit would
  re-`perform()` a JSONC refusal on every boot, which is LLP 0184's defect
  restored exactly. The per-handler "was this refusal's input the thing that
  changed?" contract that would make it safe is a contract no handler can
  honour against a marker that records no code, so LLP 0186's follow-up is
  built here in the release-scoped shape instead of the per-handler one.

<a id="what-does-not-change"></a>

### What does not change

- `refused` is still terminal, still short-circuits before `markerIsCurrent()`,
  and still means "a precondition only the user can fix" (LLP 0186).
- The explicit `hyp client attach <client>` re-arm is untouched, at both of its
  success exits (LLP 0186 `#re-arm-explicit-hyp-attach-re-run-only`, LLP 0295).
  It is still the way a user clears a refusal they have just fixed, without
  waiting for a release.
- `JSONC` and `CA_MISSING` keep their `markActionRefused` wrapping
  (LLP 0363 `#the-other-refusal-sites-are-unchanged`), as does OpenClaw's
  ownership conflict.
- No change to the marker store's shape beyond the one optional field, to
  `ActionOutcome`, to the kernel's `attach()` contract, or to the reverse gap.
- `attempts`-bounding on genuinely transient `failed` markers stays out of
  scope, as LLP 0186 `#explicitly-out-of-scope` left it.

## Consequences

- A host that recorded the floor refusal on v1.24.0 through v1.30.0 attaches on
  the first daemon boot or config-confirmation edge after upgrading past this
  release, with no manual command, and lands the LLP 0262 proxy-to-OTEL
  migration it has been missing.
- A host holding a JSONC or `CA_MISSING` refusal performs one extra read-only
  re-check on that same first pass and is terminal again, at generation 1.
- `hyp status` is unchanged. A marker awaiting its re-arm still reports
  `[refused]` with the `run 'hyp client attach claude'` repair line, which
  stays true: that command clears it too, and is the faster of the two routes.
- Every future reclassification of a refusal has a defined migration: bump
  `REFUSAL_REARM_GENERATION` in the same release. Without the bump the shipped
  fleet keeps whatever the old release decided, which is the failure this
  document is the answer to.

## Test strategy

- **The generic property**, in `test/core/action-reconciler.test.js`: a
  `refused` marker seeded with no `rearm_generation` is re-`perform()`ed exactly
  once; a handler that refuses again writes a marker stamped at
  `REFUSAL_REARM_GENERATION` and is skipped on every later pass, so
  `performCalls` stays at one; a handler whose precondition has cleared reaches
  `done` on that single re-perform.
- **The population, end to end**, in
  `test/plugins/claude-settings-otel-attach.test.js`, through the real
  reconciler, the real attach handler, and the real Claude settings writer: the
  v1.24.0-v1.30.0 marker shape plus a client above the floor yields one pass
  ending `done` with `mode: 'otel'` and the managed OTEL env block on disk. This
  replaces the test LLP 0363 `#markers-already-refused-are-not-migrated` pinned
  the limit with, which is the test that was written to fail the day this
  landed.
- **The LLP 0184 guard, executable**, in the same file: a legacy marker over a
  JSONC settings file is re-armed once, refused again, and asks the adapter
  nothing on the two passes that follow.

## References

- [LLP 0186](./0186-reconciler-refused-marker.design.md): the `refused` state,
  its unconditional short-circuit, and `#follow-up-candidate-not-built-here`,
  the follow-up this document builds
- [LLP 0363](./0363-version-floor-refusal-is-retryable.decision.md):
  `#markers-already-refused-are-not-migrated`, the population this document
  reaches
- [LLP 0184](./0184-reconciler-retries-permanent-failures.issue.md): the
  forever-retry rule the one-retry bound keeps closed
- [LLP 0041](./0041-central-config-client-actions.design.md): `failed` as the
  retried-next-pass state, and when a pass runs
- [LLP 0138](./0138-client-assets-one-install.decision.md) `#marker-undo`,
  [LLP 0250](./0250-marker-records-the-effect-it-overwrites.decision.md)
  `#the-bit`: the two halves of the undo record a re-armed pass carries forward
  through the existing rewrite branches
- [LLP 0258](./0258-attach-injects-telemetry-via-settings-env.decision.md)
  `#version-floor`, [LLP 0163](./0163-attach-backs-up-a-malformed-block.decision.md):
  the refusal sites the re-arm re-checks
- [LLP 0295](./0295-rearm-fires-at-both-attach-success-exits.decision.md): the
  explicit re-arm, unchanged and still the user-driven route
- `src/core/config/action_reconciler.js`: `REFUSAL_REARM_GENERATION`,
  `markerRearmGeneration`, the gated short-circuit, and the stamped `refused`
  write
- `src/core/config/types.d.ts`: `ActionMarker.rearm_generation`
- `src/core/config/action_attach.js`: `isCurrent`, whose note about the
  unmigrated population this document retires
