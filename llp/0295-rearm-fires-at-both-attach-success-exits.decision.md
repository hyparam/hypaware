# LLP 0295: The refused re-arm fires at both `hyp client attach` success exits

**Type:** Decision
**Status:** Accepted
**Systems:** Config, Daemon
**Generated-by:** neutral
**Date:** 2026-08-19
**Related:** LLP 0086, LLP 0107, LLP 0138, LLP 0174, LLP 0184, LLP 0186, LLP 0250

> Extends [LLP 0186](./0186-reconciler-refused-marker.design.md)
> `#re-arm-explicit-hyp-attach-re-run-only`. LLP 0186 is Active and does not
> change: this document does not touch its rule (re-arm is the explicit
> `hyp client attach` re-run only, and only for a `refused` marker), it settles which
> *exits* of that command count as the re-run, because `hyp client attach` grew a
> second success exit after LLP 0186 was written. Raised as residual 3 of
> [hyparam/hypaware#887](https://github.com/hyparam/hypaware/issues/887) and
> as a review finding on
> [#900](https://github.com/hyparam/hypaware/pull/900).

## Context

LLP 0186 `#re-arm-explicit-hyp-attach-re-run-only` names the manual re-run as
the one and only trigger that clears a terminal `refused` marker, and locates
the call by the shape the command path had at the time:

> after `registration.attach(...)` (or the equivalent adapter call the command
> path uses) resolves without throwing, and the run was not a `--dry-run`

When that was written, `runClientLifecycle('attach', ...)` had exactly one
success exit, the one that calls the adapter's `attach()` hook, so "after
`attach()` resolves" and "this explicit re-run succeeded" named the same
moment. They no longer do. The daemon-managed install grew a second success
exit: the client is already attached at the live port, so there is nothing to
rewrite, the command reports success and returns without calling `attach()`
at all.

That exit is the one an operator on a daemon-managed install most often
reaches, and it is precisely the exit a user reaches after fixing by hand the
precondition the reconciler refused on. Reading LLP 0186's sentence as a
mechanical requirement (the re-arm is attached to the `attach()` call, not to
the command) makes the re-arm unreachable on exactly the path that needs it,
for a marker whose entire design is that nothing else will ever clear it.

## Decision

<a id="both-success-exits"></a>

### Both success exits

**The re-arm fires at every success exit of an explicit, non-`--dry-run`
`hyp client attach <client>`, including the daemon-managed exit that calls no
adapter `attach()` hook.** Everything LLP 0186 settled about the re-arm is
unchanged and carries to the new exit verbatim: it is gated on the marker's
prior status being `refused` (a `done` marker is never cleared, LLP 0138
`#marker-undo`); a `refused` marker carrying `installed_assets` is rewritten
to `failed` rather than dropped; `--dry-run` re-arms nothing; and no
automatic, `isCurrent`-style re-arm is introduced here either (still the
follow-up candidate LLP 0186 names and does not build).

Reaching the re-arm with the settings already correct rather than freshly
written satisfies the same precondition. LLP 0186's own reasoning for why a
manual attach may re-arm is that the adapter's write is idempotent over its
previous output, so the manual write and the reconciler's next `perform()`
"briefly do the same work twice, which is free". An adapter that is
idempotent over its own output makes "already correct" and "just written" the
same fact about disk; the daemon-managed exit is the case where the first
write already happened, not a case where no write is required.

### Ordered ahead of the asset tail

**At both exits the re-arm runs before `materializeAttachAssets`.** The two
tails are independent, so their order is only visible on failure, and there it
matters in one direction only. `materializeAttachAssets` swallows a per-copy
failure, but not everything it does is guarded: the plan read, the prune pass,
and the digest of an installed asset can all throw, and a throw there reaches
the command loop's outer catch. With the re-arm second, an asset-tail failure
would leave the `refused` marker short-circuiting the reconciler forever,
after exactly the explicit re-run that is its only trigger. With the re-arm
first, that failure costs the assets and nothing else. It cannot cost the
assets in the other direction, because the re-arm logs and swallows its own
marker error (`client.attach.marker_retract_failed`) rather than throwing.

## Consequences

- `src/core/commands/clients.js` calls one shared `rearmRefusedAttachMarker`
  helper from both success exits, so a future third exit is a call site to
  add rather than logic to re-derive.
- LLP 0186's `#re-arm-explicit-hyp-attach-re-run-only` keeps its text; its
  `Extended-by:` line names this document.
- No change to `action_reconciler.js`, to `ActionMarkerStatus`, or to any
  handler: this settles a call site, not the marker seam.

## Test strategy

Extends LLP 0186's own "Re-arm" cases to the second exit, in
`test/core/attach-daemon-managed-tails.test.js`:

- A `refused` marker is re-armed when `hyp client attach` takes the daemon-managed
  already-attached exit.
- A `done` marker and its `installed_assets` still survive that exit
  untouched (LLP 0138 `#marker-undo` holds at both exits).
- The re-arm still fires when the asset tail after it fails, proving the
  ordering above.

## References

- [LLP 0186](./0186-reconciler-refused-marker.design.md): the `refused`
  marker state and the re-arm rule this document scopes to both exits
- [LLP 0138](./0138-client-assets-one-install.decision.md): `#marker-undo`,
  why a `done` marker is never collateral of the re-arm
- [LLP 0107](./0107-skills-ride-attach.decision.md): the asset tail
  the re-arm is now ordered ahead of
- [LLP 0174](./0174-attach-prompts-to-enable.design.md): the backfill offer,
  the other tail this same exit was skipping
- [LLP 0250](./0250-marker-records-the-effect-it-overwrites.decision.md): the
  other extension of LLP 0186's marker rules
- `src/core/commands/clients.js`: both success exits and the shared
  `rearmRefusedAttachMarker` helper
