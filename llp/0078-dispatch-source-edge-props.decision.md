# LLP 0078: `dispatch_source` = per-surface boolean edge props, unioned by `mergeRow`

**Type:** decision
**Status:** Accepted
**Systems:** Plugins
**Generated-by:** neutral
**Date:** 2026-07-06
**Related:** LLP 0073, LLP 0074, LLP 0075, LLP 0023

> [Issue #229](https://github.com/hyparam/hypaware/issues/229) wants a
> `dispatch_source` so the graph doesn't lose "user typed `/x`" vs "model
> chose x" vs "shell-read". This decision settles its representation: **one
> boolean prop per derivation surface on the `ran` edge**, not an enum, not
> extra edge types — and the small additive kit change it requires.

## Decision

`Session -ran-> Skill` edges carry up to four boolean props, each stamped only
by its own derivation rule:

| prop | meaning |
|---|---|
| `dispatch_tool` | model-chosen: Claude `Skill` tool call |
| `dispatch_slash` | user-typed: `<command-name>` slash invocation |
| `dispatch_marker` | SKILL.md injection seen; alone ⇒ prompt-driven/ambiguous |
| `dispatch_shell_read` | Codex `exec_command` read of the SKILL.md |

To carry them, `contract-kit.js buildEdge` gains optional `EdgeSpec.props`,
mirrored byte-for-byte on `buildNode`'s handling (empty → `null`); `EdgeSpec`
widens in `context-graph/src/types.d.ts` and the connector's structural twin.
Edge ids hash `(src, type, dst)` only, so **no committed id changes**; the
`edge` dataset already has a `props` column and `mergeRow` already merges
props generically — the kit was the only gap. The `hypaware.context-graph`
capability stays `1.0.0` (backward/forward-compatible widening).

## Why flags, not an enum {#why-flags}

Edge ids are content-addressed on `(src, type, dst)`, so *all* surfaces'
sightings of one (session, skill) pair collapse onto **one** edge and their
props merge. Under LLP 0023's order-independent merge policy, a single
`dispatch_source: <enum>` prop would resolve multi-surface sessions by
earliest-`first_seen`-wins — silently discarding the fact that a skill was
*both* slash-invoked and tool-invoked, and making the stored value an accident
of timestamps. Distinct boolean **keys** instead ride `mergeRow`'s props-key
**union**: the merged edge deterministically accumulates every surface that
fired, in any merge order.

## Rejected alternatives {#rejected}

- **Enum prop** — lossy under merge, as above.
- **Distinct edge types per surface** (`ran_via_slash`, …) — preserves the
  information but breaks #229's contract that one `edge_type = 'ran'` filter
  finds all skill runs, and quadruples the edge vocabulary for a qualifier.
- **Skill-node props** — dispatch is a property of the (session, skill)
  *pair*, not of the skill; node props would smear all sessions together.
- **`source_keys`** — that column is a first-sighting provenance exemplar
  (LLP 0023 §inline-provenance), not merged semantics; overloading it would
  make dispatch depend on which row happened to be seen first.

## Accepted limitation {#accepted-limitation}

The pre-write dedup (LLP 0023 §pre-write-dedup) skips rows whose id is already
committed, so a flag first sighted *after* the edge is committed never reaches
the stored row — identical to how committed node props behave today. Accepted
for an eventually-fresh activity graph; a full re-projection heals it. Not a
reason to invent per-edge versioning.
