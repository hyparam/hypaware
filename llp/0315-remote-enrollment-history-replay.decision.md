# LLP 0315: Remote enrollment replays retained eligible history

**Type:** Decision
**Status:** Draft
**Systems:** CLI, Onboarding, Sinks, Cache, Usage-Policy
**Author:** Phil / Codex
**Date:** 2026-08-25
**Related:** LLP 0031, LLP 0039, LLP 0040, LLP 0063, LLP 0070, LLP 0132, LLP 0188, LLP 0305, LLP 0307; hypaware-server LLP 0184 (out of tree)

> A machine that starts with local-only capture and later enrolls with a remote
> destination forwards all retained, sync-eligible history to that destination.
> Export progress belongs to the destination, not merely to the local sink
> instance name. Reconnecting to the same destination resumes its prior
> progress; enrolling with another destination starts that destination from the
> beginning of retained eligible history.

## Context

Every source writes to the local cache before any sink sees its rows. A user can
therefore collect useful history for days or weeks before running `hyp remote
login`, `hyp join`, or selecting remote sync in setup.

Legacy central signals already replay cache rows when their sink instance has no
watermark. Eligible open datasets do not: LLP 0305 and LLP 0307 establish a
fresh baseline for partitions that predate the rollout of open-dataset
forwarding. That rollout rule also runs when a central sink is first created,
so it mistakes a user's first remote enrollment for a software rollout and
withholds their existing open-dataset history.

Progress is also scoped only by sink instance name. `hyp leave` removes the
central layer and remote identity but keeps sink-instance watermarks and rollout
manifests. A later enrollment normally creates another sink named `central`, so
a different server can inherit the previous server's cursors and skip retained
history for both legacy signals and open datasets.

## Decision

### A new destination receives retained eligible history {#new-destination-replay}

When a machine gains a remote destination that has no export progress of its
own, the first released sync starts every eligible base dataset at sequence
zero. This includes rows captured before enrollment and rows captured during
the first-sync hold. The ordinary shared export seam still applies current
usage policy row by row, so `local-only` rows and sources selected through the
current client opt-out remain withheld and advance progress without leaving
the machine. Datasets that cannot pass the shared privacy seam safely remain
ineligible.

A different destination receives all retained eligible history even when some
of those rows were previously sent to another destination. A reconnect to the
same destination resumes that destination's existing progress and sends only
rows beyond its successful watermark.

This rule applies equally to attended enrollment through `hyp remote login`,
unattended enrollment through `hyp join`, and the setup flow that delegates to
remote login. Those entrypoints must not produce different first-sync history.

### Software rollout remains distinct from enrollment {#rollout-distinction}

LLP 0305 and LLP 0307's fresh baseline still applies when an already-enrolled
destination gains support for an open dataset during a client software
upgrade. That case can overlap a prior capture lane, so replaying all local
history could duplicate data the same destination already received.

The implementation must therefore distinguish destination enrollment from a
dataset becoming newly forwardable for an existing destination. The presence
of a sink-instance directory alone is not enough: sink state can survive
`hyp leave`, and a constructor can create directories before it knows which
case it is handling.

### Destination identity is server origin plus organization {#destination-identity}

The stable destination identity is the tuple of the central server's URL
origin and its stable organization identifier. Neither the local sink instance
name nor the gateway credential identifies the destination.

A credential refresh, browser re-login, or gateway credential replacement
inside the same server organization preserves export progress. Enrollment into
another organization starts separate progress and replays retained eligible
history, including when both organizations are hosted at the same URL origin.
The origin remains part of the key so equal organization identifiers issued by
different servers cannot collide.

Both attended login and bootstrap-token enrollment must receive the same stable
organization identifier from the server. The client persists only the
identifier needed to scope export state; credential values and gateway IDs
remain outside that key.

### Existing state is adopted once; new state records its replay phase {#state-migration}

The first destination-aware release treats an unbound sink-instance state
directory with existing watermarks or rollout manifests as progress for the
currently authenticated destination. It atomically binds that directory to the
current origin and organization and marks it ready. This is the compatibility
path for already-enrolled machines: their acknowledged rows do not replay after
upgrade. The migration is intentionally one-way; another destination receives a
separate deterministic state scope.

An unbound directory with no progress is a new destination. Before it writes any
watermark or rollout manifest, the sink atomically records the destination in an
`initializing-history` phase. Open-dataset rollout initialization starts its
existing partitions at sequence zero, then the destination becomes `ready`.
A crash before readiness resumes the retained-history mode. Once ready, a
dataset that becomes newly forwardable uses LLP 0305 and LLP 0307's fresh
software-rollout baseline.

This one-time adoption relies on the confirmed field state: existing users have
not changed organizations. If that assumption were false, an old unscoped
directory could not be assigned automatically without either replay or skip
risk, and would require an operator choice.

### Organization identity is required before export state opens {#identity-compatibility}

New bootstrap and gateway-refresh responses must carry the server-assigned
organization. Attended authorization-code login already carries the same value,
and writes it beside the login-minted gateway credential.

A persisted identity from an older client may lack the organization. The sink
forces one authenticated refresh before selecting a destination state scope and
persists the returned value. An older server that still omits it cannot start an
updated central sink; the client refuses rather than infer tenant identity from
an unverified JWT or reuse unscoped progress ambiguously. This is why the server
response extension ships first. A later refresh that returns a different
organization is also refused: changing destination requires a deliberate new
enrollment and its separate state scope.

## Consequences

- Local-first users can opt into remote sync later without silently losing the
  retained portion of eligible base logs.
- Switching destinations does not inherit another destination's watermarks or
  rollout manifests.
- Re-login and re-enrollment to the same destination do not replay already
  acknowledged rows.
- Existing `local-only`, client opt-out, and ineligible-dataset privacy rules
  remain unchanged.
- Retention remains the physical upper bound. Rows already removed from the
  local cache cannot be reconstructed or synced.

## Alternatives considered

- **Keep progress scoped only by sink instance name.** Rejected because a new
  server can inherit another server's cursors after `hyp leave` and skip data.
- **Always clear progress on enrollment.** Rejected because re-login to the same
  destination would replay already acknowledged history.
- **Apply the open-dataset fresh baseline to every new sink.** Rejected because
  it treats the user's first remote enrollment as a software rollout and skips
  exactly the retained history the user chose to sync.
