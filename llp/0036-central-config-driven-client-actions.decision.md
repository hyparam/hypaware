# LLP 0036: Central-config-driven client actions

**Type:** Decision
**Status:** Draft
**Systems:** Config, Daemon, Onboarding
**Author:** Phil / Claude
**Date:** 2026-06-25
**Related:** LLP 0003, LLP 0011, LLP 0017, LLP 0025, LLP 0031; LLP 0037 (first instance — backfill on join)

> Some things a fleet operator wants a joined machine to do are not expressible
> as **topology**. Applying a central config can start a source or wire a sink,
> but it cannot — under the current model — edit `~/.claude/settings.json` or
> import a machine's pre-join history. This document establishes a single seam
> for **central-config-driven client actions**: an idempotent, daemon-side
> reconciler that performs a machine-side effect *because the central config
> asked for it*, records that it did, and (where the effect is reversible)
> undoes it on leave. It resolves the **"Central-managed client attach
> semantics"** open question deferred in
> [LLP 0031](./0031-layered-config.decision.md#open-questions--deferred) and is
> realized first by [LLP 0037](./0037-backfill-on-join.decision.md).

## Summary

Central config today is **declarative topology**: `plugins`, `sinks`,
`disambiguate` describe *what runs*, and the apply engine
([LLP 0025](./0025-remote-config-join-flow.spec.md#apply-semantics-staged-restart))
makes the running set match. Two wanted features do not fit that mould — they
are *imperative machine effects* a config calls for, not components it declares:

- **Client attach** ([#126](https://github.com/hyparam/hypaware/issues/126)) —
  edit `~/.claude/settings.json` / Codex `config.toml` so the local agent routes
  through the gateway. A side effect on a user-owned file, not a plugin.
- **Backfill on join** ([LLP 0037](./0037-backfill-on-join.decision.md)) — run a
  one-shot `hyp backfill` so a machine's pre-join history reaches the cache (and,
  via the central forward sink, the server) before live capture takes over.

Rather than bolt each onto the apply engine ad hoc, this decision defines **one
contract** they both implement: a daemon-side **action reconciler** that reads
action requests from the (authoritative) central layer, runs each at most once
per machine for a given request, tracks completion in kernel-managed state, and
treats a failed action as *surfaced, not fatal* — never a trigger for central
rollback. Reversible actions (attach) also reconcile *off* on `leave`/detach.

## Context

[LLP 0031](./0031-layered-config.decision.md) split config into an
authoritative **central layer** and an additive **local layer**, and its
[§Status provenance](./0031-layered-config.decision.md#status-provenance) made
"what's running" legible. But it explicitly parked one thing
([§Open questions](./0031-layered-config.decision.md#open-questions--deferred)):

> **Central-managed client attach semantics** — `attach` also performs
> machine-side effects (`ANTHROPIC_BASE_URL`, hooks) independent of config; when
> the gateway is centrally managed these may be redundant or conflicting.
> Warn-and-write covers the config layer; the side-effect interaction is a noted
> follow-up.

The apply engine ([LLP 0025 §apply engine is kernel surface](./0025-remote-config-join-flow.spec.md#apply-engine-is-kernel-surface))
is deliberately narrow: shape-check → install pinned plugins → validate →
persist last-known-good → swap → restart. It **never touches client files**
([LLP 0031 §Local-layer writers](./0031-layered-config.decision.md#local-layer-writers)
notes attach's machine effects are why attach stays a manual local step), and it
has no notion of "do something once and remember you did." Backfill-on-join
needs exactly that: a run-once effect gated on a completion marker, not a
component the apply engine starts and stops.

A second feature wanting the same shape is the signal to build the seam once
rather than special-case each. Both are **idempotent machine effects requested
by central config**; the differences (reversible vs run-once, what state they
key on) are parameters of one pattern.

## Options considered

1. **Extend the apply engine to perform side effects inline.** Rejected. The
   apply engine is the rollback-critical path — "exactly the code that must not
   be discovered broken in production"
   ([LLP 0025](./0025-remote-config-join-flow.spec.md#apply-engine-is-kernel-surface)).
   Folding file edits and subprocess spawns into it couples an irreversible
   machine effect to a config swap that may itself roll back, and a slow effect
   (a large backfill) would wedge the staged restart.

2. **A bespoke hook per feature.** Rejected. Two near-identical
   "run-once-and-remember" / "reconcile-on-config" mechanisms drift; each
   reinvents the completion marker, the failure-isolation rule, and the status
   surface. The cost of the abstraction is one document and one reconciler; the
   cost of not having it is paid twice and compounds with the third instance.

3. **A single daemon-side action reconciler (chosen).** A small kernel
   component, separate from the apply engine, that runs **after** a config is
   confirmed and reconciles the machine's *action state* against the action
   requests the effective config names. Each action type registers how to
   detect "already done", how to perform it, and (if reversible) how to undo it.

## Decision

Add a **central-config-driven action reconciler** to the daemon with the
following contract. The reconciler is kernel surface (it pairs with
kernel-managed state and must run independently of any plugin functioning —
the same rationale as the apply engine and probation timer in
[LLP 0025](./0025-remote-config-join-flow.spec.md#apply-engine-is-kernel-surface)).

### Where actions are declared

Action requests live in the **central layer** and are therefore
**authoritative/locked** under [LLP 0031](./0031-layered-config.decision.md#merge-model):
a user cannot remove or override an operator-mandated action from their local
layer. Each instance reuses **existing** config surface rather than inventing a
generic `actions[]` schema — backfill rides each source plugin's own
`config.backfill` ([LLP 0037](./0037-backfill-on-join.decision.md)), attach the
entries the config already names (#126) — so the locking falls out of the
sections LLP 0031 already governs (`plugins[]`), with no new merge rule. The
seam is in the *reconciler*, not a new config section. A non-joined host has no
central layer, so the reconciler is a no-op there and these features remain
manual local commands.

### When the reconciler runs

- **After a config is confirmed, never mid-apply.** An action fires only once
  the applied central config has cleared
  [probation](./0025-remote-config-join-flow.spec.md#post-apply-probation)
  (first successful authenticated poll after the staged restart). This prevents
  performing an irreversible effect for a config that is about to roll back.
- **At boot, after activation, and on config change.** The reconciler is
  level-triggered: it compares desired (config) against actual (recorded state)
  every time it runs and acts only on the difference, so a missed run is
  recovered on the next one. It must not run on plain CLI boots — like the
  apply engine, it is daemon-only (`ctx.configControl` undefined ⇒ no
  reconciler), so `hyp status` never performs machine effects as a side effect.

### Idempotency and completion state

Every action is **idempotent** and gated on a **completion/health marker in
kernel-managed state** ([LLP 0004 state directories](./0004-activation-and-paths.spec.md#state-directories)),
not in any plugin's state dir. Two flavours:

- **Run-once** (backfill): the marker records that the effect completed for a
  given request key, and the action is skipped forever after — even though the
  underlying command is independently idempotent (`hyp backfill` `part_id`
  dedupe), the marker is what makes it *cheap* on every subsequent boot rather
  than re-scanning history each time.
- **Reconciled / reversible** (attach): the marker records the current applied
  state; the reconciler drives it toward the config's desired state, applying
  the effect when the config names it and **reversing it on `leave`/detach**
  when the config no longer does.

The request key must capture the inputs that should re-trigger the action when
they change (e.g. an operator adding a provider to the `backfill` block) — see
[Open questions](#open-questions).

### Failure is surfaced, not fatal

An action that fails (file not writable, `hyp backfill` non-zero, transcript
dir missing) **does not** roll back the central config and **does not** flip
`overall` to `degraded` — the gateway is functioning on a valid config; a
machine-effect failure is operational, not a config malfunction. This mirrors
[LLP 0031](./0031-layered-config.decision.md#central-layer-is-sacrosanct)'s
treatment of a dropped local entry: loud (its own status line + a structured
log) but not an outage signal. The marker is **not** advanced on failure, so the
reconciler retries on the next run. A `client_action` status section reports per
action: requested / applied / failed, with reason and last attempt.

### Execution isolation

An action whose work is unbounded or heavy (importing history) runs as a
**subprocess** (`hyp backfill …`), never inline on the daemon tick — a long
import must not be able to wedge the tick loop or grow daemon heap (cf. the
"parquet encoder can't run in the daemon" hazard). Light, bounded effects (a
settings-file edit) may run in-process. Each instance states which it is.

### Consent

Consent stakes differ by what the effect *touches*, so the instances land on
different defaults rather than one global gate:

- **Backfill (resolved).** It reads the user's **own** history into the user's
  **own** cache, then forwards to the server the machine **already joined** — a
  narrow blast radius. It is therefore **default-on** when a backfill-capable
  adapter is enabled ([LLP 0037 §Default](./0037-backfill-on-join.decision.md#default-opt-out-default-on)),
  and there is **no per-machine opt-out**: the policy is locked with the central
  plugin entry, so suppressing it on a given machine is an operator *scoping*
  decision, not a local override (consistent with
  [LLP 0031](./0031-layered-config.decision.md#merge-model)).
- **Attach (open).** Auto-editing a user-owned file (`~/.claude/settings.json`)
  from server config escalates what "join" means — a higher bar than reading
  one's own history. Whether `join` implies consent to those writes, or requires
  an explicit acknowledgement, is left open for the attach instance — see
  [Open questions](#open-questions).

## The two instances

| Instance | Issue/Doc | Flavour | Effect | Reverses on leave? | Execution |
|---|---|---|---|---|---|
| **Backfill on join** | [LLP 0037](./0037-backfill-on-join.decision.md) | Run-once | Import pre-join history into the cache → forward sink → server | No (data stays) | Subprocess |
| **Client attach** | [#126](https://github.com/hyparam/hypaware/issues/126) | Reconciled / reversible | Edit `~/.claude/settings.json` / Codex `config.toml` | Yes (detach) | In-process |

Backfill lands first ([LLP 0037](./0037-backfill-on-join.decision.md)) and
exercises the run-once path; client attach is a follow-up that adds the
reversible path and the consent gate, at which point its config-layer half
(already covered by [LLP 0031](./0031-layered-config.decision.md#local-layer-writers)'s
warn-and-write) and its machine-effect half meet under this seam.

## Consequences

- **LLP 0031's open question is resolved in principle**: central-managed attach
  is an instance of this seam, not a one-off. The 0031 §Open-questions entry is
  amended to point here (this document supersedes that paragraph's "noted
  follow-up" status; the concrete attach reconciler remains future work).
- **A new kernel component** (the action reconciler) joins the apply engine and
  probation timer as daemon-only, kernel-managed-state-backed machinery. It is
  testable without HTTP and without performing real effects (the
  detect/perform/reverse functions are injectable).
- **`hyp status` gains a `client_action` section** — provenance for effects the
  fleet drove on this machine, consistent with
  [LLP 0031 §Status provenance](./0031-layered-config.decision.md#status-provenance).
- **Join does more than before.** Documented in
  [LLP 0011](./0011-setup-and-onboarding.decision.md): a joined machine may now
  self-attach and self-backfill, subject to the consent gate.

## Open questions

- **Attach consent gate.** Resolved for backfill (default-on, no local opt-out —
  above); still open for attach: does `join` imply consent to machine-file edits,
  or require an explicit acknowledgement? Settle when the attach instance is
  designed, with onboarding ([LLP 0011](./0011-setup-and-onboarding.decision.md)).
- **Auto re-trigger of run-once actions.** v1 backfill is strict run-once: a
  boolean per-(machine, provider) marker, no automatic re-run when policy widens
  ([LLP 0037](./0037-backfill-on-join.decision.md#completion-marker-run-once-no-auto-re-trigger-v1)) —
  manual `hyp backfill` is the re-run path. A later refinement could key the
  marker on a high-water input (e.g. the widest `window_days` already imported)
  so a widened policy re-imports the new slice automatically, with `part_id`
  dedupe absorbing the overlap. Generalise only if a second run-once action wants
  the same.
- **Generic `actions[]` schema vs per-instance config.** Confirmed per-instance:
  backfill reuses each plugin's `config.backfill`, attach the entries the config
  already names — no unified action descriptor. Revisit only if a third or fourth
  instance appears that fits neither existing section.
- **Ordering relative to first ingest.** Should attach (start routing live
  traffic) and backfill (import history) order deterministically on a fresh
  join, or is the cache→forward path order-insensitive? Likely the latter, but
  state it once the attach instance is designed.

## References

- [LLP 0011](./0011-setup-and-onboarding.decision.md) — setup and onboarding
- [LLP 0025](./0025-remote-config-join-flow.spec.md) — remote config, apply, probation, rollback
- [LLP 0031](./0031-layered-config.decision.md) — layered config; the deferred attach open question
- [LLP 0037](./0037-backfill-on-join.decision.md) — backfill on join (first instance)
- [#126](https://github.com/hyparam/hypaware/issues/126) — config-driven client attach
