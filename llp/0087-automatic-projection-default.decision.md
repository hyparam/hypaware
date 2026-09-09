# LLP 0087: automatic projection is the default

**Type:** decision
**Status:** Draft
**Systems:** Graph, Daemon
**Author:** Phil / Claude
**Date:** 2026-07-07
**Related:** LLP 0086, LLP 0023, LLP 0013, LLP 0017, LLP 0088, LLP 0089

> Supersedes [LLP 0023 §on-demand-projection](./0023-context-graph-projection.decision.md#on-demand-projection).
> The rest of LLP 0023 stands.

## Decision

The running daemon projects the activity graph automatically, on by default. The
on-demand-only stance of LLP 0023 is no longer the default. Automatic projection
is opt-out through config ([LLP 0086 R3](./0086-automatic-derivation.spec.md#requirements)),
not opt-in.

## Why the original default no longer holds

LLP 0023 chose on-demand-only for two reasons, both now weaker:

1. *"There is no snapshot/commit hook in the kernel to chain from."* True, but a
   commit hook was never required. Eventual freshness is acceptable for an
   activity graph ([LLP 0086 R5](./0086-automatic-derivation.spec.md#requirements)),
   and a scheduled tick needs no such hook
   ([LLP 0088](./0088-scheduled-daemon-tick.decision.md)).
2. *"Registering the command keeps the plugin out of the daemon loop entirely;
   nothing here can block or OOM the daemon."* The daemon already hosts bounded
   background work safely: the cache-maintenance loop
   ([LLP 0013](./0013-local-query-cache.decision.md) / [LLP 0017](./0017-daemon-runtime.decision.md))
   is default-on, interval-driven, budget-capped, single-flight, and
   error-isolated. So "in the daemon loop" is no longer synonymous with "can block
   or OOM it." The same guards make projection safe in-loop
   ([LLP 0089](./0089-bounded-isolated-derivation.decision.md)).

With both premises addressable, the user-facing cost of on-demand-only decides it:
a graph that is silently stale until someone re-projects is a worse default than a
graph the daemon keeps fresh within a bounded interval.

## Scope of the supersession

This decision replaces only the *default trigger* of LLP 0023. Everything else in
LLP 0023 is unchanged and is load-bearing here: content-addressed ids, the merge
policy, and pre-write dedup are exactly what make repeated automatic projection
idempotent ([LLP 0086 R6](./0086-automatic-derivation.spec.md#requirements)). The
manual `hyp graph project` / `hyp graph compact` commands also stay
([LLP 0086 R9](./0086-automatic-derivation.spec.md#requirements)); automatic
projection is additive, not a replacement.
