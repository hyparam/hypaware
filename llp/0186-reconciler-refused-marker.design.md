# LLP 0186: The reconciler's terminal `refused` marker state

**Type:** design
**Status:** Active
**Systems:** Config, Daemon
**Generated-by:** neutral
**Related:** LLP 0036, LLP 0041, LLP 0086, LLP 0109, LLP 0184
**Extended-by:** LLP 0247 (#how-the-reconciler-distinguishes-it-from-done: the reverse gap's drop also reads a `prior_done` bit, so a settings-only attach rewritten to `refused` is reversed rather than dropped)

> [LLP 0184](./0184-reconciler-retries-permanent-failures.issue.md) reports
> that the action reconciler ([LLP 0036](./0036-central-config-driven-client-actions.decision.md)
> / [LLP 0041](./0041-central-config-client-actions.design.md)) treats every
> `failed` marker as transient and retries it forever, which is wrong for a
> *refusal*: a precondition failure only the user can fix (a conflicting
> `models.providers` entry, a JSONC settings file). This document is the
> implementation design for the fix the issue's maintainer picked from its
> "Proposed direction" candidates: **option 1, a terminal `refused` marker
> state**, routed through the pipeline as an extension of LLP 0041 (LLP 0041
> is Active and does not change; this document is noted on its
> `Extended-by:` line). Decided in
> [hyparam/hypaware#601](https://github.com/hyparam/hypaware/issues/601).

Coverage anchor:

`@ref LLP 0184: reconciler retries permanently-failed client actions on every boot; the refused marker state, the widened ActionOutcome/handler-outcome seam, and the hyp status attention-needed rendering this document settles are LLP 0184's fix`

The maintainer's three governing choices, restated because they bound every
decision below and are not renegotiable in this document:

1. **Option 1 only.** Not bounded retries, not a status-only fix. Re-arm is
   **the explicit `hyp attach` re-run only** in this first pass; the
   `isCurrent`-style input-hash re-arm ([LLP 0086](./0086-attach-tracks-ephemeral-port.decision.md)
   precedent) is named below as a follow-up candidate, **not built here**.
2. **Extension, not edit.** LLP 0041's marker-state text ("`failed` ...
   not terminal - retried next pass") is left exactly as written; this
   document adds a state beside it rather than rewriting that section.
3. **`attempts`-bounding on genuinely transient `failed` markers is left
   open**, out of scope for this change set (see
   [Explicitly out of scope](#explicitly-out-of-scope)).

## Current shape, for reference

Two files carry the whole seam today:

- `src/core/config/action_reconciler.js`: `reconcile()`'s forward-gap loop
  short-circuits only `existing.status === 'done'` (subject to the handler's
  optional `isCurrent` freshness hook, LLP 0086); anything else re-`perform()`s
  and any non-`done` outcome is written as `{ status: 'failed', reason,
  attempts: attempts+1, ... }`.
- `src/core/config/types.d.ts`: `ActionMarkerStatus` is `'done' | 'failed' |
  'applied'`; `ActionOutcome.status` (what a handler's `perform()`/`reverse()`
  returns) is `'done' | 'failed'`.

Two handlers exist: `action_backfill.js` (run-once, subprocess, no refusal
concept) and `action_attach.js` (adapter-driven, in-process). The attach
handler calls into a per-client adapter's `attach(ctx): Promise<void>`
(`hypaware-plugin-kernel-types.d.ts`, `AiGatewayClientRegistration`), which
signals failure only by throwing; `perform()` catches the throw and returns
`{ status: 'failed', reason: err.message }`. Two adapters already compute a
transient/permanent distinction and drop it before it reaches that catch:

- **OpenClaw** (`hypaware-core/plugins-workspace/openclaw/src/attach.js`):
  `fail(span, attachCtx, logger, settingsPath, reason, errorKind)` is called
  with `errorKind` values `'settings_path'`, `'endpoint'`, `'refused'`,
  `'read'`, `'write'`. Only `errorKind: 'refused'` (the
  `conflictingProviderKeys` ownership-conflict check, LLP 0167#attach-detach)
  is a true precondition refusal; the rest are environmental (a bad path
  resolution, a transient read/write failure, an unresolved endpoint this
  boot). `errorKind` reaches the span and the log but the returned
  `OpenclawAttachOutcome` is `{ status: 'failed', reason }` either way
  (`hypaware-core/plugins-workspace/openclaw/src/types.d.ts`). Its
  `index.js` wrapper then does `if (outcome.status === 'failed') throw new
  Error(outcome.reason)`: a bare message, no `errorKind`, crossing the
  kernel's throw-only seam.
- **Claude** (`hypaware-core/plugins-workspace/claude/src/settings.js`):
  `ClaudeSettingsError` already carries a `.code` (`'JSONC'`,
  `'MALFORMED_JSON'`, `'NOT_AN_OBJECT'`, `'CONCURRENT_EDIT'`,
  `'INVALID_PORT'`, ...). Only `'JSONC'` ("appears to be JSONC; refuse to
  modify") is the LLP 0163 repair-not-refuse design's one deliberate refusal;
  the rest are the same kind of environmental failure OpenClaw's non-`refused`
  kinds are. `index.js` rethrows the original error unchanged, so `.code`
  physically survives to `action_attach.js`'s catch today, but nothing reads
  it: `perform()`'s catch only takes `err.message`.

Both adapters, in other words, already know the bit. Nothing before this
document lets a value carrying it reach the marker.

## The `refused` marker state

### On-disk shape

`ActionMarkerStatus` (`src/core/config/types.d.ts`) widens from
`'done' | 'failed' | 'applied'` to `'done' | 'failed' | 'refused' |
'applied'`. `ActionMarker` gains no new field: a refused marker reuses `at`
(the ISO time the refusal was recorded, the same field `done` uses for "when
this state was reached", since a refusal is a terminal state exactly like
`done` is) and `reason` (the same field `failed` uses). No `attempts`: a
refused marker is never re-`perform()`ed, so nothing increments it, and the
absence itself is part of the fix. `installed_assets` (if any were carried
from a prior `done`/`failed` marker at the same request key) is preserved
across the rewrite the same way the `done` and `failed` branches already
preserve it, so a `refused` marker never orphans files a previous successful
attach installed.

```jsonc
{
  "attach": {
    "openclaw": {
      "status": "refused",
      "request_key": "openclaw",
      "reason": "models.providers.anthropic already exists in ~/.openclaw/openclaw.json and was not written by HypAware; attach refuses to merge (LLP 0167#attach-detach). Remove it by hand or run 'hyp detach --client openclaw' first.",
      "at": "2026-08-04T00:00:00.000Z"
    }
  }
}
```

### How the reconciler distinguishes it from `done`

Both are terminal in the sense of "the forward-gap loop skips this request
key without calling `perform()` again", but they are **not** the same
short-circuit rule, on the maintainer's explicit instruction that re-arm is
the explicit `hyp attach` re-run only, with no new per-handler contract this
pass:

- `done` short-circuits **subject to `markerIsCurrent()`** (the LLP 0086
  freshness hook): a handler with `isCurrent` can still report a `done`
  marker stale and force a forward-gap re-`perform()`.
- `refused` short-circuits **unconditionally**. `markerIsCurrent()` is not
  consulted for it in this pass; extending it to be is exactly the follow-up
  candidate named below, deliberately not built here.

In `reconcile()`'s forward-gap loop (`src/core/config/action_reconciler.js`,
currently one `if` around line 139), the shape becomes two checks in
sequence: a `refused` marker skips unconditionally; a `done` marker skips
through the existing `markerIsCurrent()` gate, unchanged. Everything else
(no marker, or a `failed` marker) falls through to `perform()` exactly as
today.

The reverse-gap loop's per-marker cleanup (the block that drops a `failed`
marker for a no-longer-desired key unless it carries `installed_assets`)
treats `refused` the same way `failed` is treated there: it recorded no
successful effect by itself (attach's own refusal write never touched
`openclaw.json`), so a `refused` marker for a key the config stops naming is
dropped like an assetless `failed` one, and kept (routed to `reverse()`) when
it carries `installed_assets` from an earlier successful attach that later
drifted into a refused re-`perform()`.

### Writing it

In the outcome-handling branch of the forward-gap loop (`if (outcome.status
=== 'done') {...} else {...}`), add a third branch, `else if (outcome.status
=== 'refused')`, parallel to the existing two: it writes the marker shape
above and pushes `{ kind, requestKey, outcome: 'refused', reason }` onto
`results` (so `ReconcileActionResult.outcome` widens from `'done' | 'skipped'
| 'failed' | 'reversed'` to add `'refused'`). It logs at the same level the
`failed` branch does (`log.error`, `client_action.refused`,
`[Attr.ERROR_KIND]: 'action_refused'`) since a refusal is exactly as loud as
a failure, just not going to repeat.

## The widened handler outcome type across the reconciler seam

`ActionOutcome.status` (`src/core/config/types.d.ts`) widens from `'done' |
'failed'` to `'done' | 'failed' | 'refused'`. This is the type every
`ActionHandler.perform()`/`reverse()` returns, and it is where "the bit
crosses the reconciler seam": a handler that wants a permanent refusal now
says so directly, `{ status: 'refused', reason }`, instead of the reconciler
inferring it from anything else. `runOutcome()`'s throw-normalizer
(`action_reconciler.js`) widens its accepted-shape check from `outcome.status
=== 'done' || outcome.status === 'failed'` to include `'refused'`.

This is the whole of the seam for a handler that constructs its own
`ActionOutcome` directly (any current or future non-adapter-backed handler:
backfill stays untouched, see below). It is not the whole of the seam for
`action_attach.js`, because that handler's failures arrive as a caught throw
from the kernel's `attach(ctx): Promise<void>` contract, which has no
`status` field to widen. Two designs were considered for getting the bit
across *that* narrower gap:

- **Widen the kernel contract itself**: change
  `AiGatewayClientRegistration.attach()` to return a structured result
  instead of signaling only by throwing. Rejected for this pass: it is an
  Accepted-kernel-surface change (`hypaware-plugin-kernel-types.d.ts`, under
  LLP 0045's authority) touching every adapter (`claude`, `codex`,
  `openclaw`) and their tests, for a bit only one call site per adapter
  currently needs to carry. Out of proportion to what LLP 0184 asks for.
- **Mark the thrown Error** (chosen): a purely additive convention that
  needs no signature change and breaks no adapter that does not opt in.

### `markActionRefused` / `isActionRefused`

New module `src/core/config/action_refusal.js`, the same-directory sibling
of `action_attach.js` and `action_backfill.js`:

```js
/**
 * Mark a thrown Error as a permanent refusal, so it survives the kernel's
 * throw-only `attach(): Promise<void>` seam (hypaware-plugin-kernel-types.d.ts)
 * and action_attach.js's perform() catch can tell it apart from an
 * environmental failure that might succeed on retry.
 * @param {Error} err
 * @returns {ActionRefusalError}
 */
export function markActionRefused(err) { ... }

/**
 * @param {unknown} err
 * @returns {boolean}
 */
export function isActionRefused(err) { ... }
```

`ActionRefusalError` (new `interface` in `types.d.ts`, extending `Error`
with one required `hypActionRefused: true` field) is the marker shape;
`markActionRefused` sets it, `isActionRefused` reads it defensively (`err
instanceof Error && err.hypActionRefused === true`, tolerant of anything
that is not that shape). `action_attach.js`'s `perform()` catch becomes:

```js
} catch (err) {
  return {
    status: isActionRefused(err) ? 'refused' : 'failed',
    reason: err instanceof Error ? err.message : String(err),
  }
}
```

### Migration: who calls `markActionRefused`

- **OpenClaw** (`attach.js`'s `fail()` call site with `errorKind ===
  'refused'`, the `conflictingProviderKeys` branch in `attach()`): its
  `OpenclawAttachOutcome` union widens to add `{ status: 'refused', reason:
  string }`; that one call site returns it instead of `{ status: 'failed'
  }`. `index.js`'s wrapper widens its translation: `if (outcome.status ===
  'refused') throw markActionRefused(new Error(outcome.reason))`, alongside
  the unchanged `'failed'` branch. The other four `errorKind` values
  (`settings_path`, `endpoint`, `read`, `write`) are unchanged: they keep
  returning `{ status: 'failed' }` and therefore keep retrying, because
  nothing about them is a property of user config the way the ownership
  conflict is (a transient read/write error may clear on its own; an
  unresolved endpoint this boot resolves next boot).
- **Claude** (`settings.js`, the `looksLikeJsonc(raw)` throw site): wrap the
  `throw new ClaudeSettingsError(..., { code: 'JSONC', cause: err })` with
  `markActionRefused(...)`. The other `ClaudeSettingsError` sites
  (`MALFORMED_JSON`, `NOT_AN_OBJECT`, `CONCURRENT_EDIT`, `INVALID_PORT`, the
  two plain read/stat failures) are unchanged, for the same reason as
  OpenClaw's non-`refused` kinds: they are not user-precondition refusals.
- **Codex**: no existing throw site is a precondition refusal (grep of
  `hypaware-core/plugins-workspace/codex/src/` found none), so nothing
  migrates there in this pass. The mechanism is available to it the moment
  one exists.
- **Backfill handler** (`action_backfill.js`): unchanged. LLP 0041 already
  names its failure modes ("a `hyp backfill` subprocess dying, a transcript
  dir briefly missing") as exactly the transient case `failed` was designed
  for; LLP 0184 does not report a backfill refusal, and this design does not
  invent one.

### What an unmigrated handler or call site defaults to

Nothing changes for it. `runOutcome()` still turns any throw or malformed
return into `{ status: 'failed', ... }`; a handler that never returns or
throws a marked `'refused'` outcome behaves exactly as it does on `master`
today. Adding `'refused'` to `ActionOutcome` is purely additive: no handler
is required to touch it, and no existing test's expected `'failed'` marker
changes shape.

## `hyp status` attention-needed surface

`ClientActionState` (`src/core/daemon/types.d.ts`) widens from `'done' |
'failed' | 'pending' | 'n/a'` to add `'refused'`. `ClientActionReport` needs
no new field: `reason` and `at` (already optional on the interface) are
populated for a `refused` entry the same way `reason`/`lastAttempt` are for
`failed` (no `attempts`, since the marker never carries one).

`buildClientActionsReport()` (`src/core/daemon/status.js`) gains a branch
between the existing `marker.status === 'failed'` check and the generic
`else if (marker)` ("done"/"applied") fallthrough:

```js
} else if (marker && marker.status === 'refused') {
  actions.push({
    kind, requestKey, state: 'refused',
    ...(typeof marker.reason === 'string' ? { reason: marker.reason } : {}),
    ...(typeof marker.at === 'string' ? { at: marker.at } : {}),
  })
}
```

Rendering distinguishes "will retry" from "needs your action" in both
surfaces:

- **`hyp status --json`** (`src/core/commands/status.js`): the
  `client_actions[]` mapping already forwards `state` verbatim, so
  `"state": "refused"` falls out with no extra code; `reason`/`at` ride the
  existing optional-field spreads.
- **`hyp status` prose**: the existing `if (a.state === 'done') {...} else
  if (a.state === 'failed') {...}` in the client-actions render loop gains an
  `else if (a.state === 'refused')` branch. Reuses the `failed` branch's
  `reason` rendering, and appends a fixed repair hint naming the re-arm path
  this document settles: `... [refused]  (<reason>)  run 'hyp attach
  <requestKey>' after fixing the cause`. This is the "attention-needed"
  signal: a distinct bracketed state plus a concrete next step, not a
  generic retry line repeated forever.

`overall` is unaffected by construction: `collectHypAwareStatus`'s
degradation computation (`src/core/daemon/status.js`, the `degradingKinds`
set) never reads `clientActions` at all today ("a failed client-action ...
is not even a diagnostic, so it cannot reach this computation"). A `refused`
entry stays exactly as informational as a `failed` one: loud, its own status
line, never `degraded` (LLP 0041 §failure-is-surfaced-not-fatal, unchanged
and still applicable, a refusal is a kind of failure this design gives a
name to, not an exception to that rule).

## Re-arm: explicit `hyp attach` re-run only

A `refused` marker short-circuits unconditionally (above), so once one is
written the reconciler will never re-`perform()` that request key on its own
even after the user fixes the underlying precondition. Something has to
clear it. The maintainer's instruction is explicit: **only** the manual `hyp
attach <client>` re-run, in this pass.

`hyp attach` (`runClientLifecycle('attach', ...)` in
`src/core/commands/clients.js`) already calls the adapter's `attach()` hook
directly, on-disk, entirely independent of the reconciler's marker store
(unlike `hyp detach`, which already calls `clearClientActionMarker` on a
successful reversal, at the call site around line 1164 today). Add the
symmetric call on a successful manual attach: after
`registration.attach(...)` (or the equivalent adapter call the command
path uses) resolves without throwing, and the run was not a `--dry-run`,
read the marker at that request key and, **only if it is `refused`**, re-arm
it (`rearmRefusedActionMarker({ stateRoot, kind: 'attach', requestKey: name })`,
beside `clearClientActionMarker` in `action_reconciler.js`).

For a marker that records no `installed_assets`, the re-arm is deliberately a
**clear**, not a rewrite to `done`: it does not need
to reconstruct the `endpoint`/`assets_key`/`installed_assets` detail the
reconciler's own `perform()` computes, because dropping the marker entirely
is enough. With no marker at that request key, the next reconcile pass's
forward-gap loop treats it as a fresh target (the `existing` lookup in
`action_reconciler.js` returns `undefined`) and re-`perform()`s, writing a
correct `done` marker itself. The manual attach's own disk write and the
reconciler's next re-`perform()` briefly do the same work twice, which is
free: every attach adapter is already required to be idempotent over its own
previous output (LLP 0086#re-attach-on-drift's constraint on OpenClaw's
`conflictingProviderKeys`, and the general re-attach-on-drift design), so a
redundant re-write is a no-op write, not a second effect.

Only `refused` needs this treatment, and only `refused` may get it. A
`failed` marker is not blocked by anything today (only `done` and, as of this
document, `refused` short-circuit the forward gap), so a manual attach that
fixes a merely-`failed` case is already picked up by the very next reconcile
pass without any new code. A `done` marker must **not** be cleared here: it
is the only record naming the files an org-driven attach installed, and `hyp
detach` reads exactly that marker to know what to remove, so dropping it over
a manual re-attach would strand those files with nothing naming them
(LLP 0138#marker-undo, the same invariant the reconciler's own carry-forward
branches protect). The clear is therefore gated on the marker's prior status
being `refused`, not applied blindly.

And a `refused` marker that itself carries `installed_assets` is re-armed
without being dropped. The field means the same thing on a `refused` marker as
on a `done` one: an *earlier* successful attach at this request key copied
those files, and the refusal on a later re-`perform()` carried the record
forward rather than un-installing them (that carry-forward is
[#writing-it](#writing-it)'s own branch). Clearing such a marker would strand
exactly the files that branch exists to keep named. So the re-arm rewrites it
to **`failed`** with `installed_assets` intact instead: `failed` is
short-circuited by nothing, so it re-arms the forward gap exactly as a cleared
marker does, the reverse gap and `hyp detach` keep reading the same undo
record, and the next successful `perform()` unions the carried assets onto the
fresh `done` marker. No new marker state is introduced for this: "re-armed" is
adequately described by the state the reconciler already retries.

For the same reason the re-arm is skipped entirely under `hyp attach
--dry-run`: a dry run reports what an attach would do and writes nothing, and
the marker store is state like any other. `hyp detach --dry-run` already
returns before its own `clearClientActionMarker` call; the attach side matches
it.

### Follow-up candidate, not built here

The `isCurrent`-style input-hash re-arm the maintainer named
([LLP 0086](./0086-attach-tracks-ephemeral-port.decision.md)'s freshness
hook is the existing precedent: a `done` marker whose recorded `endpoint`
or `assets_key` no longer matches live state is treated as stale and
re-`perform()`ed automatically) would let a `refused` marker re-arm itself
the moment the precondition it refused on changes on disk, e.g. the reason
OpenClaw's ownership conflict refused clears (the user edits
`openclaw.json`) or the reason Claude's JSONC refusal fired clears (the user
converts the file back to plain JSON), with no manual `hyp attach` needed.
It is explicitly **not built in this pass**, per the maintainer's
instruction, and would need its own per-handler contract (what "the refused
input" is, per handler) that this document deliberately does not design. A
future LLP extending this one is the place for it, if it is wanted; this
document only names it so the option is not lost.

## Which handlers migrate, summarized

| Handler / call site | Outcome today | This design |
| --- | --- | --- |
| OpenClaw attach, ownership-conflict refusal (`errorKind: 'refused'`) | `failed` | **`refused`** |
| OpenClaw attach, `settings_path` / `endpoint` / `read` / `write` | `failed` | unchanged, `failed` |
| Claude attach, JSONC settings file (`code: 'JSONC'`) | `failed` | **`refused`** |
| Claude attach, all other `ClaudeSettingsError` codes | `failed` | unchanged, `failed` |
| Codex attach | `failed` (no refusal site exists) | unchanged |
| Backfill handler, all failure modes | `failed` | unchanged, `failed` |

## Explicitly out of scope

- **`attempts`-bounding on transient `failed` markers.** LLP 0184's own Open
  Questions left this unsettled ("Should `attempts` on transient `failed`
  markers be bounded at all, or is retry-per-boot acceptable once refusals
  are carved out?"). This design carves out refusals; it does not answer the
  bounding question. Retry-per-boot for a genuinely transient `failed`
  marker stays exactly as unbounded as it is on `master` today. A future
  request should settle this explicitly rather than have it fall out of this
  change set by accident.
- **The `isCurrent`-style automatic re-arm** for `refused` markers (above):
  named as a follow-up candidate, not designed or built here.
- **A terminal `refused` outcome from `reverse()`.** `ActionOutcome` is one
  type across `perform()` and `reverse()`, so widening it makes `refused`
  *expressible* on the reverse hook, but nothing produces it (no in-tree
  handler's `reverse()` returns it) and this document does not settle what it
  would mean. The reverse gap therefore has no branch for it: it falls into the
  existing failure arm, logs `action_reverse_failed`, and keeps the marker for
  the next pass. That is the safe half of the pair on purpose. The alternative
  (drop the marker) would destroy the only record naming settings and files
  that are still on disk, the orphaning both #212 and LLP 0138#marker-undo
  refuse to accept, and a wrong terminal decision about an undo is much more
  expensive than a retried one. A `reverse()` that genuinely needs to refuse
  (a settings file that turned into JSONC *after* attach is the obvious
  candidate) needs its own branch, and its own answer to "what happens to the
  marker", in a request that extends this one.
- **Any change to `hypaware-plugin-kernel-types.d.ts`'s `attach(): Promise<void>`
  contract.** Considered and rejected above in favor of the additive
  `markActionRefused`/`isActionRefused` convention.
- **Any change to what LLP 0041 itself says.** This document extends it; the
  only edit to LLP 0041 is a mechanical forward-reference appended to its
  existing `Extended-by:` line.

## Test strategy

Mirrors LLP 0041's own test strategy, extended for the new state:

- **Unconditional short-circuit.** A fake handler whose `perform()` returns
  `{ status: 'refused', reason }` once, then would return `done` on a second
  call: assert a second `reconcile()` pass still reports `skipped` (not a
  second `perform()` call), unlike a `done` marker whose handler declares
  `isCurrent() => false`.
- **Marker shape.** Assert a `refused` outcome writes `status: 'refused'`,
  `reason`, `at`, no `attempts`, and preserves any carried
  `installed_assets`.
- **`markActionRefused` / `isActionRefused` round-trip.** A thrown, marked
  Error is recognized; a plain `Error` and a non-Error throw are not.
- **OpenClaw migration.** The ownership-conflict refusal
  (`conflictingProviderKeys` non-empty) surfaces as `ActionOutcome.status:
  'refused'` through `action_attach.js`'s `perform()`; the four other
  `errorKind` values still surface as `'failed'`.
- **Claude migration.** The JSONC throw site surfaces as `'refused'`; the
  other `ClaudeSettingsError` codes still surface as `'failed'`.
- **Status surface.** `buildClientActionsReport()` renders a `refused` marker
  as `state: 'refused'` with `reason`/`at`, distinct from `failed`; a mixed
  store (one `done`, one `failed`, one `refused` request key) renders all
  three correctly. `overall` stays `healthy` with a `refused` entry present
  (same fixture pattern LLP 0041's failure-surfacing test already uses for
  `failed`).
- **Re-arm.** An assetless `refused` marker, followed by a successful manual
  `hyp attach <client>`, clears the marker (`readClientActionStatus` shows no
  entry at that request key); the next `reconcile()` pass re-`perform()`s and
  writes a fresh `done` marker. A `hyp attach` that itself fails leaves the
  `refused` marker in place (nothing is cleared on a failed manual attach), a
  `done` marker carrying `installed_assets` survives a successful manual
  attach untouched (the undo record is not collateral of the re-arm), and
  `hyp attach --dry-run` clears nothing at all.
- **Re-arm keeps the undo record.** A `refused` marker that carries
  `installed_assets`, followed by a successful manual `hyp attach <client>`,
  is rewritten to `failed` with those paths intact rather than dropped; the
  next `reconcile()` pass still re-`perform()`s it (proving the re-arm), and
  the fresh `done` marker it writes carries the same paths forward.
- **Reverse-gap interaction.** A `refused` marker with no `installed_assets`
  for a request key the config stops naming is dropped, like an assetless
  `failed` one; a `refused` marker that carries `installed_assets` is routed
  to `reverse()` instead.

## References

- [LLP 0184](./0184-reconciler-retries-permanent-failures.issue.md): the
  request this document designs a fix for
- [LLP 0041](./0041-central-config-client-actions.design.md): marker states
  and the reconciler design this document extends (its `Extended-by:` line
  now names this document; its own text is unedited)
- [LLP 0036](./0036-central-config-driven-client-actions.decision.md): the
  action seam decision LLP 0041 designs (unaffected)
- [LLP 0086](./0086-attach-tracks-ephemeral-port.decision.md): the
  `isCurrent` freshness-hook precedent this document names as a follow-up
  candidate for `refused` re-arm, not built here
- [LLP 0109](./0109-openclaw-client-adapter.decision.md): the OpenClaw
  adapter whose refusal loop LLP 0184 observed in the field
- [LLP 0163](./0163-attach-backs-up-a-malformed-block.decision.md): Claude's
  JSONC refusal, the second migrated call site
- `src/core/config/action_reconciler.js`: the reconcile pass this document
  changes (unconditional `refused` short-circuit, third outcome branch)
- `src/core/config/action_attach.js`: `perform()`'s catch, widened to read
  `isActionRefused`
- `src/core/config/types.d.ts`: `ActionMarkerStatus`, `ActionMarker`,
  `ActionOutcome`, `ReconcileActionResult` (widened); new
  `ActionRefusalError` interface
- `hypaware-core/plugins-workspace/openclaw/src/attach.js`,
  `hypaware-core/plugins-workspace/openclaw/src/index.js`: the first
  migrated adapter
- `hypaware-core/plugins-workspace/claude/src/settings.js`: the second
  migrated call site
- `src/core/daemon/status.js`, `src/core/daemon/types.d.ts`,
  `src/core/commands/status.js`: the `hyp status` attention-needed surface
- `src/core/commands/clients.js`: `hyp attach`'s success path, where the
  explicit re-arm clear is added
