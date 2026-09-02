# LLP 0363: A Claude version-floor refusal is a retryable failure, not a terminal refusal

**Type:** Decision
**Status:** Accepted
**Systems:** Config, Clients
**Generated-by:** neutral
**Date:** 2026-09-02
**Related:** LLP 0041, LLP 0184, LLP 0186, LLP 0258, LLP 0262, LLP 0295

> Extends [LLP 0186](./0186-reconciler-refused-marker.design.md)
> `#which-handlers-migrate-summarized` with the one Claude throw site that did
> not exist when that table was written: the LLP 0258 OTEL version floor. LLP
> 0186 is Active and does not change: its `refused` state, its unconditional
> short-circuit, and its explicit-`hyp client attach` re-arm all stand exactly
> as written. This document settles only which of LLP 0186's two existing
> states the version floor belongs in. Raised as residual 2 of
> [hyparam/hypaware#999](https://github.com/hyparam/hypaware/issues/999).

Coverage anchor:

`@ref LLP 0186#which-handlers-migrate-summarized: the migration table gains no row for VERSION_FLOOR because this document keeps that site in the failed column`

## Context

[LLP 0258](./0258-attach-injects-telemetry-via-settings-env.decision.md)
`#version-floor` decided that a Claude Code release below `2.1.193` makes
`otel` attach refuse the mode switch: it emits none of the events the
telemetry listener reads, so a settings file that says "attached" over a
capture that never starts is the failure the floor exists to prevent. The
preflight runs before any settings I/O, so an existing attach survives the
refusal byte for byte.

The implementation wrapped that throw in `markActionRefused`, which routes it
through LLP 0186's terminal `refused` marker. Three rules then compose into a
trap:

1. The attach handler's `isCurrent` reports a `claude` marker whose `mode` is
   not `otel` stale on every pass (LLP 0262 `#migration`), so a below-floor
   machine is a forward gap every pass.
2. `perform()` refuses, and the reconciler writes a `refused` marker.
3. A `refused` marker short-circuits **unconditionally** (LLP 0186
   `#how-the-reconciler-distinguishes-it-from-done`): `isCurrent` is not even
   consulted for it.

So the machine attaches no more, ever, on its own. Claude Code then updates
itself, the floor clears, and nothing notices: reconciliation still
short-circuits until someone runs `hyp client attach claude` by hand
(LLP 0186 `#re-arm-explicit-hyp-attach-re-run-only`, extended to both success
exits by [LLP 0295](./0295-rearm-fires-at-both-attach-success-exits.decision.md)).
The user has no reason to: capture was working before the migration and the
only visible signal is one status line.

## Decision

<a id="version-floor-is-retryable"></a>

### The floor refusal is `failed`, not `refused`

**`preflightOtelAttach` throws its `VERSION_FLOOR` error unmarked**, so
`action_attach.js`'s catch records LLP 0041's ordinary retryable `failed`
marker. Nothing else changes: the attach command still refuses, still prints
the `claude update` hint, still runs read-only before any settings I/O, and
still leaves an existing attach untouched. LLP 0258 `#version-floor` is
unaffected: what it settled is that attach refuses the mode switch, which it
does.

The distinction LLP 0186 draws is what decides this. `refused` is for "a
precondition failure only the user can fix", and its defining property is that
**retrying is pointless**: the OpenClaw ownership conflict and the JSONC
settings file are facts about files the user wrote for HypAware to read, and
they stay true until the user rewrites them. A version floor is not that. It
is a fact about the installed client, it is cleared by Claude Code's own
updater without the user touching anything of HypAware's, and the very next
reconcile pass after that upgrade succeeds. That is precisely the case LLP
0041 gave `failed` to.

This is the automatic re-arm for this population, and it needs no new
mechanism to be one. The `isCurrent`-style auto re-arm that LLP 0186 names as
a follow-up candidate and deliberately does not build stays unbuilt: no new
marker state, no new marker field, no new per-handler contract, no bounded
retry counter, and no change to what `refused` means or to how it
short-circuits.

<a id="markers-already-refused-are-not-migrated"></a>

### A marker an earlier release already wrote is not migrated

**This reaches no machine that already recorded the refusal.** The marked throw
shipped in v1.24.0 through v1.30.0. A joined host that ran one reconcile pass
on any of them with an old client wrote a `refused` marker into
`<stateRoot>/config-control/client-actions.json`, that file survives a package
upgrade (the store carries no schema version and nothing invalidates it), and
`refused` short-circuits before `isCurrent` or `perform()` is consulted. Such a
host stays skipped on every boot however new its Claude Code becomes. It still
reports `attach claude [refused]` with the `run 'hyp client attach claude'`
repair line, and that command is still what clears it. Migrating those markers
is the automatic re-arm [#999](https://github.com/hyparam/hypaware/issues/999)
asks for and LLP 0186 `#follow-up-candidate-not-built-here` names: it is not
built here, and it cannot be improvised, because no error code is persisted on
a marker, so nothing on disk tells a floor refusal from a JSONC one. What this
document settles is how the *next* floor refusal is classified. Residual 2 of
#999 is closed for new occurrences and stays open for markers already written.

<a id="what-a-retry-costs"></a>

### What the retry costs

A below-floor machine now re-performs the claude attach on every reconcile
pass instead of once. That is bounded by what a pass is: the reconciler runs
at daemon boot and on a config-confirmation edge (LLP 0041
`#when-the-reconciler-runs-lifecycle-integration`), never on a tick loop. Each
retry is one `claude --version` probe with a 3s timeout and one refusal, both
read-only, and the marker's `attempts` counter is the honest count of how many
boots have seen an old client.

That accounting assumes the probe answers the same way on every pass, and
it does not have to. `resolveClaudeCodeVersion` is best effort: a missing
binary, a non-zero exit, or a probe slower than its 3s timeout all read as
`undefined`, which LLP 0258 `#version-floor` settled as "not proven old,
proceed". A terminal `refused` marker incidentally pinned a machine an
earlier pass had proven below the floor, so a later blind probe could not
move it. A retryable `failed` marker does not pin it, so a pass whose probe
comes back blank attaches `otel` over a client that emits nothing, and the
resulting `done` marker is current forever. That end state is already
reachable on `master` whenever the *first* pass is the blind one (no daemon
unit sets a `PATH`), so this narrows an incidental guard rather than opening
a new failure mode, and closing it needs the persisted state this document
declines to add. Tracked as
[hyparam/hypaware#1246](https://github.com/hyparam/hypaware/issues/1246).

LLP 0184's complaint was a permanent failure retried forever with no way out.
This one has a way out, and taking it is the point.

<a id="the-other-claude-refusals-stay"></a>

### The other refusal sites are unchanged

`JSONC` and `CA_MISSING` keep their `markActionRefused` wrapping. Both are
statements about local state a retry cannot change: a settings file the user
must convert back to plain JSON, and a proxy-mode CA that only a differently
configured daemon can produce. The rule this document applies is the one that
keeps them there.

## Consequences

- A machine below the floor reports `attach claude [failed]` with the
  `claude update` hint rather than `[refused]`, and the hint stays true: the
  status line is the same actionable signal, and the marker no longer promises
  that only a manual command can clear it.
- On a machine whose refusal this build recorded, the first daemon boot (or
  config confirmation) after the client is upgraded performs the proxy-to-OTEL
  migration LLP 0262 designed, with no manual `hyp client attach claude`. A
  marker written by an earlier release is not migrated
  (`#markers-already-refused-are-not-migrated`).
- `attempts` on such a marker grows one per pass. LLP 0186 left
  `attempts`-bounding on transient `failed` markers explicitly out of scope,
  and this document does not reopen it.

## Test strategy

In `test/plugins/claude-settings-otel-attach.test.js`, beside the existing
floor tests:

- The floor error carries `code: 'VERSION_FLOOR'` and is **not** marked as a
  permanent refusal, unlike the JSONC site in the same module.
- End to end through the real reconciler and the real attach handler: a pass
  below the floor records a retryable `failed` marker, and the next pass with
  the client upgraded attaches and writes `done`, with no re-arm call in
  between.
- The limit, executable: a store seeded with the `refused` marker an earlier
  release wrote still short-circuits with the client upgraded, so the day the
  automatic re-arm lands, that test is what fails
  (`#markers-already-refused-are-not-migrated`).

## References

- [LLP 0186](./0186-reconciler-refused-marker.design.md): the `refused` state,
  the `failed`/`refused` distinction this document applies, and the
  unconditional short-circuit that made the floor terminal
- [LLP 0258](./0258-attach-injects-telemetry-via-settings-env.decision.md):
  `#version-floor`, the refusal itself (unaffected)
- [LLP 0262](./0262-otel-attach-replaces-proxy.rfc.md): the mode-drift
  staleness that makes a below-floor machine a forward gap every pass
- [LLP 0041](./0041-central-config-client-actions.design.md): `failed` as the
  retried-next-pass state, and when a pass runs
- [LLP 0295](./0295-rearm-fires-at-both-attach-success-exits.decision.md): the
  manual re-arm, still the only thing that clears a genuine `refused` marker
- `hypaware-core/plugins-workspace/claude/src/settings.js`:
  `preflightOtelAttach`, the throw site this document unmarks
- `src/core/config/action_attach.js`: `isCurrent`, whose note about the
  below-floor population this document settles
