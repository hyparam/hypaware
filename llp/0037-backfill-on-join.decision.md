# LLP 0037: Backfill on join

**Type:** Decision
**Status:** Accepted
**Systems:** Config, Sources, Daemon
**Author:** Phil / Claude
**Date:** 2026-06-25
**Related:** LLP 0005, LLP 0011, LLP 0012, LLP 0025, LLP 0031, LLP 0036

> When a machine joins a fleet, live capture records *from that moment on* — but
> everything the user did *before* joining is invisible to the server. This
> document specifies a **one-shot, central-config-driven backfill**: the first
> time a joined machine confirms a central config in which a backfill-capable
> source plugin is enabled, the daemon runs `hyp backfill` once for that plugin
> to import its pre-join history into the cache, from where the central forward
> sink carries it up to the server. It is the **run-once instance** of the
> action seam in
> [LLP 0036](./0036-central-config-driven-client-actions.decision.md). After
> that single catch-up, live capture keeps the server current — no cadence, no
> recurring job.

## Summary

Backfill today is a **manual** command (`hyp backfill [provider...]
--since/--until/--retention-days`), plus a one-shot run in the interactive
onboarding finale ([LLP 0011](./0011-setup-and-onboarding.decision.md)). A
fleet machine enrolled non-interactively via `hyp join`
([LLP 0025](./0025-remote-config-join-flow.spec.md#seed-config-mode)) never gets
that finale, so its history sits on disk until a human runs backfill by hand — a
silent gap exactly like the auto-attach gap in
[#126](https://github.com/hyparam/hypaware/issues/126).

The fix follows the corpus's existing grain rather than inventing new config
surface: **backfill is a capability of the client-source adapter plugin**
(CONTEXT.md §Source — "the adapter plugin… *can backfill its local history*"),
so its policy lives in **that plugin's own `config` section**, validated by the
plugin ([LLP 0005](./0005-plugin-manifest.spec.md),
[LLP 0010 §Validation](./0010-config-model.spec.md#validation)). The kernel
[action reconciler](./0036-central-config-driven-client-actions.decision.md)
owns only the generic run-once machinery. There is **no top-level `backfill`
section** and nothing new for core to validate.

## Context

- **Live capture is forward-only.** The gateway records sessions from attach
  onward; pre-join sessions are historical files on disk
  ([LLP 0012 Sources](./0012-sources.spec.md)) that only `hyp backfill` pulls
  into the cache.
- **Join skips the finale.** The non-interactive `join` path
  ([LLP 0011 §Non-interactive entry](./0011-setup-and-onboarding.decision.md#non-interactive-entry))
  has no backfill step. Result: a healthy, attached, forwarding gateway whose
  server view starts at join and silently omits the user's history.
- **The cache → server path already exists.** The central forward sink reads the
  local cache (`forwardPartition` streams the dataset table) and forwards rows to
  the server, so an import into the cache *reaches the server on its own* —
  backfill never talks to the server, it only lands rows in the table the
  forward sink already drains. (That the forward sink re-reads the whole table,
  [#122](https://github.com/hyparam/hypaware/issues/122), means backfilled rows
  are forwarded with no cursor work; that inefficiency is tracked separately and
  does not block this feature.)
- **One run is enough.** Because forwarding continues after the import, a single
  catch-up closes the gap permanently. An earlier draft proposed a cron cadence
  and was dropped: there is no recurring work to do.

## Decision

A backfill-capable source plugin gains a `backfill` key in its **own config
section**:

```jsonc
{ "name": "@hypaware/claude", "config": {
    "proxy": "@hypaware/ai-gateway",
    "backfill": { "on_join": true, "window_days": 30 }
} }
```

When a joined machine **confirms** (clears probation on) a central config in
which such a plugin is enabled, the
[LLP 0036](./0036-central-config-driven-client-actions.decision.md) action
reconciler runs `hyp backfill <plugin>` **once as a subprocess** and records a
per-provider completion marker so it never auto-runs again.

### Per-plugin config, kernel-generic reconciler

The responsibility split is the whole point of routing through
[LLP 0036](./0036-central-config-driven-client-actions.decision.md):

| Owns | What |
|---|---|
| **Source plugin** | `backfill.on_join` (whether) and `backfill.window_days` (how far back); validates these keys via its `config_sections` ([LLP 0005](./0005-plugin-manifest.spec.md)). The plugin is already the backfill provider in `registry/backfills.js`. |
| **Kernel reconciler** | Enumerate the **enabled backfill providers**, read each owning plugin's resolved `backfill` config, and drive the run-once import per provider — fire post-probation, once-ness marker, subprocess isolation, failure surfaced-not-fatal. Knows nothing about Claude vs Codex. |

The seam between them is the reconciler **enumerating backfill providers** (the
registry already knows them) and reading the merged plugin config — no new
generic `actions[]` schema, no cross-plugin provider list.

### Default: opt-out (default-on)

When the central config enables a backfill-capable adapter but says nothing
about `backfill`, it **imports on join** (`on_join` defaults to `true`). This
reaches parity with the interactive `init` finale, which already backfills every
picked source ([LLP 0011](./0011-setup-and-onboarding.decision.md)). Setting
`backfill.on_join: false` is the explicit off switch. Consent rests on the
narrow blast radius: backfill reads the user's **own** history into the user's
**own** cache, then forwards to the server the machine **already joined** — see
[LLP 0036 §Consent](./0036-central-config-driven-client-actions.decision.md#consent).

### No local opt-out — the operator owns it

Backfill policy lives in the plugin entry, and a central-named plugin entry is
**locked** under
[LLP 0031 §Merge model](./0031-layered-config.decision.md#merge-model)
(`plugins[]` merges by name; a colliding local entry is dropped). So a user
**cannot** locally flip `on_join: false` on a centrally-managed adapter — the
same way they cannot drop the central sink. If a particular machine should not
import history, that is an **operator scoping decision** (a different config
name / token for that machine), not a local override. This rides the existing
`plugins[]` locking with **no new merge rule** — backfill config is just part of
the plugin entry LLP 0031 already governs.

### Trigger and lifecycle

1. `join` → seed → bootstrap → first `GET /v1/config` → apply → staged restart
   ([LLP 0025](./0025-remote-config-join-flow.spec.md#the-join-sequence)).
2. Relaunched daemon activates; the central config enters **probation**.
3. Probation clears on the
   [first successful authenticated poll](./0025-remote-config-join-flow.spec.md#post-apply-probation).
   **Only then** does the reconciler consider backfill — never against a config
   that might still roll back.
4. For each enabled backfill provider with no completion marker and
   `backfill.on_join` truthy, spawn `hyp backfill <plugin> --since <…>` as a
   subprocess.
5. On subprocess **success**, write that provider's completion marker. On
   failure, leave it unset (retry next boot) and surface it in status — never
   roll back the central config
   ([LLP 0036 §Failure is surfaced, not fatal](./0036-central-config-driven-client-actions.decision.md#failure-is-surfaced-not-fatal)).

### Completion marker: run once, no auto re-trigger (v1)

The marker lives in **kernel-managed state**
([LLP 0004](./0004-activation-and-paths.spec.md#state-directories)), alongside
the apply/probation bookkeeping, **not** in a plugin state dir — the reconciler
is kernel surface
([LLP 0036 §When the reconciler runs](./0036-central-config-driven-client-actions.decision.md#when-the-reconciler-runs)).
For v1 it is a simple **per-(machine, provider) "done" flag**: once a provider's
import succeeds, the reconciler never auto-runs it again, even if the operator
later widens `window_days`. **Re-running is a manual act** — `hyp backfill
<plugin> --since <…>` is unchanged and is how an operator picks up a widened
window on an already-imported machine. Keeping the marker a boolean (rather than
a high-water window that auto-re-imports on policy change) is the deliberate
v1-simplicity choice; the auto-re-trigger refinement is an
[open question](#open-questions).

### `window_days` resolution

`window_days` becomes `--since (now − window_days)` for the subprocess. Absent ⇒
fall back to the local `query.cache.retention.default_days`
([LLP 0013](./0013-local-query-cache.decision.md)), matching today's manual
`resolveRetentionDays`. Importing older than local retention is wasted work the
cache will prune, so the effective span is naturally bounded by retention.

### Execution: subprocess

Backfill is unbounded work — a machine with months of history can take minutes
and meaningful memory. It runs as a **subprocess** (`hyp backfill …`), never
inline on the daemon tick, so a large import cannot wedge the tick loop or grow
daemon heap. This is the
[LLP 0036 §Execution isolation](./0036-central-config-driven-client-actions.decision.md#execution-isolation)
run-once + subprocess profile.

## Status surface

`hyp status` reports backfill-on-join under the
[LLP 0036](./0036-central-config-driven-client-actions.decision.md#consequences)
`client_action` section, **per provider**: `done` (marker set, with when + row
count) / `failed` (reason + last attempt) / `pending` / `n/a` (`on_join: false`
or non-joined). A failed or pending backfill does **not** make `overall`
`degraded`.

## Relationship to manual backfill

`hyp backfill` is untouched — the manual command, the `list`/`plan`
subcommands, and the onboarding-finale call all stay as they are. Auto-backfill
is a *new caller* of the same provider pipeline, parameterised by the plugin's
config instead of argv, and the manual command remains the escape hatch for
re-runs (a widened window, a fresh import after a cache recreate). The
interactive `init` finale and `join` now reach feature parity: both seed history
once.

## Open questions

- **Auto re-trigger on widened policy.** v1 is strict run-once; a future
  high-water-window marker could re-import the new slice automatically when the
  operator widens `window_days` (`part_id` dedupe makes the overlap a no-op).
  Deferred — see [LLP 0036 request-key](./0036-central-config-driven-client-actions.decision.md#open-questions).
- **Partial-provider failure.** The per-provider marker already isolates this:
  one provider's import failing leaves the others done. Confirm the status surface
  reads cleanly when one provider is `done` and another `failed`.
- **Subprocess resource bounds.** Should the spawned backfill get a niceness /
  memory ceiling so a huge first import doesn't starve live capture? Likely yes;
  size it when the daemon-subprocess plumbing lands.
- **Marker reset on cache recreate.** A breaking schema change
  ([LLP 0030](./0030-session-id-partition-key.decision.md)) recreates the cache
  and needs a fresh backfill. Should the marker reset so history re-imports
  automatically? Probably; tracked with the schema-evolution work
  ([LLP 0029](./0029-additive-cache-schema-evolution.decision.md)).

## References

- [LLP 0036](./0036-central-config-driven-client-actions.decision.md) — the action seam this implements
- [LLP 0005](./0005-plugin-manifest.spec.md) — plugin manifest / `config_sections`
- [LLP 0011](./0011-setup-and-onboarding.decision.md) — onboarding / non-interactive entry
- [LLP 0012](./0012-sources.spec.md) — sources and backfill providers
- [LLP 0025](./0025-remote-config-join-flow.spec.md) — join flow, apply, probation
- [LLP 0031](./0031-layered-config.decision.md) — layered config / merge model (plugin-entry locking)
- hypaware-server LLP 0009 (`~/workspace/hypaware-server/llp/0009-remote-config.spec.md`) — served per-plugin config flows through the kernel-owned save pipeline unchanged
- [#122](https://github.com/hyparam/hypaware/issues/122), [#126](https://github.com/hyparam/hypaware/issues/126)
