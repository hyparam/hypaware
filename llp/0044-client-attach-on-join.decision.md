# LLP 0044: Client attach on join

**Type:** Decision
**Status:** Accepted
**Systems:** Config, Daemon, Onboarding, Sources
**Author:** Phil / Claude
**Date:** 2026-06-26
**Related:** LLP 0011, LLP 0016, LLP 0025, LLP 0031, LLP 0036, LLP 0037, LLP 0041
**Designed-by:** LLP 0045 — client attach implementation design
**Extended-by:** LLP 0086 — attach tracks the gateway's ephemeral port (the "attach once, done forever" model becomes endpoint-aware: re-attach on a daemon rebind, and manual `hyp attach` discovers the live port)

> When a machine joins a fleet the central config pulls and the gateway binds —
> but nothing is captured until someone runs `hyp attach claude` / `hyp attach
> codex` by hand. Daemon healthy, gateway bound, **nothing recorded**: the
> silent-gap failure [#126](https://github.com/hyparam/hypaware/issues/126)
> names. This document specifies the **reversible instance** of the
> [LLP 0036](./0036-central-config-driven-client-actions.decision.md) action
> seam: when a joined machine confirms a central config that enables a client
> adapter, the daemon performs that client's **attach** machine-effect
> (editing `~/.claude/settings.json` / `~/.codex/config.toml` to route through
> the local gateway) and **reverses it on leave/detach**. It resolves the
> attach-specific open questions [LLP 0036](./0036-central-config-driven-client-actions.decision.md#open-questions)
> and [LLP 0041](./0041-central-config-client-actions.design.md#risks--open-questions)
> deferred — consent, conflict, opt-out — and is the sibling of
> [LLP 0037](./0037-backfill-on-join.decision.md) (backfill on join, the
> run-once instance).

## Summary

`hyp attach` does two things ([LLP 0016](./0016-ai-gateway.decision.md)): the
**config-layer** half (the `@hypaware/claude` plugin entry) is already
fleet-expressible and applied by the engine; the **machine-effect** half —
editing a user-owned client file so the agent routes to the gateway — the apply
engine deliberately never touches ([LLP 0025 §apply engine is kernel surface](./0025-remote-config-join-flow.spec.md#apply-engine-is-kernel-surface)).
That second half is exactly what the [LLP 0036](./0036-central-config-driven-client-actions.decision.md)
action reconciler exists to carry.

Attach is the **reconciled / reversible** flavour the seam was built for but had
not yet exercised: the marker records the *currently-applied* state, `perform()`
attaches when the config names a client, and `reverse()` detaches when it stops
naming it (config drop or `hyp leave`). It reuses the **same `client.attach()`
machine-effect** the manual command calls — auto-attach is a new *caller* of the
adapter, not a new effect.

This decision settles the three attach-specific questions LLP 0036/0041 left
open. All three follow the grain already set by backfill, so attach rides the
existing `plugins[]` surface and locking with **no new merge rule**.

## Context

- **Live capture is opt-in per client.** The gateway records only traffic a
  client actually routes to it. Routing is set by the client's native settings
  file (`ANTHROPIC_BASE_URL` for Claude, `[model_providers.hypaware]` for
  Codex), which only `hyp attach` writes ([LLP 0012 Sources](./0012-sources.spec.md)).
- **Join wires config, not client files.** The non-interactive `join` path
  ([LLP 0011 §Non-interactive entry](./0011-setup-and-onboarding.decision.md#non-interactive-entry))
  applies the central config and starts the gateway, but the apply engine never
  edits a user-owned file. Result: a healthy, forwarding gateway that captures
  nothing because no client points at it.
- **The seam already supports a reversible handler.** The
  [LLP 0041](./0041-central-config-client-actions.design.md) reconciler calls
  `reverse(requestKey)` for any marker whose key `desired()` no longer names,
  and the marker file already reserves a per-`kind` namespace
  ([LLP 0041 §Idempotency](./0041-central-config-client-actions.design.md#idempotency-and-completion-state)).
  Attach is a second `ActionHandler` (`kind: 'attach'`), registered beside
  `backfillHandler`; the reconciler core is unchanged.

## Decision

Add an **attach** action handler — the reversible instance of the
[LLP 0036](./0036-central-config-driven-client-actions.decision.md) seam.

### Where attach is declared

Attach rides the **client adapter's own plugin entry** (the entry the config
already names — #126), so the central-vs-local locking
([LLP 0031 §Merge model](./0031-layered-config.decision.md#merge-model)) falls
out: a central-named `@hypaware/claude` entry is authoritative; a colliding
local entry is dropped at the boot merge. There is **no generic `actions[]`
schema** and no top-level attach section — consistent with
[LLP 0036 §Where actions are declared](./0036-central-config-driven-client-actions.decision.md#where-actions-are-declared).

```jsonc
{ "name": "@hypaware/claude", "config": {
    "proxy": "@hypaware/ai-gateway",
    "attach": { "on_join": true }
} }
```

`attach.on_join` (default **true**) is validated by the **owning client
plugin's** config-section validator ([LLP 0005](./0005-plugin-manifest.spec.md)),
the same path that validates `backfill`. Core validates nothing new.

### `desired()` — which clients

The attach handler enumerates **every registered gateway client whose owning
plugin is enabled in the effective config**, minus those whose plugin entry set
`attach.on_join: false`. The marker request key is the **client name**
(`claude`, `codex`). On a non-joined host there is no central layer, the
reconciler never runs, and attach stays the manual `hyp attach` command.

### `perform()` / `reverse()` — the effect

Attach is **in-process** (a bounded settings-file edit, unlike backfill's
unbounded subprocess import — [LLP 0041 §Execution isolation](./0041-central-config-client-actions.design.md#execution-isolation)):

- `perform()` calls the gateway client's `attach({ endpoint, … })` — the exact
  effect `hyp attach` invokes — in JSON mode, recording the adapter's reported
  `settings_path` and prior base URL (`prev_value`) into the marker.
- `reverse(client)` calls the client's `detach(…)` when `desired()` stops
  naming it (the config dropped the client, or `hyp leave` cleared the central
  layer). The adapter restores the backed-up prior base URL (below).

A `done` marker short-circuits re-attach on every subsequent pass — the effect
is already in place; the reconciler does not re-edit the file each tick.

### Consent — `join` implies consent (default-on)

A joined machine **self-attaches with no prompt** when the central config names
a client. Rationale:

- It is the issue's acceptance criterion — *"becomes attached with no manual
  step"* ([#126](https://github.com/hyparam/hypaware/issues/126)) — and reaches
  parity with the interactive `init` finale, which already attaches every picked
  client ([LLP 0011](./0011-setup-and-onboarding.decision.md)).
- The blast radius is narrow and **fully reversible**: the effect edits the
  user's *own* client file to route to the user's *own* local gateway on the
  machine that *already joined*, and `reverse()` restores the prior state on
  leave. This is the same consent footing backfill stands on
  ([LLP 0036 §Consent](./0036-central-config-driven-client-actions.decision.md#consent)).
- The operator retains an **off switch** — `attach.on_join: false` in the
  locked central plugin entry — so a fleet that wants the gateway up but clients
  attached by hand can have it. Consent is therefore *operator-scoped*, not a
  per-invocation prompt.

### Conflict — back up & override, restore on leave

When a machine already has a base URL pointing somewhere that is **not** the
gateway (a deliberate third-party proxy), auto-attach **records the prior value
and overrides**, then **restores the original on detach/leave**. The backup
lives in the adapter's own marker (`_hypaware.prev_base_url` for Claude; the
Codex marked-block metadata), so restoration is the adapter's job — the
reconciler stays client-agnostic. This makes **both** the auto path and the
manual `hyp detach` fully round-trip; previously `detach` removed the gateway
URL only when it still matched and never restored a pre-existing one. Chosen over
*skip-and-warn* because the feature's whole point is zero-touch capture, and over
*override-without-backup* because clobbering a deliberate setting with no undo is
not reversible — the seam's core promise.

### Opt-out — operator-only, no local override

A machine **cannot** locally suppress an attach the central config mandates.
Attach policy lives in the `plugins[]` entry, which is locked under
[LLP 0031 §Merge model](./0031-layered-config.decision.md#merge-model); a
colliding local entry is dropped, exactly as for backfill
([LLP 0037 §No local opt-out](./0037-backfill-on-join.decision.md#no-local-opt-out--the-operator-owns-it))
and the central sink. If a particular machine should not attach, that is an
**operator scoping decision** (`attach.on_join: false`, or a different
config/token), not a local flag. This rides the existing locking with no new
merge rule.

### Trigger, lifecycle, and failure

Identical to backfill's reconcile timing
([LLP 0041 §When the reconciler runs](./0041-central-config-client-actions.design.md#when-the-reconciler-runs-lifecycle-integration)):
fired on the `confirmPoll` probation active→cleared edge and on the
after-activation already-confirmed pass, **never mid-apply**. A failed attach
(file not writable, malformed settings) writes a `failed` marker (reason +
attempt count), is retried on the next pass, and **does not** roll back the
central config or flip `overall` to `degraded`
([LLP 0041 §Failure is surfaced, not fatal](./0041-central-config-client-actions.design.md#failure-is-surfaced-not-fatal)).

## Status surface

`hyp status` reports attach under the
[LLP 0041](./0041-central-config-client-actions.design.md#idempotency-and-completion-state)
`client_action` section, **per client**: `done` (attached, with when) / `failed`
(reason + last attempt) / `pending` (named, not yet attached) / `n/a`
(`on_join: false` or non-joined). A failed or pending attach does **not** make
`overall` `degraded`.

## Relationship to manual attach

`hyp attach` / `hyp detach` are untouched as commands. Auto-attach is a **new
caller** of the same adapter `attach()`/`detach()`, parameterised by the central
config instead of argv. The one change to the adapters — recording and restoring
the prior base URL — is a **strict improvement** that the manual `hyp detach`
inherits too: a manual round-trip now restores a pre-existing base URL it
previously left in place with a warning.

## Consequences

- **LLP 0031's deferred attach open question is fully resolved** (not just "in
  principle" as [LLP 0036](./0036-central-config-driven-client-actions.decision.md#consequences)
  left it): consent, conflict, and opt-out are settled here; the implementation is
  designed in [LLP 0045](./0045-client-attach.design.md).
- **The reconciler's `reverse()` path is exercised for the first time.** Backfill
  omits it (imported data stays); attach is the reversible handler the seam was
  designed around ([LLP 0041 §Undo on leave](./0041-central-config-client-actions.design.md#undo-on-leave-reversible-handlers)).
- **The reconcile context gains a client seam.** The handler needs the gateway's
  client registry and endpoint, which only the daemon has live — keeping attach
  daemon-only by construction (a plain CLI boot has no gateway capability and no
  `configControl`, so `hyp status` performs no machine effect).
- **Join does more.** A joined machine self-attaches its clients (subject to the
  operator off switch) — an onboarding-surface change from
  [LLP 0011](./0011-setup-and-onboarding.decision.md)'s manual-attach finale,
  reached without editing that record.

## Open questions

- **Marker vs actual-file drift.** v1 keys idempotency on the marker, not the
  live settings file: if a user manually strips the gateway from their settings,
  the `done` marker means the reconciler will not re-attach until the config
  changes. A later refinement could have `desired()` re-detect actual attach
  state (the `attach_probe` descriptor already powers `hyp status`) and re-apply
  on drift. v1 accepts the simpler marker-only model, matching backfill.
- **Ordering vs first ingest.** Attach (start live routing) and backfill (import
  history) run in the same post-confirm pass. The cache→forward path is
  order-insensitive (both just land rows the forward sink drains), so no ordering
  is imposed; revisit only if a dependency surfaces
  ([LLP 0036 open questions](./0036-central-config-driven-client-actions.decision.md#open-questions)).
- **Codex prior-provider nuance.** Codex routing is a `model_provider` pointer
  plus a marked provider block; "restore the prior value" means restoring the
  prior `model_provider`, not a URL. The adapter owns this asymmetry; confirm the
  round-trip in the adapter tests.

## References

- [LLP 0036](./0036-central-config-driven-client-actions.decision.md) — the action seam (the decision this instantiates)
- [LLP 0037](./0037-backfill-on-join.decision.md) — backfill on join (the run-once sibling instance)
- [LLP 0041](./0041-central-config-client-actions.design.md) — client-actions implementation design (the reconciler this extends)
- [LLP 0045](./0045-client-attach.design.md) — client attach implementation design (the design realizing this decision)
- [LLP 0011](./0011-setup-and-onboarding.decision.md) — setup and onboarding (the attach finale this reaches parity with)
- [LLP 0016](./0016-ai-gateway.decision.md) — AI gateway / client adapters (`registerClient`, `attach`/`detach`)
- [LLP 0025](./0025-remote-config-join-flow.spec.md) — join flow, apply, probation (the confirmation trigger)
- [LLP 0031](./0031-layered-config.decision.md) — layered config / merge model (plugin-entry locking; the deferred attach question)
- [LLP 0005](./0005-plugin-manifest.spec.md) — plugin manifest / config_sections (per-plugin `attach` validation)
- [#126](https://github.com/hyparam/hypaware/issues/126) — config-driven client attach
