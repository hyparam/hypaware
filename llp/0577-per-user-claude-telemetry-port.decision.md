# LLP 0577: The default Claude telemetry port is per OS user

**Type:** Decision
**Status:** Accepted
**Systems:** Sources, Plugins, Privacy
**Author:** Kenny / Claude
**Date:** 2026-11-04
**Related:** LLP 0257, LLP 0114

> Each OS user runs their own daemon, but the Claude telemetry listener had one
> fixed default port. When two users are logged in to one machine, the second
> user's Claude Code telemetry goes to the first user's daemon and syncs under
> the first user's identity. The default port now depends on the uid.

## Problem

The listener falls back to an ephemeral port when 4319 is taken, but the second
user's Claude settings can still name 4319, and a running Claude Code session
keeps the endpoint it started with. Until something re-attaches, that user's
prompts and responses land in another person's recordings. Re-attaching narrows
the window but can't close it, because daemon restarts can swap which user holds
the port while sessions are running.

Org config can't solve this. It's the same document for every host, and
central-named plugins are locked against local overrides.

## Decision

<a id="per-user-port"></a>The default port is derived from the uid:

- uid 501 and 1000, the first account on macOS and Linux, keep 4319. Existing
  installs don't move, and neither do root or platforms with no uid.
- Every other uid gets `20000 + uid % 12000`, which is stable across restarts
  and below the OS ephemeral ranges.

An explicit `telemetry.listen_port` still wins, and an org that sets one fleet-wide
accepts the collision. The ephemeral fallback remains for a port taken by an
unrelated process. Two large uids can still collide modulo 12000. That is rare
on one machine, and the fallback and the existing `client_telemetry_stale`
diagnostic cover it.

<a id="reattach"></a>An upgrade can move a user's port while Claude's settings
still name 4319. The Claude attach marker records the telemetry port the attach
wrote, and when the listener has bound a different port the reconciler counts
the attach as stale and re-attaches, which writes the bound port. A running
Claude Code session keeps its old endpoint until it restarts. The reconciler
runs only on a joined host; elsewhere `client_telemetry_stale` in `hyp status`
remains the signal.

## Out of scope

The gateway default (LLP 0114) stays fixed. Fleet Claude Desktop profiles depend
on it, and org configs commonly bind it to an ephemeral port already.
