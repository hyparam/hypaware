# LLP 0076: derive skill activation at projection now; capture-side `skill_activated` is the future fix

**Type:** decision
**Status:** Accepted
**Systems:** Plugins, Sources, Gateway
**Generated-by:** neutral
**Date:** 2026-07-06
**Related:** LLP 0073, LLP 0074, LLP 0075, LLP 0023

> [Issue #229](https://github.com/hyparam/hypaware/issues/229)'s Direction
> names two horizons: deterministic per-client derivation now, and "longer
> term the honest fix is capture-side: a normalized `skill_activated` event
> (and the availability roster) recorded at the gateway/hook, so the graph
> stops reverse-engineering activation from each client's prose." This
> decision settles that scope boundary for the LLP 0073 change set.

## Decision

**Build the projection-time derivation now** (LLP 0074/0075 rules inside the
existing `ai-gateway-graph` contract). **Do not** touch the gateway, the
client adapters, or the hooks in this change set — no new capture event, no
schema column, no roster capture. The capture-side `skill_activated` event is
**recorded as the honest future fix**, not designed here; when it arrives it
needs its own request/design (it is a gateway-schema and adapter change with
its own blast radius).

## Why derive-first {#why-derive-first}

- **History only exists as prose.** Every already-recorded session can only
  ever be mined by derivation — a capture event starts counting at its ship
  date. The derivation rules are needed *regardless* of the capture event, so
  building them first gets #229's queries working over the full corpus
  immediately.
- **Blast radius.** The derivation is confined to one connector's contract
  rules and pure helpers — reviewable, testable, reversible (drop the rows).
  A capture event touches the gateway message schema (LLP 0016 ownership),
  both adapters, and possibly the hook — the expensive layer to churn.
- **Rejected: capture-first.** Waiting for the event blocks a cheap graph win
  on an expensive schema change and still leaves history dark.

## The boundary in practice {#boundary}

When `skill_activated` lands, it feeds the **same `Skill` node and `ran`
edge** via new contract rules (same natural key, so the nodes converge by
construction — LLP 0023 §content-addressed-ids); the event's dispatch
information supersedes the inferred flags for new rows. The derivation rules
of LLP 0074/0075 then remain as the **backfill path for pre-event history**
and are retired only if that history is ever re-keyed away. Nothing in the
LLP 0073 design may assume it can later *change* what the derivation minted —
committed rows are content-addressed and immutable; the future event adds, it
does not rewrite.

Known gaps this boundary deliberately leaves open (from the issue): the
"available but not used" denominator for Claude is not reconstructable from
recorded prose (Codex's roster could support it later, LLP 0075
§rejected-roster); marker-wording drift can silently degrade the Claude
signal until the event exists. Both are accepted costs of shipping the
deterministic derivation now.
