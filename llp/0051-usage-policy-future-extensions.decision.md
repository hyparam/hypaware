# LLP 0051: usage-policy future extensions — local-only and session opt-out

**Type:** Decision
**Status:** Draft
**Systems:** Gateway, Sinks, Plugins
**Author:** Phil / Claude
**Date:** 2026-06-29
**Related:** LLP 0014, LLP 0029, LLP 0030, LLP 0039, LLP 0049, LLP 0050, LLP 0066

> Two capabilities deliberately **out of V1 scope** for the hypignore mechanism
> ([LLP 0049](./0049-hypignore-usage-policy.spec.md)), captured so the V1 design
> stays forward-compatible with them: the `local-only` usage class, and the
> ephemeral per-session opt-out. This document records *that they are deferred*
> and *the seam each will use*, not a commitment to build them.
>
> **Update (2026-07-03):** the ephemeral per-session opt-out has since been
> promoted to its own spec, [LLP 0066](./0066-session-opt-out.spec.md); this
> document retains it only as historical context ([§session-opt-out](#session-opt-out)).
> `local-only` remains deferred.

## Why this is written now

V1 ships one class (`ignore`) and one mechanism (folder `.hypignore`). Recording
the deferred designs up front is what lets V1 avoid choices that would later
require a repaint — chiefly the file-format
[fail-safe](./0049-hypignore-usage-policy.spec.md#fail-safe) and the single
shared matcher ([LLP 0050](./0050-ignore-enforced-in-adapters.decision.md)).

## Deferred 1: the `local-only` class {#local-only}

**Intent.** A scope marked `local-only` is recorded into the local cache (so it
is queryable locally) but is **never exported or forwarded** — sinks, central
forward, and S3/Iceberg export all skip it.

**Seam.** Unlike `ignore` (capture seam), `local-only` is enforced at the
**export seam**: the row enters the cache normally, and the export driver filters
it out before forming a batch for any sink
([LLP 0014](./0014-sinks.spec.md) — sinks receive "ready cache partitions").

**Why it is bigger than `ignore`, hence deferred.** It requires:

- a **persistent marker** on cached rows that survives restart — an additive
  cache-schema column ([LLP 0029](./0029-additive-cache-schema-evolution.decision.md));
- a new **filter in the export driver** that every sink path honors (blob
  sinks, `@hypaware/central`, incremental sink reads
  [LLP 0039](./0039-incremental-sink-reads.spec.md));
- a decision on **granularity** — whether `local-only` is a per-row attribute or
  rides the session-id partition key ([LLP 0030](./0030-session-id-partition-key.decision.md)),
  since a scope typically maps to whole sessions/partitions.

**V1 forward-compat already in place.** `local-only` is a reserved class token
([LLP 0049](./0049-hypignore-usage-policy.spec.md#classes)); a V1 install that
encounters it resolves to `ignore` via the
[fail-safe](./0049-hypignore-usage-policy.spec.md#fail-safe), so no data marked
`local-only` is ever exported by a version that cannot honor the restriction.

## Promoted: ephemeral per-session opt-out {#session-opt-out}

**Promoted to [LLP 0066](./0066-session-opt-out.spec.md) on 2026-07-03.** The
authoritative spec for this mechanism now lives there; the notes below are the
original deferred sketch, kept for provenance.

**Intent.** "Don't record *this conversation*": a temporary, in-memory,
session-scoped drop that does not write a committable file and reverses when the
session ends. This is what the `hypaware-ignore` / `hypaware-unignore` skills
advertise (`POST` / `DELETE /_hypaware/ignore/session`), against an endpoint that
was never built.

**Why it is distinct from `.hypignore`.** It is a different product: *session*-
scoped and *ephemeral*, versus the folder `.hypignore` which is *directory*-scoped
and *persistent/committable* (it stops recording the whole tree for everyone).
Repointing the skills at `.hypignore` would over-broaden "ignore this session"
into "ignore this repo forever," so the session opt-out stays a separate
mechanism.

**Seam (refined in [LLP 0066](./0066-session-opt-out.spec.md#enforcement)).** The
original sketch put the whole thing in the gateway. LLP 0066 splits it: the
**control route + in-memory set** are gateway-resident (the gateway holds opaque
`session_id` strings it never interprets), but the **drop itself stays in the
client adapter projector**, keyed on the `session_id` the adapter already
resolves and returning the same `USAGE_POLICY_DROP` sentinel as the `.hypignore`
drop. That keeps [LLP 0050](./0050-ignore-enforced-in-adapters.decision.md)
intact rather than moving provider awareness into the gateway.

## Status

`local-only` ([§local-only](#local-only)) is **Draft / not scheduled**. The
ephemeral per-session opt-out ([§session-opt-out](#session-opt-out)) has been
**promoted to [LLP 0066](./0066-session-opt-out.spec.md)**. This document exists
today so V1's reviewers can confirm the V1 design does not foreclose either.
