# LLP 0045: Client attach on join — implementation design

**Type:** design
**Status:** Active
**Systems:** Config, Daemon, Onboarding, Sources, Gateway
**Author:** Phil / Claude
**Date:** 2026-06-26
**Related:** LLP 0016, LLP 0036, LLP 0037, LLP 0041, LLP 0044

> [LLP 0044](./0044-client-attach-on-join.decision.md) decided **client attach on
> join** — the reversible instance of the [LLP 0036](./0036-central-config-driven-client-actions.decision.md)
> action seam: when a joined machine confirms a central config that enables a
> client adapter, the daemon performs that client's attach machine-effect and
> reverses it on leave. This document is the *implementation* design, the
> reversible-instance counterpart to [LLP 0041](./0041-central-config-client-actions.design.md)
> (which designed the seam itself plus the run-once backfill instance). It does
> for attach what LLP 0041 Parts 1–2 did for the reconciler and backfill: where
> the handler lives, the new context dependency it needs, the adapter changes
> that make the round-trip reversible, the config/status surface, and the
> independently-mergeable tasks.

The decision ([LLP 0044](./0044-client-attach-on-join.decision.md)) is the
authority for *why* (consent default-on, conflict back-up-&-restore, opt-out
operator-only); this design is constrained by it and must not relitigate it.
Where it makes a fresh choice (the reconcile-context seam, the adapter marker
field), that choice is called out.

`@ref LLP 0044 — client attach on join (the decision this designs)`
`@ref LLP 0041 — the seam + backfill design this mirrors`

## What the code already gives us

The seam was built reversible for exactly this instance; attach plugs into
machinery that already exists.

- **The reconciler already drives `reverse()`.** `createActionReconciler` in
  [`src/core/config/action_reconciler.js`](../src/core/config/action_reconciler.js)
  runs a *reverse gap* loop: for any persisted marker whose request key
  `desired()` no longer names, it calls `handler.reverse(requestKey, ctx)` and
  drops the marker on success. Backfill omits `reverse()` (imported data stays);
  attach is the first handler to implement it. The reconciler core needs **no
  change**.
- **The marker store is namespaced per `kind`.** The same module writes
  `config-control/client-actions.json` with a top-level bucket per handler kind;
  a second bucket (`"attach"`) costs nothing. A `done` marker short-circuits the
  forward gap, so an applied attach is not re-performed every pass.
- **The gateway capability exposes the client registry.** `AiGatewayCapability`
  ([`hypaware-plugin-kernel-types.d.ts`](../hypaware-plugin-kernel-types.d.ts))
  gives `listClients()`, `getClient(name)`, and `localEndpoint()`. The shared
  `hyp attach`/`hyp detach` router (`runClientLifecycle` in
  [`src/core/cli/core_commands.js`](../src/core/cli/core_commands.js)) already
  resolves a client this way and calls `client.attach({ endpoint, config,
  stdout, stderr, dryRun, json })` — auto-attach is a second caller of that exact
  *attach* path. (The *detach* branch is rerouted to the single core undo —
  Part 3, task 5 — so it no longer calls a per-adapter `detach()`.) **Caveat:**
  `AiGatewayClientRegistration` has no owning-plugin field, so the registry alone
  can't map a client to its config entry — Part 1 closes that with the static
  `clientDescriptors`.
- **The static client→plugin map already exists.** `clientDescriptors`
  ([`src/core/plugin_catalog.js`](../src/core/plugin_catalog.js)), a
  `Map<clientName, { plugin, name, attachProbe? }>` derived from manifests, is
  what `status.js` uses to know which enabled plugins are client adapters. The
  attach handler enumerates `desired()` off the same map.
- **The adapter already reports what attach changed.** In `json: true` mode the
  Claude/Codex `attach()` emits a one-line JSON object with `changed`,
  `settings_path`, `port`, and `prev_value`
  ([`hypaware-core/plugins-workspace/claude/src/index.js`](../hypaware-core/plugins-workspace/claude/src/index.js),
  `writeAttachOutput`). The handler captures that to record the marker detail —
  no new adapter return contract.
- **Per-plugin policy validation has a template.** `validateBackfillSection` in
  [`hypaware-core/plugins-workspace/claude/src/config.js`](../hypaware-core/plugins-workspace/claude/src/config.js)
  validates `config.backfill`; `validateAttachSection` mirrors it for
  `config.attach`. The top-level plugin-config validator already passes unknown
  sibling keys through, so this is additive.
- **The status surface already renders arbitrary kinds.** `buildClientActionsReport`
  in [`src/core/daemon/status.js`](../src/core/daemon/status.js) iterates every
  marker `kind` generically into `done`/`failed`, and already special-cases
  `backfill` for the *declared-but-unrun* `pending`/`n/a` derivation. Attach adds
  a symmetric declared-targets derivation; the `done`/`failed` rendering is
  reused unchanged.

### Note: there is no handler `consent` slot

[LLP 0041 §Risks](./0041-central-config-client-actions.design.md#risks--open-questions)
anticipated "the handler `consent` slot exists so [attach] lands without
reworking the reconciler." The **implemented** `ActionHandler`
([`src/core/config/types.d.ts`](../src/core/config/types.d.ts)) has no such slot —
it is `kind` / `desired` / `perform` / `reverse?`. Attach needs none: consent is
**default-on**, enforced by `desired()` enumerating central-named clients and by
the operator off switch (`attach.on_join: false`), not by a per-perform gate
([LLP 0044 §Consent](./0044-client-attach-on-join.decision.md#consent--join-implies-consent-default-on)).
The anticipatory note in LLP 0041 is left as written (that record is immutable);
this is the corrected design.

## Part 1 — The client seam in the reconcile context

The attach handler needs three things the daemon has but the generic reconciler
does not: a way to **enumerate** the client adapters and their owning plugins
(for `desired()`), a way to **invoke** a client's attach/detach effect (for
`perform()`/`reverse()`), and the **gateway endpoint** to point clients at.
These map to three optional fields on `ReconcileInput` / `ActionContext`
([`src/core/config/types.d.ts`](../src/core/config/types.d.ts)):

```ts
clientDescriptors?: Map<string, ClientDescriptor>  // enumerate: clientName -> { plugin, attachProbe, ... }
clients?: AiGatewayCapability                       // invoke: getClient(name).attach/detach
endpoint?: string                                  // the local gateway base URL
```

**The split between `clientDescriptors` and `clients` is load-bearing.**
`AiGatewayClientRegistration` (what `clients.listClients()` returns) carries
`{ name, defaultUpstream, attach, detach }` and **no owning-plugin field**, so it
cannot answer "is this client's plugin enabled in the config?" The static
`clientDescriptors` map
([`src/core/plugin_catalog.js`](../src/core/plugin_catalog.js):
`{ plugin, name, attachProbe? }`, keyed by client name) — the same map
`status.js` already uses for backfill declared-targets — is the source of truth
for **enumeration and the client→plugin mapping**; the runtime `clients`
capability is used only to **perform the effect**. (Adding `plugin` to the
registration was the alternative; descriptors win because they need no
kernel-type change *and* hand the handler `attachProbe`, which the drift open
question later needs to re-detect attach state.)

The daemon (`runDaemon` in [`src/core/daemon/runtime.js`](../src/core/daemon/runtime.js))
resolves all three from boot: `clientDescriptors` from the plugin catalog,
`clients` from `boot.runtime.capabilities` when the gateway plugin is enabled
(`capabilities.has('hypaware.ai-gateway', '^2.0.0')` guards the lookup), and
`endpoint` from `gateway.localEndpoint()` — a **proven-bound** URL. (Hardening,
#179 round-3: the daemon path takes `localEndpoint()` and *only* that. If it
throws — the gateway never bound — the daemon leaves `endpoint` undefined and the
attach handler stays inert this pass rather than recording a base URL for a port
nothing bound; it attaches once a later boot observes a bound gateway. The
configured-`listen` fallback (`configuredGatewayEndpoint`) is kept only for the
**manual** `hyp attach`/`init` paths, where the user asked explicitly.) When the
manual path has *neither* (no gateway bound in the CLI process, no configured
`listen`, the normal shape of a central-managed install whose gateway binds an
ephemeral port only the daemon knows), `hyp attach` does not guess a port and
does not leak the internal `localEndpoint()` error: it probes the client's
on-disk attach state via `attachProbe` and reports "already attached, the
daemon manages attach" as a no-op success, or fails with a message that points
at starting the daemon or pinning `listen`. A client
adapter plugin
*requires* the gateway capability ([LLP 0016](./0016-ai-gateway.decision.md)), so
whenever a client plugin is enabled the gateway is too and the client is
registered; `desired()` still guards on `ctx.clients.getClient(name)` being
present so it never names a client `perform()` can't reach. (`startConfiguredSources`
runs during boot — `runtime.js:243` — *before* the reconciler is constructed and
any pass is scheduled, so the gateway is bound and its clients registered by the
time a boot-already-confirmed or confirm-edge pass executes; `localEndpoint()` is
live, not racing.)

Keeping these **on the context** (not captured in a handler closure) preserves
the reconciler's "knows nothing about Claude vs Codex" boundary: the *handler*
reads `ctx.clientDescriptors`/`ctx.clients`, the core never does. It also keeps
attach daemon-only by construction — a plain CLI boot has no gateway capability
*and* no `configControl`, so `hyp status` performs no machine effect.

## Part 2 — The attach handler (`src/core/config/action_attach.js`)

A new module exporting `createAttachHandler(opts)` → `ActionHandler` and a
default `attachHandler`, mirroring `action_backfill.js`.

- **`kind: 'attach'`** — the marker bucket + status section key.
- **`desired(ctx)`** — pure. Iterate `ctx.clientDescriptors`; for each descriptor
  whose `plugin` is enabled in `ctx.config.plugins`, whose plugin entry does not
  set `attach.on_join: false` (read via `attach_policy.js`, the
  `backfill_policy.js` twin), and whose client the runtime registry has
  (`ctx.clients.getClient(descriptor.name)` defined), emit
  `{ requestKey: descriptor.name, params: { client: descriptor.name, plugin: descriptor.plugin } }`.
  The owning plugin comes from the **descriptor**, not from `listClients()` (which
  omits it — Part 1).
- **`perform(action, ctx)`** — in-process (a bounded settings write; **not** a
  subprocess like backfill — [LLP 0041 §Execution isolation](./0041-central-config-client-actions.design.md#execution-isolation)).
  Resolve `ctx.clients.getClient(client)`, call `attach({ endpoint: ctx.endpoint,
  config: {}, stdout: <capture>, stderr: <capture/log>, json: true })`, parse the
  one-line JSON, and return `{ status: 'done', detail: { settings_path,
  ...(prev_value ? { prev_value } : {}) } }`. A throw (file not writable,
  malformed settings) becomes a `failed` outcome the reconciler records and
  retries next pass.
- **`reverse(client, ctx)`** — **disk-driven, not adapter-driven.** The reverse
  case that matters (the central config drops the client) fires only *after* the
  staged restart has already unloaded that adapter, so `ctx.clients.getClient(client)`
  is `undefined` and there is no live `detach()` to call (Part 3 traces this).
  Reverse instead reads the descriptor's `attachProbe` (`settings_file`, format,
  marker), resolves the path with `resolveClientSettingsPath`, and replays the
  marker's self-describing undo record — strip the managed keys/hooks/block,
  restore `prev_base_url` — to leave the file clean. It is **the same single core
  undo `hyp detach` uses** (Part 3). It needs `ctx.clientDescriptors` and the
  filesystem, **not** `ctx.clients`. Returns `done` once the settings file is
  clean; the reconciler then drops the marker.

The handler is constructed with the captured-stream, filesystem, and clock seams
injectable so unit tests assert the `attach` call, the marker detail, and the
disk-driven undo without a live gateway.

## Part 3 — Reverse runs from disk: the marker is a self-describing undo record

The headline reverse — an operator drops `@hypaware/claude` from the fleet
config — fires only *after* the apply engine's **staged restart**
([LLP 0025](./0025-remote-config-join-flow.spec.md#the-join-sequence)) has
relaunched the daemon **without** that plugin. At reverse time the adapter's
`registerClient` has not run, `getClient('claude')` is `undefined`, and there is
no in-process `detach()` to delegate to — the same reason the manual `hyp detach`
only works while the plugin is still installed. The only thing that survives the
restart is **disk state**: the client-action marker plus the client's own
settings-file marker.

Reverse is therefore **core/disk-driven and adapter-independent**, built on the
machinery core already has for the *read* side:

- `resolveClientSettingsPath`
  ([`src/core/daemon/client_settings_path.js`](../src/core/daemon/client_settings_path.js))
  resolves the settings path from the descriptor's `attachProbe.settings_file`.
- `probeClientAttached` ([`src/core/daemon/status.js`](../src/core/daemon/status.js))
  already reads the marker generically by format (`json` `marker_key` / `toml`
  `marker_header`) to decide attached/not. Reverse is the **write** counterpart:
  strip what attach wrote and restore what it backed up.

For that generic undo to be possible without the adapter, **`attach()` must write
a self-describing undo record into its marker** — enough for a format-aware but
plugin-agnostic core routine to fully reverse:

- **Claude (`json`):** the `_hypaware` marker records `prev_base_url` (the restore
  target) plus the managed keys/hooks it added, so core can restore-or-remove
  `env.ANTHROPIC_BASE_URL`, strip the managed `SessionStart`/… hook entries, and
  delete the marker — leaving **no orphaned hooks** still pointing at
  `hyp claude-hook`. The backup is preserved idempotently across a re-attach:
  once we own the URL the current value is *our* gateway URL, so a re-attach keeps
  the marker's recorded original rather than overwriting it.
- **Codex (`toml`):** the marked block is already self-delimiting
  (`# BEGIN/END hypaware …`) and records the prior `model_provider`, so core
  strips the block(s) and restores the recorded pointer.

Core stays **format-generic, never plugin-specific** — it knows `json` vs `toml`
and how to replay an undo record, not "Claude" vs "Codex". The split is clean: a
rich *write* (attach) needs the adapter (`ctx.clients`, Part 2); the *undo* is a
marker-guided removal core does from disk.

**There is exactly one undo implementation, and it lives in core.** Both call
sites use it — the reconciler's `reverse()` *and* the manual `hyp detach` command
(`runClientLifecycle`'s detach branch routes through the core undo via the
descriptor instead of calling a per-adapter `detach()`). The adapters therefore
own **only `attach()`**: `AiGatewayClientRegistration.detach` is retired and the
adapters' settings-writing `detach()` removed. One implementation cannot drift
from itself — the reason we unify rather than keep two paths bound by a contract.

The cost, accepted with that choice: the format-generic undo must subsume what
the adapters' `detach()` did — including Codex's `# BEGIN/END hypaware …`
marked-block removal and prior-`model_provider` restore. The managed-block
convention thus becomes a **core-understood format contract** (part of the
`attachProbe` format), not a codex-plugin-private detail. Core still never
*imports* plugin code (which wouldn't survive the plugin being unloaded anyway);
it strips by format from the self-describing marker.

This realizes [LLP 0044 §Conflict](./0044-client-attach-on-join.decision.md#conflict--back-up--override-restore-on-leave)
("back up & override, restore on leave") — the backup is the marker's undo
record, and "leave" is the config-drop trigger (Part 5).

## Part 4 — Per-plugin `attach` config + status surface

- **Config.** `attach.on_join` (boolean, default **true**) rides the client
  adapter's own `config` block, validated by that plugin's config-section
  validator — a `validateAttachSection` beside `validateBackfillSection` in the
  claude/codex `config.js`. No top-level schema; core validates nothing new. The
  operator off switch (`attach.on_join: false`) is locked with the central plugin
  entry ([LLP 0031 §Merge model](./0031-layered-config.decision.md#merge-model)) —
  no local override ([LLP 0044 §Opt-out](./0044-client-attach-on-join.decision.md#opt-out--operator-only-no-local-override)).
- **Status.** `buildClientActionsReport` gains a declared-attach-targets
  derivation symmetric to backfill's, using the **same `clientDescriptors`-derived
  plugin set** status already builds for `backfillPlugins` to know which enabled
  entries are client adapters: an enabled client plugin entry on a joined host
  (`hasCentral`) is a desired attach target; with no marker it renders `pending`,
  with `attach.on_join: false` or on a non-joined host it renders
  `n/a`, and a `done` marker renders attached. A failed/pending attach does
  **not** flip `overall` to `degraded`
  ([LLP 0041 §Failure is surfaced, not fatal](./0041-central-config-client-actions.design.md#failure-is-surfaced-not-fatal)).

## Part 5 — Reverse triggers: config-drop, not `hyp leave`

`reverse()` fires from the reconciler's standard reverse gap — a marker key
`desired()` no longer names. Concretely, two things can stop `desired()` naming a
client:

1. **The central config drops the client plugin** (the operator stops managing
   `@hypaware/claude` fleet-wide). This is the **headline v1 trigger**. The
   descriptor still exists in the catalog, but its plugin is no longer enabled, so
   `desired()` omits it → reverse gap → the disk-driven undo of Part 3 runs.
2. **`attach.on_join` is flipped to `false` while the plugin stays enabled.** Also
   reversed, by the same disk-driven undo. (The adapter happens to be live here,
   but reverse still goes through the disk path so there is one undo
   implementation, not two.)

**There is no `hyp leave` command** — a full unjoin (central layer removed
entirely) is not implemented, and even if it were, the reconcile pass is gated on
a present central layer (`boot.centralConfigPath != null` for the
already-confirmed pass; the confirm edge only fires during central polling), so a
host with no central layer runs no pass and reverses nothing. So v1's reverse is
**scoped to config-drop-while-still-joined**; un-attaching a fully-left machine is
a **manual `hyp detach`** (run while the plugin is installed) until a `hyp leave`
that drives a final reverse before tearing down the central layer lands. 0045
does **not** cite `hyp leave` as a live trigger; this scoping does not contradict
[LLP 0044](./0044-client-attach-on-join.decision.md) (which lists leave as a
future path), it sequences it.

## Module / seam breakdown (independently-mergeable tasks)

Ordered so each lands behind the previous but merges on its own.

1. **`attach()` writes a self-describing undo record** — claude + codex `attach()`
   record into their markers everything needed to reverse without the plugin
   (claude `_hypaware`: `prev_base_url` + managed keys/hooks; codex marked block:
   prior `model_provider`). This is the contract the single core undo (task 4)
   replays. Unit-tested via the marker contents.
2. **Attach policy reader** — `src/core/config/attach_policy.js`
   (`readAttachPolicy` tri-state over `config.attach.on_join`), the
   `backfill_policy.js` twin. Pure; unit-tested.
3. **Context seam** — extend `ActionContext` / `ReconcileInput` in
   `src/core/config/types.d.ts` with optional `clientDescriptors` + `clients` +
   `endpoint`. Tiny; no behaviour change until a handler reads them.
4. **The single core undo (= detach)** — a core routine (e.g.
   `src/core/config/client_detach_disk.js`) that reverses a client's attach from
   the `attachProbe` descriptor + the marker undo record, **format-aware** (`json`
   marker-key / `toml` managed-block) but plugin-agnostic, reusing
   `resolveClientSettingsPath` and the `probeClientAttached` format logic. It
   subsumes the adapters' old `detach()` (including the Codex marked-block strip).
   Unit-tested on fixture settings files with no plugin loaded.
5. **Retire adapter `detach()` + reroute manual detach** — drop `detach` from
   `AiGatewayClientRegistration` (kernel type) and from the claude/codex
   `registerClient` calls, and point `runClientLifecycle`'s detach branch at the
   task-4 core undo (resolved via the `clientDescriptor`). The existing
   `claude_attach_detach` / `client_attach_idempotent` smokes now exercise the
   core undo and must stay green — they are the cross-format regression for the
   single undo.
6. **Attach handler** — `src/core/config/action_attach.js`
   (`createAttachHandler` + `attachHandler`): `desired()` over
   `ctx.clientDescriptors` ∩ enabled plugins ∩ `attach_policy`, guarded on the
   runtime registry having the client; `perform()` calls `attach(json:true)` and
   records the detail; `reverse()` invokes the task-4 disk-driven undo (it does
   **not** call `ctx.clients`, which lacks the dropped client). Unit-tested with
   injected fake `clientDescriptors` + `clients` + filesystem.
7. **Daemon wiring** — `src/core/daemon/runtime.js`: resolve `clientDescriptors`
   (from the catalog), `clients`/`endpoint` (from `boot.runtime.capabilities`
   when the gateway is enabled), pass them into `reconcile()`, and register the
   handlers **`[attachHandler, backfillHandler]` — attach first**. The reconciler
   runs handlers serially and `backfillHandler.perform()` `await`s its (possibly
   multi-minute) subprocess, so attach-first starts live capture immediately
   instead of stranding it behind the historical import; attach (in-process) also
   can't be blocked by a hung backfill. Data is order-insensitive either way
   (both just land rows the forward sink drains) — this is purely the latency
   ordering.
8. **Per-plugin `attach` validation** — `validateAttachSection` in the claude /
   codex `config.js`; wire into each plugin's config-section validator.
9. **Status surface** — the declared-attach-targets derivation in
   `buildClientActionsReport` (Part 4).

## Test strategy

- **Disk-driven reverse with no adapter (task 4):** given a fixture settings file
  with a hypaware marker and **no plugin loaded**, the generic undo strips the
  managed keys/hooks/block, restores `prev_base_url`, and leaves no orphaned
  hooks — proving reverse does not depend on `ctx.clients`.
- **One undo, both call sites (tasks 4, 5):** the core undo is exercised by manual
  `hyp detach` *and* the reconciler `reverse()` against the same fixtures and
  reaches the same end-state — there is no second implementation to diverge.
- **Reverse gap (task 6):** a `desired()` that drops a previously-applied client
  triggers `reverse()` once (invoking the task-4 undo); the marker is removed; a
  second pass is a no-op. Backfill's handler (no `reverse()`) is unaffected.
- **Idempotent re-attach (tasks 1, 6):** attaching twice keeps the *original*
  `prev_base_url` (not the gateway URL); a `done` marker short-circuits the second
  perform.
- **Conflict round-trip (tasks 1, 4):** pre-existing foreign base URL → attach
  backs it up and overrides → the core undo restores it byte-for-byte. The
  existing no-pre-existing-URL fixture still round-trips to empty.
- **Opt-out (tasks 2, 8, 9):** `attach.on_join: false` → `desired()` emits
  nothing, status `n/a`; a central-locked entry cannot be flipped by a local
  entry (reuse the LLP 0031 merge-drop harness).
- **Daemon-only (tasks 3, 7):** with no gateway capability, `clients`/`endpoint`
  are undefined and the handler is inert; `hyp status` performs no effect.
- **Failure surfacing (tasks 6, 9):** an `attach()` that throws writes a `failed`
  marker (not `done`), retries next pass, increments `attempts`, and status
  reports `failed` without flipping `overall`.
- **End-to-end (hermetic smoke):** a seeded join confirming a config that names
  `@hypaware/claude` auto-attaches (settings written, marker `done`, status
  attached) and does not re-attach on a second confirmed poll; then a follow-up
  confirmed config that **drops** `@hypaware/claude` reverses it (settings
  restored) — the config-drop trigger of Part 5, exercised post-restart.

## Open questions

Carried from [LLP 0044](./0044-client-attach-on-join.decision.md#open-questions);
settle as the code lands.

- **Marker vs actual-file drift.** v1 keys idempotency on the marker, not the
  live settings file: a user who manually strips the gateway leaves a `done`
  marker, so the reconciler will not re-attach until the config changes. A later
  refinement could have `desired()` re-detect actual attach state via the
  `attach_probe` descriptor (which already powers `hyp status`) and re-apply on
  drift. v1 accepts the marker-only model, matching backfill.
- **Ordering vs first ingest.** ~~Open in [LLP 0036](./0036-central-config-driven-client-actions.decision.md#open-questions).~~
  **Resolved for the latency dimension** (task 6): handlers run serially and
  backfill `await`s its subprocess, so attach is registered **first** to start
  live capture without waiting on the import. Data remains order-insensitive (both
  land rows the forward sink drains); the smoke still asserts no dependency
  surfaces.
- **Codex prior-provider nuance.** "Restore the prior value" for Codex means the
  prior `model_provider`, not a URL; confirm the adapter round-trip in task 1's
  tests.
- **Undo-record completeness — the contract for the *sole* undo.** Since unify
  (Q5) makes the core undo (task 4) the **only** detach, the marker must be a
  complete undo record: a format-aware core routine has to fully reverse what
  `attach()` wrote *without importing plugin code* (for Claude: the managed hook
  entries, not just `prev_base_url`, or core re-derives them from the stable
  managed-hook pattern; for Codex: the `# BEGIN/END` managed-block convention,
  now a **core-understood format contract**). Settle the exact marker shape and
  whether core encodes the per-format replay generically or reads a declarative
  undo manifest the marker carries. Under-specifying it risks orphaned
  `hyp claude-hook` entries after a fleet-drop, and there is no second
  implementation to fall back on. Settle when tasks 1, 4, and 5 land.
- **Subprocess vs in-process consistency.** Attach is in-process; if a future
  client adapter's attach becomes unbounded (e.g. a network probe), revisit
  whether it should move to the subprocess profile backfill uses.

## References

- [LLP 0044](./0044-client-attach-on-join.decision.md) — client attach on join (the decision this designs)
- [LLP 0041](./0041-central-config-client-actions.design.md) — the seam + backfill implementation design this mirrors
- [LLP 0036](./0036-central-config-driven-client-actions.decision.md) — the action seam (reversible-handler contract)
- [LLP 0037](./0037-backfill-on-join.decision.md) — backfill on join (the run-once sibling)
- [LLP 0016](./0016-ai-gateway.decision.md) — AI gateway / client adapters (`registerClient`, `attach`/`detach`, `localEndpoint`)
- [LLP 0031](./0031-layered-config.decision.md) — layered config / merge model (plugin-entry locking)
- [`src/core/config/action_reconciler.js`](../src/core/config/action_reconciler.js), [`src/core/config/action_backfill.js`](../src/core/config/action_backfill.js), [`src/core/daemon/runtime.js`](../src/core/daemon/runtime.js), [`src/core/daemon/status.js`](../src/core/daemon/status.js) — the code this design builds on
