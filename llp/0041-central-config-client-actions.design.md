# LLP 0041: Central-config-driven client actions — implementation design

**Type:** design
**Status:** Active
**Systems:** Config, Daemon, Onboarding, Sources
**Generated-by:** neutral
**Related:** LLP 0036, LLP 0037
**Extended-by:** LLP 0044 (attach decision), LLP 0045 (attach implementation design — the reversible-instance counterpart to this doc)

> [LLP 0036](./0036-central-config-driven-client-actions.decision.md) accepted a
> single seam — a daemon-side, idempotent **action reconciler** that performs a
> machine-side effect *because the central config asked*, records it, surfaces
> (never escalates) failure, isolates heavy work, gates on consent, and undoes
> reversible effects on leave. [LLP 0037](./0037-backfill-on-join.decision.md)
> accepted its first instance — **backfill on join** (run-once `hyp backfill`
> when a joined machine confirms a central config with a backfill-capable source
> enabled). Both decisions hold the *rationale*; neither has code. This document
> is the *implementation* design: where the reconciler lives, when it fires in
> the existing daemon lifecycle, the marker shape and location, the subprocess
> launch, the status surface, and the independently-mergeable task seams.

The decisions are the authority for *why*; this design is constrained by them
and must not relitigate them. Where it makes a fresh choice (e.g. the
confirmation hook mechanism, the marker filename), that choice is called out.

Coverage anchors (these resolve the two uncovered decisions):

`@ref LLP 0036 — central-config-driven client action seam`
`@ref LLP 0037 — backfill-on-join instance`

## What the code already gives us

The seam plugs into machinery that already exists; nothing here invents a new
config section or a new lifecycle phase.

- **The confirmation edge.** `confirmPoll()` in
  [`src/core/config/apply.js`](../src/core/config/apply.js) clears the post-apply
  probation marker on the first successful authenticated poll. It is called by
  the central plugin's pull loop on a 200 or 304
  ([`hypaware-core/plugins-workspace/central/src/config_client.js`](../hypaware-core/plugins-workspace/central/src/config_client.js),
  the `pull()` 304 and 200 branches). This is exactly the "config confirmed,
  probation cleared" trigger point LLP 0036 §When-the-reconciler-runs and
  [LLP 0025 §Post-apply probation](./0025-remote-config-join-flow.spec.md#post-apply-probation)
  name — and the plugin reports it through the narrow facade, never touching
  probation state itself.
- **Kernel-managed state.** Apply bookkeeping lives in one atomically-written
  file, `config-control/state.json` (`CONTROL_DIRNAME`/`STATE_BASENAME` in
  `apply.js`), under `<stateRoot>` = `<HYP_HOME>/hypaware`. The action marker
  belongs here too ([LLP 0004 state directories](./0004-activation-and-paths.spec.md#state-directories)),
  *not* in a plugin state dir — the reconciler is kernel surface.
- **The daemon is the only host with `configControl`.** `runDaemon` in
  [`src/core/daemon/runtime.js`](../src/core/daemon/runtime.js) constructs the
  engine and threads it into `bootKernel`; plain CLI boots leave
  `ctx.configControl` undefined (`ConfigControlFacade` in
  [`hypaware-plugin-kernel-types.d.ts`](../hypaware-plugin-kernel-types.d.ts)).
  So a reconciler attached to the daemon is daemon-only by construction —
  `hyp status` performs no machine effects.
- **Backfill providers are already enumerable and config-filtered.**
  `ctx.backfills.list()` (`createBackfillRegistry` in
  [`src/core/registry/backfills.js`](../src/core/registry/backfills.js)) yields
  `{ name, plugin, datasets, run }` for every registered provider; the claude
  adapter registers one at activation
  ([`hypaware-core/plugins-workspace/claude/src/index.js`](../hypaware-core/plugins-workspace/claude/src/index.js),
  `ctx.backfills.register(...)`), codex likewise. `selectProviders` in
  [`src/core/commands/backfill.js`](../src/core/commands/backfill.js) already
  computes "providers whose owning plugin is enabled in the active config" — the
  reconciler reuses that exact predicate.
- **A subprocess precedent exists.** `runSmoke` in
  [`src/core/cli/core_commands.js`](../src/core/cli/core_commands.js) spawns
  `process.execPath bin/hypaware.js …` resolved relative to `import.meta.url`.
  The reconciler launches `hyp backfill` the same way.
- **A status-section precedent exists.** `collectHypAwareStatus` in
  [`src/core/daemon/status.js`](../src/core/daemon/status.js) already reads
  apply state via `readConfigControlStatus({ stateRoot })` into a `remoteConfig`
  section without constructing the engine. `clientActions` mirrors it.

## Part 1 — The action seam (LLP 0036)

### Where actions are declared (schema)

No generic `actions[]` schema — confirmed per-instance in
[LLP 0036 §Where actions are declared](./0036-central-config-driven-client-actions.decision.md#where-actions-are-declared)
and [§Open questions](./0036-central-config-driven-client-actions.decision.md#open-questions).
Each instance rides config surface LLP 0031 already governs:

- **Backfill** rides each source plugin's own `config.backfill`
  (`plugins[]` entry) — see Part 2.
- **Attach** (future) rides the client entries the config already names (#126).

Because both live inside `plugins[]`, the central-vs-local locking
([LLP 0031 §Merge model](./0031-layered-config.decision.md#merge-model)) falls
out with **no new merge rule**: a central-named plugin entry — and the
`backfill`/attach policy inside it — is authoritative; a colliding local entry
is dropped at the boot merge. The seam is the *reconciler*, not a config
section. On a non-joined host there is no central layer, so the reconciler is a
no-op and these stay manual local commands.

### The reconciler component

Add a new kernel module
**`src/core/config/action_reconciler.js`** exporting
`createActionReconciler(opts)`. It is constructed by the daemon (like
`createConfigControl`) and is the generic run-once / reconcile-on-config
machinery. It knows nothing about Claude vs Codex.

```js
createActionReconciler({
  stateRoot,                 // marker location (config-control/)
  now,                       // injectable clock (test seam)
  handlers,                  // ordered list of ActionHandler (v1: [backfillHandler])
  log,
})
// → { reconcile({ config, backfills }): Promise<ReconcileReport>,
//     readStatus(): ClientActionStatus }
```

An **`ActionHandler`** is the registration of detect / perform / (optional)
reverse that LLP 0036 §Options-3 names. v1 ships one:

```ts
interface ActionHandler {
  kind: 'backfill'                      // marker namespace + status section key
  // Enumerate the (requestKey, params) units this handler wants reconciled,
  // given the effective config + kernel registries. Pure — no effects.
  desired(ctx): DesiredAction[]         // [{ requestKey, params }]
  // Run-once: has this requestKey already completed?  (marker lookup)
  // Reconciled/reversible handlers (attach, future) also implement reverse().
  perform(action, ctx): Promise<ActionOutcome>   // the effect; subprocess or in-proc
  reverse?(requestKey, ctx): Promise<ActionOutcome>
}
```

`reconcile()` is **level-triggered**: for each handler it diffs `desired()`
against the persisted marker and acts only on the gap (LLP 0036 — a missed run
is recovered on the next pass). It is safe to call repeatedly; a `done` marker
short-circuits.

### When the reconciler runs (lifecycle integration)

Two fire points in `runDaemon`, both **after a config is confirmed, never
mid-apply** (LLP 0036):

1. **After activation, once, if already confirmed.** Right after the daemon
   attaches apply deps and arms the watchdog
   (`configControl.attachApplyDeps(...)` / `armProbationWatchdog()` in
   `runtime.js`), if the central layer exists and **no probation marker is
   active** (the running config already cleared probation on a prior boot), run
   one reconcile pass. This is the "at boot / after activation" trigger and
   recovers any pass missed while a previous probation was outstanding.
2. **On the confirmation edge.** When `confirmPoll()` *transitions* probation
   from active→cleared, fire a reconcile pass. This covers the fresh-join case:
   join → apply → restart → probation → first 200/304 clears it → reconcile.

Mechanism for (2): add an **`onConfirmed` callback** to
`CreateConfigControlOptions` (in
[`src/core/config/types.d.ts`](../src/core/config/types.d.ts)), invoked from
`confirmPoll()` *only when a marker was actually cleared* (the edge, not every
poll). The daemon wires `onConfirmed` to schedule a reconcile pass. This keeps
`apply.js` ignorant of the reconciler (it just emits an edge event), and keeps
the plugin ignorant of both (it still only calls `confirmPoll()`). Chosen over
having the daemon poll `configControl.status()` on every tick: the edge is
precise and avoids a spawn-check every 300 s.

A small **concurrency guard** in the daemon ensures only one reconcile pass runs
at a time (a confirm edge during an in-flight pass sets a "re-run when done"
flag) and that a pass never runs inside `runTick` — it is its own async task off
the tick loop.

### Idempotency and completion state

Marker file: **`config-control/client-actions.json`** (mode 0600), atomically
written via tmp+rename exactly like `state.json`. Shape, namespaced per handler
kind and keyed by request key:

```jsonc
{
  "backfill": {
    "@hypaware/claude": {
      "status": "done",          // run-once terminal state
      "at": "2026-06-25T…Z",
      "rows": 1234,
      "request_key": "@hypaware/claude"
    },
    "@hypaware/codex": {
      "status": "failed",        // not terminal — retried next pass
      "reason": "transcript dir missing",
      "last_attempt": "2026-06-25T…Z",
      "attempts": 2
    }
  }
}
```

Two flavours, both off one file (LLP 0036 §Idempotency):

- **Run-once** (backfill): a `done` entry means *skip forever* — the action is
  never auto-run again even though `hyp backfill` is independently idempotent
  (`part_id` dedupe). The marker is what makes every subsequent boot *cheap*
  (no history re-scan).
- **Reconciled / reversible** (attach, future): the entry records the *current
  applied state*; `reverse()` runs on leave/detach when the config no longer
  names the effect. The file shape already accommodates this (a second
  top-level namespace, e.g. `"attach": {...}`).

**Request key** (LLP 0036 §request-key open question): v1 backfill keys on the
owning **plugin name** — a per-(machine, provider) boolean. The marker file is
this machine's, so "machine" is implicit. A widened `window_days` does **not**
re-trigger in v1 (strict run-once; manual `hyp backfill` is the re-run path).
The key is structured (an object, not a bare bool) so a later refinement can add
a high-water input without a format break — see [Open questions](#open-questions).

### Failure is surfaced, not fatal

A failed action (`hyp backfill` non-zero, transcript dir missing, file not
writable) **does not** roll back the central config and **does not** flip
`overall` to `degraded` in `collectHypAwareStatus` (the gateway is functioning
on a valid config). The marker is **not advanced to `done` on failure** — a
`failed` entry is written (reason + attempt count) and the next reconcile pass
retries it. This mirrors `apply.js`'s structured-but-non-degrading rollback
surface and LLP 0031's dropped-local-entry treatment: loud (its own status line
+ a structured `client_action.*` log) but not an outage signal.

### Execution isolation

The handler declares whether its effect is heavy. Backfill is **subprocess**
(unbounded import; the "encoder/large import can't run inline" hazard — see the
parquet-in-daemon memory note); a future attach edit is **in-process** (bounded
file write). `perform()` for the subprocess handler spawns asynchronously and
the reconcile task awaits the child **off the tick loop**, so a multi-minute
import can never wedge `runTick` or grow daemon heap.

### Consent gating

Per LLP 0036 §Consent, gating is per-instance, not one global gate:

- **Backfill — default-on, no per-machine local opt-out.** The reconciler runs
  it whenever an enabled backfill provider's plugin entry has
  `backfill.on_join` truthy (default true). Suppression is an operator
  *scoping* decision (`backfill.on_join: false` in the locked central plugin
  entry), not a local override — it rides `plugins[]` locking.
- **Attach — open.** Whether `join` implies consent to user-file edits, or
  requires explicit acknowledgement, is deferred to the attach instance
  (carried forward in [Open questions](#open-questions)). The handler interface
  has a `consent` hook slot so the attach handler can demand acknowledgement
  without changing the reconciler.

### Undo on leave (reversible handlers)

For reversible handlers, `reverse(requestKey)` runs when `desired()` no longer
names a request key that the marker records as applied — i.e. the central config
stopped naming the effect, or the machine left the fleet (`hyp leave`/detach,
when that lands). Backfill is **not** reversible (imported data stays), so its
handler omits `reverse()` and the reconciler never un-imports. This path is
designed-for but exercised first by the attach follow-up, not v1.

## Part 2 — Backfill-on-join instance (LLP 0037)

### Per-plugin capability + config

"Backfill-capable" is **not a new manifest flag** — a plugin is backfill-capable
iff it registered a `BackfillContribution` (its presence in
`ctx.backfills.list()`). The reconciler's backfill handler enumerates those and
intersects with enabled plugins via the existing `selectProviders` predicate.

Policy lives in the **owning plugin's own `config` block** (LLP 0037):

```jsonc
{ "name": "@hypaware/claude", "config": {
    "proxy": "@hypaware/ai-gateway",
    "backfill": { "on_join": true, "window_days": 30 }
} }
```

`backfill.on_join` (default **true**) and `backfill.window_days` are validated by
the **owning plugin's config-section validator** (LLP 0005), the same
`config_sections` / `ConfigRegistry` path `runPerPluginSectionValidators` drives
in [`src/core/config/validate.js`](../src/core/config/validate.js). Task: extend
the claude and codex plugins' config-section schema to accept the `backfill`
sub-object. Core validates nothing new — there is no top-level `backfill`
section.

### Run-once flow (backfill handler)

`backfillHandler.desired({ config, backfills })`:

1. `selectProviders({ requested: [], available: backfills.list(), activePlugins:
   config.plugins })` → enabled providers.
2. For each, read the owning plugin entry's `config.backfill`. Skip when
   `on_join === false`. Default `on_join` true when absent.
3. Emit `{ requestKey: provider.plugin, params: { plugin, windowDays } }`.

`backfillHandler.perform(action)`:

1. Resolve `--since`: if `windowDays` set, `--since (now − windowDays·days)`;
   if absent, **omit `--since`** — `hyp backfill` already falls back to
   `query.cache.retention.default_days` via `resolveRetentionDays`
   ([LLP 0013](./0013-local-query-cache.decision.md)), so the effective span is
   naturally bounded by retention. (Equivalent to LLP 0037's "fall back to
   retention default_days".)
2. Spawn `process.execPath bin/hypaware.js backfill <plugin> [--since <ISO>]
   --json` (the `runSmoke` spawn pattern), inheriting the daemon's `env`
   (notably `HYP_HOME`) so the child writes the same cache.
3. On exit 0: parse the `--json` payload (`providers[].rows_written`) → write a
   `done` marker with row count. On non-zero / spawn error: write a `failed`
   marker (reason + bump `attempts`); the next pass retries.

### How imported rows reach the server

Backfill **never talks to the server** (LLP 0037 §Context). `hyp backfill`
lands rows in the local cache tables (`writeRows`/`flushDataset` in
`backfill.js`); the **central forward sink** already drains the cache to the
server on its tick. So a subprocess import reaches the server on its own — no
new wiring. (The forward sink re-reads the whole table, #122 — tracked
separately, does not block this.)

### Why subprocess, why post-probation

Both are LLP 0037 restatements, realized here: post-probation because the run
fires only on the `confirmPoll` edge / the boot already-confirmed check (never
against a config that might roll back); subprocess because a months-deep import
is unbounded work that must not wedge the tick loop.

## Module / seam breakdown (independently-mergeable tasks)

Ordered so each lands behind the previous but merges on its own. Each names the
files/functions to add or change.

1. **Reconciler core + marker store** — new
   `src/core/config/action_reconciler.js` (`createActionReconciler`, the
   `ActionHandler` interface, level-triggered `reconcile()`), marker read/write
   helpers (atomic tmp+rename into `config-control/client-actions.json`), and
   `readClientActionStatus({ stateRoot })`. Types in
   `src/core/config/types.d.ts` (`ClientActionStatus`, `ActionMarker`,
   `ActionHandler`). **Unit-testable with an injected handler + clock; no
   daemon, no HTTP, no real spawn.**
2. **Confirmation edge hook** — add `onConfirmed` to `CreateConfigControlOptions`
   and invoke it from `confirmPoll()` in `src/core/config/apply.js` *only on the
   active→cleared transition*. Tiny, isolated; existing apply tests unaffected.
3. **Backfill action handler** — `backfillHandler` (in the reconciler module or
   `src/core/config/action_backfill.js`): `desired()` over
   `selectProviders` + per-plugin `config.backfill`; `perform()` resolves
   `window_days`→`--since` and spawns `hyp backfill <plugin> --json`. Spawn
   helper mirrors `runSmoke` (resolve `bin/hypaware.js` off `import.meta.url`).
   **Testable with the spawn injected (assert argv + marker writes).**
4. **Daemon wiring** — in `src/core/daemon/runtime.js`: construct the reconciler
   with `[backfillHandler]`, wire `configControl`'s `onConfirmed` to schedule a
   pass, run the after-activation already-confirmed pass, and add the
   single-flight guard + off-tick async task. Pass `boot.runtime.backfills` and
   `boot.config` (effective) into `reconcile()`.
5. **Per-plugin `backfill` config validation** — extend `@hypaware/claude` and
   `@hypaware/codex` config-section schemas/validators (manifest +
   `ConfigRegistry` registration) to accept `{ on_join, window_days }`
   (LLP 0005). Plugin-local; no core schema change.
6. **Status surface** — `src/core/daemon/status.js`: add a `clientActions`
   section to `HypAwareStatusReport` (read via `readClientActionStatus`),
   per-provider `done` (with when + rows) / `failed` (reason + last attempt) /
   `pending` / `n/a` (`on_join:false` or non-joined). Wire into the text/JSON
   renderers. **Must not** add to `overall === 'degraded'`. Types in
   `src/core/daemon/types.d.ts`.

## Test strategy

- **Idempotency / run-once** (task 1, 3): drive `reconcile()` twice against a
  fake handler whose `perform` counts calls; assert `perform` runs once, the
  second pass is a no-op (`done` marker short-circuits), and a missed pass (no
  marker yet) runs on the next call.
- **Confirmation edge** (task 2, 4): with a stubbed `configControl`, assert
  `onConfirmed` fires exactly on the probation active→cleared transition and not
  on a no-probation poll; assert the daemon schedules exactly one pass per edge.
- **Failure surfacing** (task 3, 6): a `perform` that returns failure writes a
  `failed` marker (not `done`), the next pass retries, `attempts` increments,
  and `collectHypAwareStatus` reports `failed` without flipping `overall`.
- **window_days resolution** (task 3): `window_days: 30` → `--since` = now−30d;
  absent → no `--since` (retention fallback). Assert the spawned argv.
- **Opt-out** (task 3, 5): `backfill.on_join: false` → `desired()` emits nothing
  → no spawn, status `n/a`. A central-locked `on_join` cannot be flipped by a
  local entry (merge-drop test, reusing the LLP 0031 merge harness).
- **Execution isolation** (task 4): assert the reconcile task runs off the tick
  loop (a long fake `perform` does not delay `runTick`).
- **Leave/undo** (designed-for; exercised by the attach follow-up): a reversible
  fake handler whose `desired()` drops a previously-applied key triggers
  `reverse()` once; backfill's handler has no `reverse()` and never un-imports.
- **End-to-end (hermetic smoke)**: extend the existing fixture-backed backfill
  smokes — a seeded join that confirms a config with `@hypaware/claude` enabled
  runs `hyp backfill claude` once, lands rows in the cache, writes the `done`
  marker, and does not re-run on a second confirmed poll.

## Risks / open questions

Carried forward from the decisions; settle as noted.

- **Attach consent gate** (LLP 0036) — does `join` imply consent to
  user-file edits, or require explicit acknowledgement? Open; settle with the
  attach handler + onboarding ([LLP 0011](./0011-setup-and-onboarding.decision.md)).
  The handler `consent` slot exists so this lands without reworking the
  reconciler.
- **Auto re-trigger of run-once actions** (LLP 0036 / 0037) — v1 is strict
  run-once (boolean-ish per-(machine, provider) marker). A widened `window_days`
  needs a manual `hyp backfill`. The structured marker leaves room for a
  high-water-window key that auto-re-imports the new slice (`part_id` dedupe
  absorbs overlap); generalise only if a second run-once action wants it.
- **Subprocess resource bounds** (LLP 0037) — should the spawned backfill get a
  niceness / memory ceiling so a huge first import doesn't starve live capture?
  Likely yes; size it when task 4's plumbing lands (the `perform` spawn is the
  single place to add it).
- **Marker reset on cache recreate** (LLP 0037) — a breaking schema change
  ([LLP 0030](./0030-session-id-partition-key.decision.md)) recreates the cache
  and should re-import. Should the `done` marker reset? Probably; track with the
  schema-evolution work ([LLP 0029](./0029-additive-cache-schema-evolution.decision.md)).
- **Ordering relative to first ingest** (LLP 0036) — does attach (start live
  routing) need to order deterministically against backfill (import history) on
  a fresh join, or is the cache→forward path order-insensitive? Likely the
  latter; confirm when the attach instance is designed.
- **Partial-provider failure** (LLP 0037) — the per-provider marker isolates
  this (one provider `done`, another `failed`); the status surface (task 6) must
  read cleanly in that mixed state — covered by a status test above.

## References

- [LLP 0036](./0036-central-config-driven-client-actions.decision.md) — the action seam (the decision this designs)
- [LLP 0037](./0037-backfill-on-join.decision.md) — backfill on join (the first instance this designs)
- [LLP 0011](./0011-setup-and-onboarding.decision.md) — setup and onboarding (the interactive backfill finale this reaches parity with)
- [LLP 0017](./0017-daemon-runtime.decision.md) — daemon runtime / staged restart
- [LLP 0025](./0025-remote-config-join-flow.spec.md) — join flow, apply, probation (the confirmation trigger)
- [LLP 0031](./0031-layered-config.decision.md) — layered config / merge model (plugin-entry locking)
- [LLP 0005](./0005-plugin-manifest.spec.md) — plugin manifest / config_sections (per-plugin `backfill` validation)
- [`src/core/config/apply.js`](../src/core/config/apply.js), [`src/core/daemon/runtime.js`](../src/core/daemon/runtime.js), [`src/core/commands/backfill.js`](../src/core/commands/backfill.js), [`src/core/registry/backfills.js`](../src/core/registry/backfills.js), [`src/core/daemon/status.js`](../src/core/daemon/status.js) — the code this design builds on
