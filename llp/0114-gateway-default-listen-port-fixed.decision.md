# LLP 0114: The gateway's default listen port is fixed, with ephemeral fallback

**Type:** Decision
**Status:** Accepted
**Systems:** Config, Sources, Gateway, Daemon
**Author:** Phil / Claude
**Date:** 2026-07-20
**Related:** LLP 0044, LLP 0045, LLP 0086

> The AI gateway's `DEFAULT_LISTEN` was `127.0.0.1:0`: the OS picks a fresh
> ephemeral port on every daemon restart. LLP 0086 made that livable by
> teaching attach to track the moving port (status.json discovery, endpoint-
> aware markers, re-attach on drift, a `client_attach_stale` diagnostic). It
> works, but it makes "where is my gateway?" a moving target: every restart
> churns client settings files, any out-of-band consumer (curl, scripts,
> dashboards) must re-discover the port, and a missed re-attach window is
> silent capture loss until the reconciler or the operator catches it. Phil
> called it: we want a consistent port.

## Context

LLP 0086 explicitly blessed the ephemeral default ("That choice is fine") and
fixed the *tracking*. This decision revisits the blessed part: the default
itself. The tracking machinery stays; it becomes the safety net instead of the
steady state.

The constraint that motivated `:0` is real: a fixed port can already be taken
on a machine we do not control, and "the daemon fails to boot because some
other process sits on its port" is a worse failure mode than a moving port.
Any fixed default must keep the invariant that the daemon always starts.

## Options

1. **Keep `127.0.0.1:0`** - never collides, but every restart moves the
   endpoint; permanent churn and drift risk (the status quo being rejected).
2. **Fixed default, hard-fail on collision** - stable, but breaks "the daemon
   always starts" for whoever happens to have the port taken.
3. **Fixed default, ephemeral fallback** - bind the well-known port; if and
   only if the *default* bind fails with `EADDRINUSE`, log loudly and fall
   back to `127.0.0.1:0`, where the LLP 0086 machinery (discovery, re-attach
   on drift, stale-port diagnostic) already handles the moving endpoint.

## Decision

<a id="fixed-default-port"></a>**Option 3.** `DEFAULT_LISTEN` becomes
`127.0.0.1:18521` (`0x4859` = ASCII `"HY"`; unassigned, above the common
dev-server ranges). On the default install the gateway binds the same port on
every restart, so attach markers stay current, client settings stop churning,
and the endpoint is predictable for out-of-band consumers.

<a id="ephemeral-fallback"></a>**Fallback is default-only.** When the listen
address came from the default (not user config) and the bind fails with
`EADDRINUSE`, the source logs a warning and retries on `127.0.0.1:0`. The
daemon still always starts; the rare fallback boot is exactly the pre-0114
world, fully covered by LLP 0086.

<a id="explicit-listen-fails-loudly"></a>**An explicit `listen` never falls
back.** A user- or fleet-configured address is a stated requirement; silently
binding somewhere else would put the gateway where nobody is looking. A
configured bind failure stays a loud source-start failure, unchanged.

<a id="fallback-is-visible"></a>**A fallback boot is visible in status, not
only in a log line.** The fixed port creates the expectation "the gateway is
at 18521"; out-of-band consumers (curl, scripts, dashboards) are pointed at
it, so the exception must be loud in the tool operators actually run. The
gateway source's `status()` details record `listen_fallback: true` when the
bind came through the fallback path (riding the existing
`SourceSnapshot.details` plumbing into `status.json`), and `hyp status` emits
a `gateway_port_fallback` warning naming the taken default. Like
`client_attach_stale` (LLP 0086 §status-drift-diagnostic), the warning is
non-degrading: a fallback boot is a working install, so it never flips
`overall`.

## Consequences

- LLP 0086's mechanisms (status.json as the live-port source of truth,
  `isCurrent` re-attach, `client_attach_stale`) are unchanged and still
  required: they cover the fallback path, explicit-`listen` fleets that
  change the port, and pre-0114 installs. This decision extends 0086's
  framing; it does not supersede its machinery.
- Fleets that already pin `listen` centrally see no behavior change.
- A fresh default install after this change lands on 18521; an existing
  install's clients re-attach to 18521 on the first daemon restart via the
  normal LLP 0086 drift re-attach.
- If 18521 is taken, that boot behaves like pre-0114 (ephemeral); nothing
  breaks, and the fallback is visible both at boot (`aigw.default_port_taken`)
  and steadily (`listen_fallback` in status details, `gateway_port_fallback`
  in `hyp status`).
- <a id="interception-accepted"></a>**Daemon-down interception is accepted,
  not newly created.** While the daemon is stopped, anything that binds
  127.0.0.1:18521 receives attached clients' traffic (auth headers, prompt
  bodies) until the next boot re-attaches or `gateway_port_fallback` surfaces
  the squatter. A fixed port makes that window *predictable* where it was
  merely *possible* pre-0114 (a stale marker pointed at a dead ephemeral port
  any process could win). It grants no new privilege: a local process able to
  bind the port can already read the client settings files and tokens
  directly; a localhost port is not where the security boundary lives.
  Mutual gateway/client authentication (a per-install token) was considered
  and declined as disproportionate for a local dev-observability tool - do
  not add it as a drive-by hardening without revisiting this decision.
