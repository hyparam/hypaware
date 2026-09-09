# LLP 0089: bounded, isolated derivation execution

**Type:** decision
**Status:** Draft
**Systems:** Daemon
**Author:** Phil / Claude
**Date:** 2026-07-07
**Related:** LLP 0086, LLP 0087, LLP 0088, LLP 0023, LLP 0013, LLP 0017

> This decision is the answer to LLP 0023's objection that projecting from the
> daemon could block or OOM it. It names the guards that make automatic
> projection safe in-loop, and they are the guards the cache-maintenance loop
> already runs under.

## Decision

Every automatic derivation tick runs under four guards, matching the daemon's
cache-maintenance loop ([`runtime.js`](../src/core/daemon/runtime.js), the
`maintenance.tick` block):

1. **Time budget.** Each tick carries a `max_tick_ms`-style cap. A tick that
   reaches its budget yields and resumes next interval. Partial progress is safe
   because projection is idempotent: LLP 0023 content-addressed ids plus pre-write
   dedup mean an interrupted tick commits a correct prefix and the next tick picks
   up the remainder with no double-write.
2. **Single-flight.** A new tick never starts while one is in flight (mirrors the
   maintenance loop's `maintenanceInFlight` skip). Overruns coalesce instead of
   piling up.
3. **Error isolation.** The tick runs in its own span with catch-and-log (mirrors
   `daemon.maintenance_failed`). A derivation failure degrades freshness only; it
   never propagates into the daemon or the capture path.
4. **Non-blocking lifecycle.** The interval timer is `unref()`'d so it never holds
   the process open, and shutdown drains any in-flight tick before exit (mirrors
   the maintenance handle's clear-and-await on shutdown).

## Escape hatch for heap-heavy derivations

In-process budgeting caps wall-time but not peak heap. If a derivation is heavy
enough that a single tick's peak memory threatens the daemon (the parquet-encoder
failure mode), that derivation may declare **subprocess execution**; the seam
supports it ([LLP 0090](./0090-general-derivation-seam.decision.md)). In-process is
the default because the T0 projection is deterministic cache I/O, not that.

## The growing-scan follow-on

LLP 0023's projection re-scans all source rows each run and filters against the
committed id set (pre-write dedup). Under a periodic tick that scan grows with
history. The time budget caps each tick regardless, so this is a cost concern, not
a correctness one. The efficient fix, **incremental projection** (advance a
per-source cursor and project only newly-settled rows), is a follow-on named in
[LLP 0091](./0091-automatic-derivation.design.md), not required for this slice
because budget plus idempotence already make repeated full re-scan safe.
