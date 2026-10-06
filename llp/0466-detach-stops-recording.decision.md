# LLP 0466: Detach stops recording a client

**Type:** Decision
**Status:** Accepted
**Systems:** CLI, Backfill, Config, Daemon, Onboarding, Plugins
**Author:** Kenny Daniel
**Date:** 2026-10-05
**Related:** LLP 0041, LLP 0044, LLP 0045, LLP 0140, LLP 0429, LLP 0358
**Extends:** LLP 0429 (`on_join` no longer gates Codex's capture sweep)

## Problem

`hyp client detach` reverted a client's settings and cleared its attach marker,
but left the plugin enabled. The daemon's scheduled transcript sweep gates only
on the plugin being loaded and `backfill.on_join`, so Claude Code, Claude
Desktop, Codex and Cursor kept being recorded after a detach. `hyp status` then
saw an enabled plugin with no marker and warned `client_attach_missing`,
telling a user who detached on purpose to reattach. The only real off switches
were re-running `hyp setup` or hand-setting `backfill.on_join: false`, which
for transcript-mode Codex removed the only capture lane even while "attached"
(#2076).

## One switch per client {#switch}

Each client has one state: recording, or not recording. `hyp client attach`
and `hyp client detach` are its only switch.

The state lives on the owning plugin's `plugins[]` entry as `recording: false`
(absent means recording). It is a kernel-level entry field beside `enabled`,
not a key inside the plugin's `config`, so every client plugin, first- or
third-party, gets it without its own validator learning a new key. A client
maps one-to-one to its plugin (`contributes.client`), so the entry is the
client's. No marker file or side store is added.

Detach writes `recording: false` to the local entry and then reverts the
client's settings as before. Attach removes the key after a successful attach;
for a client with nothing to write (Claude Desktop) attach is the switch alone.
Both are idempotent. Recorded history is kept, and the detach receipt points at
`hyp privacy purge`.

A plugin with no local entry is not enabled there, so its client is already not
recording; detach never invents an entry, which would enable the plugin.

## The daemon reads the switch fresh {#fresh-read}

The daemon boots on a copy of the config, and detach must take effect with the
daemon running. The backfill runner already re-reads the local config on every
provider run (LLP 0140's configured-plugin predicate); the switch is read the
same way, raw, on every run. The attach reconciler's `desired()` reads it fresh
too.

## The runner enforces it {#runner-gate}

The gate is in the backfill runner, not in each plugin, so every sweep,
`hyp backfill`, and the join-time import honor it:

- A detached plugin counts as not configured for entrypoint ownership and
  container admission, so Claude Desktop's sessions (in Claude's shared tree
  and in its `Claude-3p` container) close the way an unconfigured client's do.
- A provider whose own client is detached is skipped whole, unless that client
  declares `transcript_entrypoints`: such a provider classifies a shared tree
  session by session, and another client (Claude Desktop riding Claude's
  provider) may still be recording. There the classifier drops the detached
  client's sessions, including unclaimed entrypoints, which otherwise fail open
  to the scanning client.

Other lanes stop with the settings revert (Claude's OTEL env, Cursor's hooks,
OpenCode's plugin file, gateway routes).

## Org policy wins {#central-refuses}

If the central (org) layer names the client's plugin, the merge drops the local
entry, so a local `recording: false` would be inert. Detach refuses whole, says
the organization requires the client, and changes nothing. A central entry may
itself carry `recording: false`.

## No automatic path re-attaches {#reattach-paths}

The attach-on-join reconciler skips detached clients, so neither a central
apply nor a package-update re-perform re-attaches one. `hyp setup` carries the
entry forward on reconfigure and skips attaching and installing assets for a
detached client. `hyp client skills install --attached` already reads the
settings marker, which a detach removed. Only an explicit `hyp client attach`
turns recording back on.

## Status {#status}

`hyp status` reports a detached client as "Not recording", with
`hyp client attach <client>` as a plain hint, and raises no diagnostic. The
`--json` client rows carry `recording`. `client_attach_missing` now means a
contradiction: the client should be recording but its settings marker is gone.

## `backfill.on_join` {#on-join}

`backfill.on_join` stays a knob, but only for the join-time history import.
Recording is the detach switch. For transcript-mode Codex the sweep is the only
capture lane, so it no longer gates on `on_join` (fixes #2076). With
`on_join: false` the sweep is floored at plugin activation instead: it records
what happens from then on and never imports the declined history. The floor is
process-local, so messages written while the daemon is down are not recovered by
the sweep; a manual `hyp backfill` is not floored. Claude, Cursor
and Pi keep their existing `on_join` sweep gate: they have a live lane, and
narrowing their history import is LLP 0041's consent knob.
