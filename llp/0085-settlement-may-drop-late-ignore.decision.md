# LLP 0085: Flush-time settlement may drop a late-resolved `ignore` row

**Type:** decision
**Status:** Active
**Systems:** Gateway, Cache, Plugins
**Generated-by:** neutral
**Author:** Phil / Claude
**Date:** 2026-07-07
**Related:** LLP 0027, LLP 0049, LLP 0050, LLP 0070, LLP 0083

> When a Claude exchange raced past the capture seam with `cwd = null` (the
> session-start hook record had not landed yet), the flush-time settlement
> enricher ([LLP 0027](./0027-cache-settlement.decision.md)) re-resolves its
> `cwd` from the now-present session context and, if the cwd resolves to a
> `.hypignore` `ignore`, **drops the row** — before partition write, before
> export. Settlement may now REMOVE a row, not only upgrade its identity. This
> is an accepted realization of the `.hypignore` `ignore` guarantee
> ([LLP 0049](./0049-hypignore-usage-policy.spec.md#requirements) R1 /
> [LLP 0050](./0050-ignore-enforced-in-adapters.decision.md)): enforcement is
> the capture seam **or** a flush-time settlement-drop, when cwd was unknown at
> capture.

## Context

The `.hypignore` capture-seam drop matches an exchange to a scope by its `cwd`
([LLP 0049 §scope](./0049-hypignore-usage-policy.spec.md#scope)) and lives in
the client adapter, the only place that resolves a `cwd`
([LLP 0050](./0050-ignore-enforced-in-adapters.decision.md)). For Claude, the
`cwd` comes from the hook-written `session-context.jsonl` sidecar that the live
projector reads at projection time.

The **session-start race** ([issue #258](https://github.com/hyparam/hypaware/issues/258)):
the first exchange(s) of a Claude session can be projected *before* the
session-context hook record lands, so the row is written with `cwd = null`, the
projector's policy check is skipped (`const policy = cwd ? resolver.resolve(cwd) : null`,
failing **open**), and the row is never revisited. A `.hypignore` therefore
could not protect a session's opening exchanges — often the rows carrying the
user's full prompt — and those rows also stayed permanently unenriched
(`cwd`/`git_branch`/`repo_root` null), degrading folder attribution. This is the
sibling of [LLP 0083](./0083-codex-live-cwd-from-rollout.decision.md) (Codex
subscription-route cwd blindness): same fail-open seam, different cause — there
the wire never carries a cwd; here the sidecar carries it but loses a race.

Shrinking the window at the source (write `cwd` before the hook's git
subprocesses run) helps but **cannot close it**: hook latency remains, and some
Claude traffic (SDK/headless sessions) never gets a hook record at all. So a
backstop is needed at flush, where the sidecar record is reliably present.

That backstop raised a boundary question the fix was gated on: **may a
flush-time settlement enricher ([LLP 0027](./0027-cache-settlement.decision.md))
REMOVE a row, and does a flush-time drop honor the `ignore` guarantee (`never
enters the cache`, [LLP 0049 R1](./0049-hypignore-usage-policy.spec.md#requirements) /
[LLP 0050](./0050-ignore-enforced-in-adapters.decision.md)) rather than being an
after-the-fact purge?** Guessing it wrong risks either a data leak (rows that
should drop are kept) or an unauthorized purge (rows removed after they were
already durably captured).

## Decision

**Yes — flush-time settlement MAY drop a late-resolved `ignore` row, and that
drop honors the `.hypignore` `ignore` guarantee for the race case.**

The change set has two layers:

- **Part (a) — shrink the window at the source.** The Claude hook
  (`claude/src/hook_command.js`) appends a minimal `{session_id, cwd, ts}`
  record **immediately** (cwd is in hand from stdin, and is the only field the
  policy check needs), then runs the two git subprocesses and appends a second
  enriched record. `pickLatestMatching` prefers the latest record, so the
  enriched one wins once it lands. The window collapses from "hook latency + 2
  git execs" to ~one file append. Do-regardless; necessary but not sufficient.

- **Part (b) — settlement backstop.** The Claude settlement enricher
  (`claude/src/settle.js`) gives a **null-cwd** row a second look at flush:
  re-read the session context (now present), and
  - cwd resolves to `ignore` → **DROP** the row (emit a structured
    `usage_policy_drop` event with a hashed cwd);
  - cwd resolves to `local-only` / `full` → **ENRICH** the row (fill
    `cwd`/`git_branch`/`repo_root`); do not drop;
  - context still absent (SDK/headless) → **settle unchanged** (no drop, no
    crash).

  The `settleBatch` contract is extended so an enricher can REMOVE a row: the
  enricher returns the `USAGE_POLICY_DROP` sentinel
  (`src/core/usage-policy/drop.js`) at the row's position, and the flush
  dispatcher (`ai-gateway/src/dataset.js`) filters those rows out of the batch
  it commits. Datasets without a `settleBatch` are unaffected; a null-cwd row is
  now selected into the settle pass even when it is not a gateway fallback (its
  transcript identity landed but the sidecar record raced).

The drop is honored **only at flush** (`settleBatch`), before partition write
and before export. The maintenance re-settle sweep (`resettleBatch`) does **not**
drop: its rows are already committed, so a drop there would be an after-the-fact
purge, which this decision does not authorize.

### Why this honors the guarantee

For a row that raced past the capture seam with `cwd = null`, a strict "never
enters the cache" is physically unattainable without a fail-closed hold — which
is rejected, because it would drop legitimate SDK/headless traffic that never
gets a hook record. Allowing settlement to drop the row at flush — **before
partition write, before export** — makes the leak **bounded-until-flush (~2
min)** and guarantees the row is **never written to a durable/queryable
partition and never forwarded to a sink**, which is the outcome that actually
matters for privacy. The literal "never enters the cache" is honestly relaxed to
"never persisted or exported past flush" for the race case.

### Drop telemetry {#telemetry}

The settlement drop emits `plugin.claude.usage_policy_drop` with
`policy_source: 'settlement_late_resolve'`, the `session_id`, and a **hashed**
`cwd` (`cwd_hash`, never a raw local path — mirroring the export-drop aggregate,
[LLP 0080 #telemetry](./0080-local-only-dir-selection.design.md)). This
distinguishes it from the projector's capture-seam drop and makes the
bounded-until-flush leak observable and countable.

## Why not the alternatives

- **Fail-closed hold** (block projection until the context arrives). Rejected:
  some Claude traffic (SDK/headless) never gets a hook record, so a hard wait
  either drops real data or reintroduces fail-open after a timeout — complexity
  without closing the hole the backstop closes anyway.
- **Part (a) alone.** Shrinks the window to ~one file append but cannot close it
  (hook latency; SDK sessions with no hook). Shipped, but insufficient on its
  own.
- **Compaction-time drop** (`resettleBatch`). Rejected as the enforcement seam:
  those rows are already committed/persisted, so dropping them is a *purge*, not
  a capture-seam drop. [LLP 0049](./0049-hypignore-usage-policy.spec.md#prospective-only)'s
  prospective-only / no-purge stance stands; `hyp backfill` re-import (which
  reads cwd per session) is the path to re-apply the policy to already-committed
  history.

## Consequences

- Code that lands this carries `@ref LLP 0085 [implements]` on the settlement
  backstop (`claude/src/settle.js` cwd late-resolution + drop), the `settleBatch`
  removal mechanism (`ai-gateway/src/dataset.js`), and the hook reorder
  (`claude/src/hook_command.js`).
- Amends the enforcement story of [LLP 0027](./0027-cache-settlement.decision.md)
  (settlement may now REMOVE a row, not only transform its identity),
  [LLP 0049 R1](./0049-hypignore-usage-policy.spec.md#requirements), and
  [LLP 0050](./0050-ignore-enforced-in-adapters.decision.md) (the `ignore`
  guarantee is the capture seam **or** a flush-time settlement-drop when cwd was
  unknown at capture). Those docs carry a forward-ref to this one; nothing they
  *decided* changes.
- A now-known cwd that resolves to `local-only` is enriched (not dropped); the
  filled cwd re-arms the [LLP 0070](./0070-local-only-export-seam.decision.md)
  export-seam withholding that a null cwd bypassed, and fixes the "opening
  exchanges stay unenriched" attribution gap in the same pass.
- **Prospective from flush.** Rows already written to a durable partition with
  `cwd = NULL` are untouched; a `hyp backfill` re-import is the path to re-apply
  the policy to history (same as [LLP 0083](./0083-codex-live-cwd-from-rollout.decision.md)).

## References

- [Issue #258](https://github.com/hyparam/hypaware/issues/258) — the race, and the repo-owner decision comment that unblocked this.
- [LLP 0027](./0027-cache-settlement.decision.md) — flush-time identity settlement (the machinery extended here).
- [LLP 0049](./0049-hypignore-usage-policy.spec.md) / [LLP 0050](./0050-ignore-enforced-in-adapters.decision.md) — the `.hypignore` usage policy and its adapter-seam enforcement.
- [LLP 0083](./0083-codex-live-cwd-from-rollout.decision.md) — the Codex sibling of the same fail-open seam.
