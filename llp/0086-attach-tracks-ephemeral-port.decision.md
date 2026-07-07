# LLP 0086: Attach tracks the gateway's ephemeral port

**Type:** decision
**Status:** Active
**Systems:** Config, Daemon, Sources, Gateway, CLI
**Generated-by:** neutral
**Date:** 2026-07-07
**Related:** LLP 0016, LLP 0036, LLP 0041, LLP 0044, LLP 0045

> [Issue #277](https://github.com/hyparam/hypaware/issues/277) (a real user
> report): the daemon's gateway binds an **ephemeral** port by default
> (`DEFAULT_LISTEN = '127.0.0.1:0'`), so the port changes on every restart. That
> choice is fine. The defect is that the attach lifecycle ([LLP 0044](./0044-client-attach-on-join.decision.md)
> / [LLP 0045](./0045-client-attach.design.md)) was built as *attach once, done
> forever*: it never modeled a moving endpoint. Two gaps fell out of that, one
> root cause. **Gap 1** - standalone `hyp attach <client>` cannot resolve the
> daemon's live port on a default install: it tries in-process
> `localEndpoint()` (throws in a CLI boot), then `configuredGatewayEndpoint`
> (undefined, because `endpointFromListen` rejects port 0), then gives up -
> never reading the port the daemon persists to `status.json`. **Gap 2** -
> nothing re-attaches when the daemon rebinds: the boot reconcile pass is
> level-triggered on marker existence, a `done` attach marker short-circuits
> forever, and the marker records `settings_path`/`prev_value` but **not** the
> endpoint, so "attached, but at a stale endpoint" is unrepresentable. This
> decision extends the LLP 0045 model to track the moving port.

## Context

LLP 0045 §Part 1 established a sound invariant: auto-attach must **never** record
a base URL for a port nothing bound, so the daemon seam resolves the endpoint
from a proven-bound `localEndpoint()` only (no configured-`listen` fallback), and
the client seam is resolved once per boot. That closed the "write an unproven
URL" failure mode. It never closed the complement: **rewriting a proven URL when
the proven value changes.** An ephemeral gateway port changes on every restart,
so "the proven value changes" is the common case, not an edge.

The data to detect the drift already exists on disk: the gateway source's
`status()` returns `details: { host, port, ... }`, which `startConfiguredSources`
captures into each `SourceSnapshot.details` in `status.json`; and the client
settings marker records the `port` it attached at (`probeClientAttachFromDescriptor`
reads it back). Nothing compared them.

## Decision

### D1 - Endpoint-aware attach markers, re-attach on drift

<a id="endpoint-aware-markers"></a><a id="re-attach-on-drift"></a>The attach
handler's `done` marker records the **endpoint** it attached at
(`action_attach.js` `perform()` merges `endpoint` into the marker detail). The
generic reconciler gains one optional, provider-agnostic hook,
`ActionHandler.isCurrent(marker, action, ctx)`: for a still-desired action whose
marker is already `done`, the reconciler consults it, and a `false` result makes
the unit a **forward gap** that re-`perform()`s this pass instead of
short-circuiting. The reconciler stays ignorant of what "current" means (it never
learns about endpoints or Claude vs Codex, LLP 0036 / LLP 0041); the attach
handler owns the comparison: `marker.endpoint === ctx.endpoint`. Handlers with no
moving input (backfill) omit `isCurrent`, so a `done` marker stays permanently
done - the pre-0086 behavior, unchanged.

Two guards keep it from over-firing, both preserving the LLP 0045 §Part 1
invariant:

- **No live endpoint this pass** (`ctx.endpoint` undefined - the gateway never
  bound): `isCurrent` returns `true`, leaving the existing attach in place.
  Re-performing would only trip `perform()`'s missing-endpoint guard and churn
  the marker to `failed`; a later proven-bound pass re-evaluates. Auto-attach
  still never records a URL for a port nothing bound.
- **A pre-0086 marker with no recorded endpoint**: `undefined !== live` -> stale
  -> re-attach exactly once, which records the endpoint and makes every later
  pass current. Backward compatible by construction: an old marker never
  crashes, and self-heals on the first post-upgrade proven-bound pass. An
  `isCurrent` that throws is treated as *current* (skip), degrading to the
  pre-0086 level-triggered behavior rather than re-performing on a loop.

### D2 - Manual `hyp attach` reads the live port; already-attached validates it

<a id="endpoint-discovery"></a><a id="manual-attach-reads-the-live-port"></a>When
the in-process gateway is unbound and no `listen` is configured (the default
ephemeral-port, daemon-managed install), `hyp attach` no longer gives up. It
resolves the gateway's live base URL from `status.json`'s
`sources[].details.{host,port}` via `resolveLiveGatewayEndpointFromStatus`,
**guarded by a daemon-liveness check** (the pid file + `processIsAlive`): a
status snapshot outlives its daemon, so a bound port in it proves nothing without
a living process behind it. A dead-daemon snapshot yields `undefined` and the
command falls through to the existing actionable error, never attaching at a dead
port. Discovery reads the persisted port; it never guesses one.

<a id="already-attached-validates-the-live-port"></a>The "already attached"
branch now validates the **recorded** port against the **live** one instead of
trusting marker existence. Attached at the live port -> a genuine no-op success.
Attached at a stale port, or a live endpoint with no matching marker -> re-attach
at the live port (`client.attach` is idempotent and re-points the client). When
no live endpoint is discoverable (daemon not running) the pre-#271/#277 behavior
is preserved: a present marker is a no-op success, an absent one the actionable
"cannot resolve the gateway endpoint" error.

### D3 - `hyp status` surfaces the drift

<a id="status-drift-diagnostic"></a>`hyp status` emits a `client_attach_stale`
warning when a configured, attached client's recorded port differs from the live
gateway port (both already on disk: the client-settings marker port vs the
running daemon's `status.json` gateway-source port). It is **non-degrading**,
exactly like `client_attach_missing`: a healthy install can still drift after a
restart (LLP 0041 §failure-is-surfaced-not-fatal), so the diagnostic never flips
`overall`. This turns a silent capture stall into an actionable line with a
`hyp attach --client <name>` repair.

## Consequences

- The attach marker is now endpoint-aware. `ActionMarker.endpoint` is documented;
  `ActionHandler.isCurrent` is the second optional hook after `reverse` and the
  only place endpoint semantics live - the reconciler core stays generic.
- A daemon rebind (restart) now self-heals: the boot `boot-already-confirmed`
  reconcile pass observes the endpoint mismatch and re-attaches, so
  `env.ANTHROPIC_BASE_URL` follows the moving port instead of stranding.
- `resolveLiveGatewayEndpointFromStatus` / `gatewaySourceDetails` live in
  `daemon/status.js` (which owns the status file) and are reused by both manual
  attach and the `client_attach_stale` diagnostic - one endpoint-discovery
  routine, no second copy of the `status.json` shape.
- No new config surface and no change to the LLP 0045 §Part 1 daemon-seam
  invariant: auto-attach still resolves only a proven-bound `localEndpoint()`,
  and still never writes a URL for an unbound port. This decision adds "and
  rewrite it when the proven value changes", nothing more.

## References

- [Issue #277](https://github.com/hyparam/hypaware/issues/277) - the report (both gaps, one root cause)
- [Issue #126](https://github.com/hyparam/hypaware/issues/126) - the original silent-gap failure attach-on-join closed
- PR #271 - the message-level fix for Gap 1's error leak (diagnostics, not capability)
- LLP 0044 - client attach on join (the "attach once" decision this extends)
- LLP 0045 §Part 1 - the client seam + the proven-bound-endpoint invariant this preserves
- LLP 0041 - the generic reconciler + marker store `isCurrent` extends
- LLP 0036 - the central-config-driven client-action seam
