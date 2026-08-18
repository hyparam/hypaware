# LLP 0250: A terminal marker rewrite records the effect it overwrites

**Type:** Decision
**Status:** Accepted
**Systems:** Config, Daemon
**Generated-by:** neutral
**Date:** 2026-08-17
**Related:** LLP 0036, LLP 0041, LLP 0045, LLP 0086, LLP 0107, LLP 0138, LLP 0184, LLP 0186

> Extends [LLP 0138](./0138-client-assets-one-install.decision.md)
> `#marker-undo` and [LLP 0186](./0186-reconciler-refused-marker.design.md)
> `#how-the-reconciler-distinguishes-it-from-done`. Both are Active and neither
> changes: this document adds the missing half of the evidence they already
> reason about, and one clause to the reverse gap's drop condition that reads
> it. Raised as item 2 of
> [hyparam/hypaware#780](https://github.com/hyparam/hypaware/issues/780),
> the deferred-findings issue from
> [#630](https://github.com/hyparam/hypaware/pull/630), where the maintainer
> deferred it: "The marker-schema question ... needs its own design pass and
> review."

## Context

LLP 0138 `#marker-undo` settled that an action marker is an undo record, and
that a `done` marker rewritten to `failed` (or, under LLP 0186, to `refused`)
carries `installed_assets` forward, because the copies it names are still on
disk after the rewrite. It settled the reverse gap's reading of that field in
one sentence:

> `failed` normally means nothing was applied, and `installed_assets` is the
> evidence that something was.

That sentence is true for the half of an attach that copies files. It is not
true for the half that writes the client's settings, and nothing in the marker
schema records that half at all.

So the gate is unsound for a client whose attach copies no files. OpenClaw is
the routine case: its attach writes `models.providers` into
`~/.openclaw/openclaw.json` and installs no assets. The failing sequence, all
on `master`:

1. The reconciler attaches openclaw. `perform()` returns `done`; the marker
   records `status: 'done'` and no `installed_assets`, because there are none.
2. The recorded input drifts (LLP 0086's `isCurrent()` reports the marker
   stale), so the forward gap re-`perform()`s. This time the adapter refuses
   (the user hand-edited the provider entry) or fails. The marker is rewritten
   in place to `refused`/`failed`, carrying an empty asset list forward.
3. The org drops openclaw from the fleet config. The reverse gap sees a
   terminal marker with no `installed_assets`, reads that as "this key never
   applied anything", and **deletes the marker without calling `reverse()`**.

The settings entry written in step 1 is still in `openclaw.json`. After step 3
nothing on disk names it: `hyp status` shows no action, the reconciler has no
marker to reverse, and a later `hyp detach openclaw` is the only thing that
would find it, and only because it reads the file rather than the marker. That
is precisely the orphaning `#212` and LLP 0138 `#marker-undo` refuse to accept,
reached by a route neither of them checked.

Reproduced on `master` at `04330abb` with a three-pass fake handler
(`done` &rarr; `refused` &rarr; key no longer desired): `reverse()` is never
called, `reconcile()` reports no result for the key, and the marker file loses
the bucket entirely.

The reverse gap's own comment already argues for the opposite behaviour: "the
settings half cannot [degrade to naming-and-releasing], because nothing else on
disk would own the settings it left written." The comment was right; the
condition beneath it did not implement it, because it had nothing to read.

## Decision

**A `done` marker rewritten to a terminal state records that it overwrote an
applied effect, and the reverse gap will not drop a marker that says so.**

### The bit {#the-bit}

`ActionMarker` (`src/core/config/types.d.ts`) gains one optional field,
`prior_done?: boolean`. It is written as `true` by the reconciler's `failed`
and `refused` rewrite branches when the marker they replace already recorded an
applied effect, and it is otherwise absent.

```jsonc
{
  "attach": {
    "openclaw": {
      "status": "refused",
      "request_key": "openclaw",
      "reason": "models.providers.anthropic is not ours",
      "at": "2026-08-17T00:00:00.000Z",
      "prior_done": true
    }
  }
}
```

Three properties, each deliberate:

- **It is a bit, not a description of the effect.** The reconciler is generic:
  it does not know that this handler's effect was a settings write and that
  handler's was an import. It knows only that a pass reached `done`. What to
  undo is still `reverse()`'s job, read from disk (LLP 0045 §Part 3), which is
  exactly why a bit is enough. Recording *what* was applied would be inventing
  a per-handler schema the reverse path does not need.
- **It is carried, not recomputed.** `markerRecordsPriorDone(existing)` is
  true when `existing.status === 'done'` *or* when `existing.prior_done` is
  already `true`, so the bit survives an arbitrary chain of later rewrites
  (`done` &rarr; `failed` &rarr; `failed` &rarr; `refused`), the same way
  `installed_assets` survives one.
- **A `done` marker never carries it.** `status: 'done'` already says an effect
  is applied, and the reverse gap already routes a `done` marker to
  `reverse()`. Setting the bit there would be a second name for the same fact,
  and two names for one fact are two chances to disagree.

The field is set **after** the outcome's `detail` spread, unlike
`installed_assets` on the `failed` branch. `detail` is handler-reported and may
legitimately override handler-reported fields; `prior_done` is reconciler
bookkeeping about an effect that is really on disk, and a handler that erased
it would re-open exactly this defect.

It is read through one exported accessor, `markerRecordsPriorDone()`, beside
`readInstalledAssets()` and for the same reason LLP 0138 gave for that one:
the marker store is persisted JSON, every path that drops a marker has to read
the evidence first, and two readers of one field are two chances to disagree
about what it holds.

### The drop condition {#the-drop-condition}

The reverse gap's shortcut in `reconcile()` (`src/core/config/action_reconciler.js`)
gains one clause. A no-longer-desired key's marker is dropped without reversing
only when it is terminal **and** both halves of the evidence are empty:

```js
if (
  !marker ||
  ((marker.status === 'failed' || marker.status === 'refused') &&
    readInstalledAssets(marker).length === 0 &&
    !markerRecordsPriorDone(marker))
) {
```

Everything else is unchanged. A terminal marker that never reached `done` is
still dropped (a refusal writes nothing, and a first-pass failure applied
nothing), which is the whole reason LLP 0186 put `refused` in this gate.

### The trade this re-opens, accepted again

LLP 0138 `#marker-undo` already accepted this trade once, for the asset half:
closing the orphaning re-opens the retained-forever case, because an `attach`
reverse fails deterministically when the descriptor is gone or declares no
`attachProbe` (`#212`). A marker carrying `prior_done` for such a client now
retries and error-logs every pass instead of being dropped once.

The same answer applies, and applies more strongly here. A retained terminal
marker is visible in `hyp status` and blocks nothing (only a `done` marker
blocks a later re-attach, `#217`). Dropping it destroys the only record of a
settings edit that is really on disk. LLP 0138 `#refusal-is-not-failure` lets
the *asset* half degrade to naming-and-releasing precisely because the settings
half cannot: nothing else on disk would own what it left written.

## Consequences

- **No migration, no format break.** `prior_done` is absent on every marker
  written before this document. Absent reads as "no prior done", which is
  exactly `master`'s behaviour, so an existing store keeps working and the
  first rewrite after the upgrade records the bit.
- **Nothing else reads it.** `hyp status`, `hyp detach` and `hyp leave` are
  untouched. `ActionMarker` has an index signature, so the field rides through
  `readClientActionStatus()` verbatim and renders nowhere.
- **`hyp leave`'s own copy of the gate is out of scope here.**
  `src/core/commands/central.js` carries a sibling shortcut with the same
  unsoundness. [#630](https://github.com/hyparam/hypaware/pull/630) removes
  that shortcut outright rather than teaching it a new field, so this document
  deliberately does not touch it; the two fixes are independent and neither
  depends on the other landing.
- **`rearmRefusedActionMarker()` is unchanged.** It drops an assetless
  `refused` marker, but only immediately after an explicit `hyp attach` that
  just succeeded and rewrote the settings, and a manually attached client is
  reversed by `hyp detach` from disk with no marker at all. No effect is
  stranded, so the bit changes nothing there.
- **What is still not settled:** a `reverse()` that returns `refused`. LLP 0186
  §Explicitly out of scope left that expressible-but-unreachable, falling into
  the reverse gap's generic failure arm, and this document does not settle it
  either. It is item 1 of #780 and needs its own request.

## Test strategy

`test/core/action-reconciler.test.js`, two tests, both driven end to end
through `reconcile()` so nothing about the bit is hand-seeded:

- **The settings-only rewrite reverses.** A handler that returns `done` with no
  assets, then `refused` after `isCurrent()` reports drift, then stops being
  desired. Assert the `done` marker carries neither `installed_assets` nor
  `prior_done`, that the rewrite to `refused` records `prior_done: true`, and
  that the reverse gap calls `reverse()` and reports `reversed` rather than
  silently dropping the key. Removing the new clause from the drop condition
  fails the third assertion.
- **The bit persists, and does not over-fire.** Two request keys under one
  handler: one that reaches `done` and then fails twice, one that fails from
  the first pass. Assert `prior_done` is set on the first and absent on the
  second, that it survives the second failing rewrite (which reads it off a
  marker that is already `failed`), that `attempts` still counts, and that the
  reverse gap reverses only the first.

The existing LLP 0186 reverse-gap test (an assetless `refused` marker for a key
that never reached `done` is dropped; one carrying `installed_assets` is
reversed) is unchanged and still passes: it is the control this document must
not break.

## References

- [LLP 0138](./0138-client-assets-one-install.decision.md) `#marker-undo`,
  `#refusal-is-not-failure`: the undo-record rule this extends, and the
  asset-only evidence it reasoned from
- [LLP 0186](./0186-reconciler-refused-marker.design.md): the terminal
  `refused` state whose reverse-gap cell inherits the same gap
- [LLP 0045](./0045-client-attach.design.md) §Part 3: reverse runs from disk,
  which is why a bit is enough and a description of the effect is not
- [LLP 0086](./0086-attach-tracks-ephemeral-port.decision.md): the `isCurrent`
  freshness hook that makes a `done` marker re-`perform()` at all, without
  which this sequence is unreachable
- [LLP 0041](./0041-central-config-client-actions.design.md): the reconciler
  and its marker states (unedited; extended through LLP 0186)
- `src/core/config/action_reconciler.js`: the two rewrite branches and the
  reverse gap's drop condition
- `src/core/config/types.d.ts`: `ActionMarker.prior_done`
- `test/core/action-reconciler.test.js`: the two regression tests
