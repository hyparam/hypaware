# LLP 0125: the Node engines floor moves to 22.12

**Type:** Decision
**Status:** Draft
**Systems:** Core, Plugins
**Author:** Phil / Claude
**Date:** 2026-07-20
**Related:** LLP 0008, LLP 0118, LLP 0119, LLP 0122

> The package `engines` floor rises from `>=20` to `>=22.12`, and CI pins a
> `setup-node` matrix of 22 and 24. Builtin modules present in Node 22.x
> (notably `node:sqlite`) become fair game for core and bundled plugins.

## Context

The hermes adapter ([LLP 0119](./0119-hermes-pull-from-state-db.decision.md))
needs a SQLite reader, and `node:sqlite` is the only option compatible with
the no-runtime-deps rule ([LLP 0008](./0008-plugin-runtime-dependencies.decision.md))
at zero bundled bytes. It exists flag-free from Node 22.5 and is stable in
Node 24. The repo's `engines` said `>=20`.

The original design sketch proposed gate-and-degrade: probe for the builtin
and run the hermes source in a supported `degraded` mode on older Node.
Checking ground truth dissolved the dilemma:

- **Node 20 reached end-of-life on 2026-04-30.** The `>=20` floor was
  already a stale claim, hermes or no hermes.
- CI does not pin Node at all (no `setup-node`; the runner default is
  already >= 22), so `>=20` was never actually exercised.
- Development machines run Node 24.

## Decision

**Bump `engines` to `>=22.12`** (Node 22.x is maintenance LTS until April
2027), and **pin CI to a Node 22 + 24 matrix** so the floor is tested rather
than implied.

Gate-and-degrade is rejected: a permanently maintained fallback mode whose
only beneficiaries run an EOL runtime is pure liability. What remains is a
cheap activation probe that turns a missing builtin into a clear refusal
message ("hermes source requires Node >= 22.12") instead of a crash, for
users who ignore engines warnings. That is an error path, not a supported
mode.

## Consequences

- The published package's support claim narrows to non-EOL Node. Semver:
  land with a minor/major bump per the release conventions in effect.
- [LLP 0122](./0122-hermes-log-forwarding.design.md#sqlite) drops its
  gate-and-degrade framing and its open question 1; the hermes reader
  assumes `node:sqlite`.
- Future core or bundled-plugin code may rely on any builtin present in
  Node 22.12 without re-litigating this.
- The engines and CI edits ride the first hermes implementation PR
  ([LLP 0123](./0123-hermes-log-forwarding.plan.md) T1).
