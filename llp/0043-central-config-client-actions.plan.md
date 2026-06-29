# LLP 0043: Central-config-driven client actions — plan

**Type:** plan
**Status:** Active
**Related:** LLP 0041
**Generated-by:** neutral
**Systems:** Config, Daemon, Onboarding, Sources

> [LLP 0041](./0041-central-config-client-actions.design.md) is the implementation
> design for the daemon-side **action reconciler** (LLP 0036) and its first
> instance, **backfill on join** (LLP 0037). It already named the files and
> functions to add or change and grouped them into six independently-mergeable
> seams. This plan turns those seams into a task graph with real code
> dependencies, so the first wave can parallelize and each task merges on its own
> without leaving the tree broken.

## How this refines the design

The design's "Module / seam breakdown" lists six modules. This plan keeps that
exact decomposition — it is already minimal and each seam is independently
testable — and only makes the dependency edges explicit so neutral can schedule
them.

The shape of the graph:

- **Foundational / independent (deps `[]`).** Three tasks have no in-repo
  dependency on each other and form the first wave:
  - **T1 — reconciler core + marker store.** The new
    `src/core/config/action_reconciler.js` (`createActionReconciler`, the
    `ActionHandler` interface, level-triggered `reconcile()`), the atomic
    marker read/write into `config-control/client-actions.json`,
    `readClientActionStatus({ stateRoot })`, and the new types
    (`ClientActionStatus`, `ActionMarker`, `ActionHandler`) in
    `src/core/config/types.d.ts`. Unit-testable with an injected fake handler
    and clock — no daemon, no HTTP, no real spawn. This is the contract every
    other action task binds to, so it is the spine of the graph.
  - **T2 — confirmation-edge hook.** Add `onConfirmed` to
    `CreateConfigControlOptions` (`src/core/config/types.d.ts`) and invoke it
    from `confirmPoll()` in `src/core/config/apply.js` *only on the probation
    active→cleared transition*. Self-contained edit to the apply engine; existing
    apply tests are unaffected because no caller wires the hook yet. Independent
    of T1 — it touches a different surface and ships a no-op edge event until the
    daemon (T4) consumes it.
  - **T5 — per-plugin `backfill` config validation.** Extend `@hypaware/claude`
    and `@hypaware/codex` to accept `{ on_join, window_days }` inside their own
    plugin `config` block — a `config_sections` manifest entry plus the section
    validator the kernel `ConfigRegistry` drives via
    `runPerPluginSectionValidators` (LLP 0005). Plugin-local; no core schema
    change; no dependency on the reconciler. It only needs to land before the
    end-to-end smoke proves an opt-out, not before the handler compiles.

- **Handler (deps `[T1]`).** **T3 — backfill action handler.** `backfillHandler`
  (`desired()` over `selectProviders` + per-plugin `config.backfill`; `perform()`
  resolving `window_days`→`--since` and spawning `hyp backfill <plugin> --json`
  via the `runSmoke` spawn pattern). It implements the `ActionHandler` interface
  defined in T1, so it depends on T1 and nothing else (the spawn is injected for
  tests; it does not need the daemon or the plugin schema to compile).

- **Status (deps `[T1]`).** **T6 — status surface.** Add a `clientActions`
  section to `HypAwareStatusReport` in `src/core/daemon/status.js`, read via
  `readClientActionStatus`, rendered per-provider (`done` / `failed` / `pending`
  / `n/a`) and explicitly excluded from `overall === 'degraded'`; types in
  `src/core/daemon/types.d.ts`. It consumes the marker store / status reader from
  T1 and is otherwise independent of the handler and the daemon wiring (it reads
  the marker file, it never runs a pass).

- **Integration (deps `[T1, T2, T3]`).** **T4 — daemon wiring.** In
  `src/core/daemon/runtime.js`: construct the reconciler with `[backfillHandler]`,
  wire `configControl`'s `onConfirmed` to schedule a pass, run the
  after-activation already-confirmed pass, and add the single-flight guard +
  off-tick async task; pass `boot.runtime.backfills` and `boot.config` into
  `reconcile()`. This is the only task that needs all three of the reconciler
  core (T1), the confirmation edge (T2), and the handler it runs (T3). It does
  **not** depend on T5 (validation) or T6 (status) — an unvalidated `backfill`
  block or a missing status line does not stop the daemon from running a pass,
  and the end-to-end smoke that exercises the full join→backfill flow rides on
  T4 with T5 already merged in the first wave.

This yields a 3-wide first wave (T1, T2, T5), a 2-wide second wave (T3, T6 once
T1 lands), and the single integration task (T4) last. Each task leaves the tree
green: a merged-but-unwired reconciler (T1), a fired-but-unconsumed edge (T2), a
defined-but-uninstantiated handler (T3), accepted-but-unused config keys (T5),
and a status section that reads `pending`/`n/a` until a pass runs (T6) are all
inert until T4 connects them.

## Test ownership per task

- **T1:** run-once idempotency (drive `reconcile()` twice against a counting fake
  handler; second pass is a `done` short-circuit; a missed pass runs next call);
  atomic marker read/write round-trip.
- **T2:** `onConfirmed` fires exactly on the active→cleared transition, not on a
  no-probation poll (stubbed state).
- **T3:** `desired()` opt-out (`on_join:false` → no action), `window_days`→
  `--since` resolution and the retention fallback (assert spawned argv), and a
  `failed` `perform` writing a `failed` marker that retries with bumped
  `attempts` (spawn injected).
- **T4:** the daemon schedules exactly one pass per edge; the pass runs off the
  tick loop (a long fake `perform` does not delay `runTick`); the boot
  already-confirmed pass fires when no probation marker is active.
- **T5:** the claude/codex section validator accepts `{ on_join, window_days }`
  and rejects malformed values; the central-locked `on_join` cannot be flipped by
  a colliding local entry (reuse the LLP 0031 merge-drop harness).
- **T6:** mixed `done`/`failed`/`pending`/`n/a` reads cleanly and a `failed`
  backfill does not flip `overall` to `degraded`.
- **End-to-end (hermetic smoke, lands with T4):** a seeded join that confirms a
  config with `@hypaware/claude` enabled runs `hyp backfill claude` once, lands
  rows, writes the `done` marker, and does not re-run on a second confirmed poll.

## Tasks
- id: T1  branch: task/central-config-client-actions/T1  deps: []            -- Reconciler core + marker store: createActionReconciler, ActionHandler interface, level-triggered reconcile(), atomic config-control/client-actions.json read/write, readClientActionStatus, and types in src/core/config/types.d.ts. Unit-testable with an injected handler + clock.
- id: T2  branch: task/central-config-client-actions/T2  deps: []            -- Confirmation-edge hook: add onConfirmed to CreateConfigControlOptions and invoke it from confirmPoll() in src/core/config/apply.js only on the probation active->cleared transition.
- id: T5  branch: task/central-config-client-actions/T5  deps: []            -- Per-plugin backfill config validation: extend @hypaware/claude and @hypaware/codex config_sections (manifest + ConfigRegistry section validator) to accept { on_join, window_days }. Plugin-local; no core schema change.
- id: T3  branch: task/central-config-client-actions/T3  deps: [T1]          -- Backfill action handler: backfillHandler.desired() over selectProviders + per-plugin config.backfill, and perform() resolving window_days->--since and spawning hyp backfill <plugin> --json via the runSmoke spawn pattern. Implements the T1 ActionHandler interface; spawn injected for tests.
- id: T6  branch: task/central-config-client-actions/T6  deps: [T1]          -- Status surface: add a clientActions section to HypAwareStatusReport in src/core/daemon/status.js (read via readClientActionStatus), per-provider done/failed/pending/n-a, wired into text+JSON renderers and excluded from overall=degraded; types in src/core/daemon/types.d.ts.
- id: T4  branch: task/central-config-client-actions/T4  deps: [T1, T2, T3]  -- Daemon wiring in src/core/daemon/runtime.js: construct the reconciler with [backfillHandler], wire onConfirmed to schedule a pass, run the after-activation already-confirmed pass, add the single-flight guard + off-tick async task, and pass boot.runtime.backfills + boot.config into reconcile().

## References

- [LLP 0041](./0041-central-config-client-actions.design.md) — the implementation design this plan schedules
- [LLP 0036](./0036-central-config-driven-client-actions.decision.md) — the action seam
- [LLP 0037](./0037-backfill-on-join.decision.md) — backfill on join (the first instance)
- [`src/core/config/apply.js`](../src/core/config/apply.js), [`src/core/daemon/runtime.js`](../src/core/daemon/runtime.js), [`src/core/daemon/status.js`](../src/core/daemon/status.js), [`src/core/commands/backfill.js`](../src/core/commands/backfill.js), [`src/core/registry/backfills.js`](../src/core/registry/backfills.js) — the code these tasks build on
