# LLP 0046: Client attach on join — implementation plan

**Type:** plan
**Status:** Active
**Systems:** Config, Daemon, Onboarding, Sources, Gateway
**Author:** neutral
**Date:** 2026-06-26
**Related:** 0044, 0045
**Generated-by:** neutral

> [LLP 0045](./0045-client-attach.design.md) is the implementation design for
> **client attach on join** — the reversible instance of the
> [LLP 0036](./0036-central-config-driven-client-actions.decision.md) action seam
> ([decision: LLP 0044](./0044-client-attach-on-join.decision.md)). It already
> names the files and functions to add or change and groups them into nine
> independently-mergeable seams. This plan turns those seams into a task graph
> with real code dependency edges, so the first wave can parallelize and each
> task merges on its own without leaving the tree broken.

## How this refines the design

The design's "Module / seam breakdown" lists nine modules. This plan keeps that
exact decomposition — it is already minimal and each seam is independently
testable — maps each task 1:1 onto the design's seam numbering for traceability,
and only makes the dependency edges explicit so neutral can schedule them. A
tenth task (T10) is the lifecycle move that marks 0045 shipped once the substance
has merged.

The shape of the graph:

- **Foundational / independent (deps `[]`).** Four tasks have no in-repo
  dependency on each other and form the first wave:
  - **T1 — `attach()` writes a self-describing undo record.** Adapter-local
    edits to the claude and codex `attach()` paths so each marker carries
    everything the single core undo (T4) needs to reverse *without the plugin
    loaded* — claude's `_hypaware` marker
    ([`hypaware-core/plugins-workspace/claude/src/settings.js`](../hypaware-core/plugins-workspace/claude/src/settings.js),
    `MARKER_KEY`; surfaced via `writeAttachOutput` /
    [`anthropic.js`](../hypaware-core/plugins-workspace/claude/src/anthropic.js))
    records `prev_base_url` plus the managed `ANTHROPIC_BASE_URL` /
    `SessionStart` hook entries; codex's `# BEGIN/END hypaware` marked block
    ([`hypaware-core/plugins-workspace/codex/src/settings.js`](../hypaware-core/plugins-workspace/codex/src/settings.js))
    records the prior `model_provider`. Unit-tested via the marker contents.
    Independent — it touches only adapter files and changes no core contract
    (the `json: true` one-line output shape is unchanged).
  - **T2 — attach policy reader.** New
    [`src/core/config/attach_policy.js`](../src/core/config/attach_policy.js)
    (`readAttachPolicy`, tri-state over `config.attach.on_join`), the
    [`backfill_policy.js`](../src/core/config/backfill_policy.js) twin — the
    single source of truth shared by the reconciler handler (T6) and the status
    surface (T9) so the two can never disagree on what a block means. Pure;
    unit-tested.
  - **T3 — reconcile-context seam.** Extend `ActionContext` and `ReconcileInput`
    in [`src/core/config/types.d.ts`](../src/core/config/types.d.ts) with the
    three optional fields the attach handler reads —
    `clientDescriptors?: Map<string, ClientDescriptor>` (enumerate /
    client→plugin map), `clients?: AiGatewayCapability` (invoke the effect), and
    `endpoint?: string` (the local gateway base URL). Type-only; no behaviour
    change until a handler (T6) or the daemon (T7) reads them.
  - **T8 — per-plugin `attach` config validation.** A `validateAttachSection`
    beside `validateBackfillSection` in the claude/codex
    [`config.js`](../hypaware-core/plugins-workspace/claude/src/config.js),
    wired into each plugin's config-section validator
    (`validateClaudeConfig` / the codex equivalent). Validates
    `config.attach.on_join`; plugin-local, no top-level/core schema change. It
    only needs to land before the end-to-end smoke proves an opt-out, not before
    any core code compiles.

- **The single core undo (deps `[T1]`).** **T4 — the one detach
  implementation.** New
  [`src/core/config/client_detach_disk.js`](../src/core/config/client_detach_disk.js):
  reverse a client's attach from the descriptor's `attachProbe` + the marker
  undo record, **format-aware** (`json` marker-key / `toml` managed-block) but
  plugin-agnostic, reusing `resolveClientSettingsPath`
  ([`src/core/daemon/client_settings_path.js`](../src/core/daemon/client_settings_path.js))
  and the `probeClientAttached` format logic
  ([`src/core/daemon/status.js`](../src/core/daemon/status.js)). It subsumes the
  adapters' old `detach()` — including the Codex marked-block strip and prior
  `model_provider` restore — so it replays exactly the undo record T1 writes
  (hence the edge on T1). Unit-tested on fixture settings files with **no plugin
  loaded**, proving reverse never depends on `ctx.clients`.

- **Retire the old detach (deps `[T4]`).** **T5 — drop adapter `detach()` +
  reroute manual `hyp detach`.** Remove `detach` from
  `AiGatewayClientRegistration`
  ([`hypaware-plugin-kernel-types.d.ts`](../hypaware-plugin-kernel-types.d.ts))
  and from the claude/codex `registerClient(...)` calls, and point
  `runClientLifecycle`'s detach branch
  ([`src/core/cli/core_commands.js`](../src/core/cli/core_commands.js)) at the T4
  core undo, resolved via the `clientDescriptor`. There is then exactly one undo
  and it cannot drift from itself. The existing `claude_attach_detach` /
  `client_attach_idempotent` smokes now exercise the core undo and must stay
  green — they are the cross-format regression for the single undo.

- **The attach handler (deps `[T2, T3, T4]`).** **T6 — `action_attach.js`.** New
  [`src/core/config/action_attach.js`](../src/core/config/action_attach.js)
  (`createAttachHandler` + `attachHandler`), mirroring `action_backfill.js`:
  `desired()` iterates `ctx.clientDescriptors` ∩ enabled plugins ∩
  `readAttachPolicy` (T2), guarded on `ctx.clients.getClient(name)` being present
  (T3); `perform()` calls `attach({ endpoint: ctx.endpoint, json: true })`,
  parses the one-line JSON, and records the marker detail (`settings_path`,
  `prev_value`); `reverse()` invokes the **T4 disk-driven undo** (it does *not*
  call `ctx.clients`, which lacks the dropped client). Unit-tested with injected
  fake `clientDescriptors` + `clients` + filesystem.

- **Daemon wiring (deps `[T3, T6]`).** **T7 — `runtime.js`.** In
  [`src/core/daemon/runtime.js`](../src/core/daemon/runtime.js): resolve
  `clientDescriptors` (from the plugin catalog), `clients`/`endpoint` (from
  `boot.runtime.capabilities` when the gateway capability is present, via
  `gateway.localEndpoint()` with the `configuredGatewayEndpoint` fallback the CLI
  already uses), thread all three onto the reconcile context (T3), and register
  the handlers **`[attachHandler, backfillHandler]` — attach first** so
  in-process live-capture wiring starts ahead of the (possibly multi-minute)
  backfill subprocess. Needs both the context fields (T3) and the handler it
  registers (T6).

- **Status surface (deps `[T2]`).** **T9 — declared-attach targets.**
  `buildClientActionsReport`
  ([`src/core/daemon/status.js`](../src/core/daemon/status.js)) gains a
  declared-attach-targets derivation symmetric to backfill's, reusing the
  `clientDescriptors`-derived plugin set status already builds (`backfillPlugins`)
  and `readAttachPolicy` (T2) for the interpretation: an enabled client plugin on
  a joined host (`hasCentral`) with no marker renders `pending`, with
  `attach.on_join: false` or on a non-joined host renders `n/a`, and a `done`
  marker renders attached. A failed/pending attach must **not** flip `overall` to
  `degraded`. It renders the generic `done`/`failed` `attach` markers (the
  handler writes them) unchanged; it never runs a pass, so it depends only on the
  shared policy reader.

- **Lifecycle flip (deps on all substance).** **T10** flips
  [`llp/0045-client-attach.design.md`](./0045-client-attach.design.md) Status
  `Accepted → Active` — the shipped marker, landed only once the whole change set
  has merged.

This yields a 4-wide first wave (T1, T2, T3, T8), then T4 (behind T1), then a
fan-out of T5 (behind T4), T6 (behind T2/T3/T4) and T9 (behind T2), the single
integration task T7 (behind T3/T6), and finally the lifecycle flip T10. Each task
leaves the tree green: a richer-but-unread marker (T1), an unused policy reader
(T2), unread context fields (T3), accepted-but-unused config keys (T8), a core
undo with no second caller yet (T4), a defined-but-unregistered handler (T6), and
a status section that reads `pending`/`n/a` until a pass runs (T9) are all inert
until T5 (reroute) and T7 (register + wire) connect them.

## Test ownership per task

- **T1:** the claude `_hypaware` marker and codex marked block each carry a
  complete undo record (claude: `prev_base_url` + managed hook entries; codex:
  prior `model_provider`); an idempotent re-attach keeps the *original*
  `prev_base_url`, not the gateway URL.
- **T2:** `readAttachPolicy` tri-state — absent block → default-on
  (`onJoin: undefined`), `on_join: false` → opt-out, present-but-malformed →
  fail-safe opt-out (mirroring `backfill_policy.js`).
- **T3:** type-only; covered by the type-check / build and by T6's handler tests
  reading the new context fields.
- **T4:** disk-driven reverse with **no adapter loaded** — given a fixture
  settings file with a hypaware marker, the generic undo strips the managed
  keys/hooks/block, restores `prev_base_url` / prior `model_provider`, and leaves
  no orphaned `hyp claude-hook` entries. A pre-existing foreign base URL
  round-trips byte-for-byte; the no-pre-existing-URL fixture round-trips to empty.
- **T5:** one undo, both call sites — the core undo is exercised by manual
  `hyp detach` *and* (in T6) the reconciler `reverse()` against the same fixtures
  and reaches the same end-state; the `claude_attach_detach` /
  `client_attach_idempotent` smokes stay green.
- **T6:** reverse gap — a `desired()` that drops a previously-applied client
  triggers `reverse()` once (invoking the T4 undo), the marker is removed, and a
  second pass is a no-op; a throwing `attach()` writes a `failed` marker that
  retries with bumped `attempts`; daemon-only — with no gateway capability
  `clients`/`endpoint` are undefined and the handler is inert.
- **T7:** the daemon resolves `clientDescriptors`/`clients`/`endpoint` and
  registers `[attachHandler, backfillHandler]` (attach first); a boot
  already-confirmed pass and a confirm-edge pass both reach the handler.
- **T8:** the claude/codex section validator accepts `{ on_join }` and rejects a
  non-boolean; a central-locked `attach` entry cannot be flipped by a colliding
  local entry (reuse the LLP 0031 merge-drop harness).
- **T9:** mixed `done`/`failed`/`pending`/`n/a` reads cleanly; `attach.on_join:
  false` and a non-joined host both render `n/a`; a `failed` attach does not flip
  `overall` to `degraded`.
- **End-to-end (hermetic smoke, lands with T7):** a seeded join confirming a
  config that names `@hypaware/claude` auto-attaches (settings written, marker
  `done`, status attached) and does not re-attach on a second confirmed poll;
  then a follow-up confirmed config that **drops** `@hypaware/claude` reverses it
  (settings restored) — the Part 5 config-drop trigger, exercised post-restart.

## Tasks
- id: T1   branch: task/client-attach/T1   deps: []              -- attach() writes a self-describing undo record: claude `_hypaware` marker (claude/src/settings.js MARKER_KEY, via writeAttachOutput/anthropic.js) records prev_base_url + managed ANTHROPIC_BASE_URL/SessionStart hook entries; codex `# BEGIN/END hypaware` marked block (codex/src/settings.js) records prior model_provider. Unit-tested via marker contents.
- id: T2   branch: task/client-attach/T2   deps: []              -- Attach policy reader: new src/core/config/attach_policy.js (readAttachPolicy, tri-state over config.attach.on_join), the backfill_policy.js twin shared by the handler (T6) and status (T9). Pure; unit-tested.
- id: T3   branch: task/client-attach/T3   deps: []              -- Reconcile-context seam: extend ActionContext + ReconcileInput in src/core/config/types.d.ts with optional clientDescriptors (Map<string, ClientDescriptor>), clients (AiGatewayCapability), endpoint (string). Type-only; no behaviour change until a handler reads them.
- id: T8   branch: task/client-attach/T8   deps: []              -- Per-plugin attach config validation: validateAttachSection beside validateBackfillSection in the claude/codex config.js, wired into validateClaudeConfig and the codex equivalent. Validates config.attach.on_join; plugin-local, no core schema change.
- id: T4   branch: task/client-attach/T4   deps: [T1]            -- The single core undo (= detach): new src/core/config/client_detach_disk.js reversing a client's attach from the attachProbe descriptor + the marker undo record, format-aware (json marker-key / toml managed-block) but plugin-agnostic, reusing resolveClientSettingsPath (client_settings_path.js) and the probeClientAttached format logic (status.js). Subsumes the adapters' old detach() incl. the Codex marked-block strip + model_provider restore. Unit-tested on fixtures with no plugin loaded.
- id: T5   branch: task/client-attach/T5   deps: [T4]            -- Retire adapter detach() + reroute manual detach: drop detach from AiGatewayClientRegistration (hypaware-plugin-kernel-types.d.ts) and from the claude/codex registerClient() calls, and point runClientLifecycle's detach branch (src/core/cli/core_commands.js) at the T4 core undo via the clientDescriptor. The claude_attach_detach / client_attach_idempotent smokes must stay green.
- id: T6   branch: task/client-attach/T6   deps: [T2, T3, T4]    -- Attach handler: new src/core/config/action_attach.js (createAttachHandler + attachHandler) mirroring action_backfill.js. desired() over ctx.clientDescriptors ∩ enabled plugins ∩ readAttachPolicy, guarded on ctx.clients.getClient(name); perform() calls attach({ endpoint: ctx.endpoint, json:true }), parses the one-line JSON, records detail (settings_path, prev_value); reverse() invokes the T4 disk-driven undo (not ctx.clients). Unit-tested with injected fake clientDescriptors + clients + fs.
- id: T7   branch: task/client-attach/T7   deps: [T3, T6]        -- Daemon wiring in src/core/daemon/runtime.js: resolve clientDescriptors (plugin catalog), clients/endpoint (boot.runtime.capabilities when the gateway is enabled, gateway.localEndpoint() with the configuredGatewayEndpoint fallback), thread onto the reconcile context, and register handlers [attachHandler, backfillHandler] — attach first. Lands the end-to-end hermetic auto-attach/reverse smoke.
- id: T9   branch: task/client-attach/T9   deps: [T2]            -- Status surface: buildClientActionsReport (src/core/daemon/status.js) gains a declared-attach-targets derivation symmetric to backfill's, reusing the clientDescriptors-derived plugin set (backfillPlugins) and readAttachPolicy: enabled client plugin on a joined host -> pending (no marker) / n-a (on_join:false or non-joined) / attached (done marker); must not flip overall to degraded.
- id: T10  branch: task/client-attach/T10  deps: [T1, T2, T3, T4, T5, T6, T7, T8, T9]  -- flip LLP 0045 Status Accepted->Active (shipped marker, LLP 0016).

## References

- [LLP 0045](./0045-client-attach.design.md) — the implementation design this plan schedules
- [LLP 0044](./0044-client-attach-on-join.decision.md) — client attach on join (the decision)
- [LLP 0041](./0041-central-config-client-actions.design.md) — the seam + backfill design this mirrors (sibling plan: [LLP 0043](./0043-central-config-client-actions.plan.md))
- [LLP 0036](./0036-central-config-driven-client-actions.decision.md) — the action seam (reversible-handler contract)
- [LLP 0016](./0016-ai-gateway.decision.md) — AI gateway / client adapters (`registerClient`, `attach`, `localEndpoint`)
- [`src/core/config/action_reconciler.js`](../src/core/config/action_reconciler.js), [`src/core/config/action_backfill.js`](../src/core/config/action_backfill.js), [`src/core/config/backfill_policy.js`](../src/core/config/backfill_policy.js), [`src/core/daemon/runtime.js`](../src/core/daemon/runtime.js), [`src/core/daemon/status.js`](../src/core/daemon/status.js), [`src/core/daemon/client_settings_path.js`](../src/core/daemon/client_settings_path.js), [`src/core/cli/core_commands.js`](../src/core/cli/core_commands.js), [`src/core/plugin_catalog.js`](../src/core/plugin_catalog.js) — the code these tasks build on
