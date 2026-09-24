# LLP 0429: Codex capture leaves the inference path

**Type:** Spec
**Status:** Accepted
**Systems:** Plugins, Sources, Backfill, Config, Onboarding
**Author:** Phil / Codex
**Date:** 2026-09-22
**Related:** LLP 0141, LLP 0313, LLP 0359, LLP 0045
**Extended-by:** LLP 0432 (saved Codex provider compatibility and key-scoped TOML undo)

## Default {#default}

Codex CLI and Desktop capture defaults to reading their shared native rollout
files. HypAware must not route their inference or disable native transports to
record ordinary conversations. The accepted cost is loss of the complete
submitted tool catalogue and its descriptions. This extends LLP 0141's shared
adapter and LLP 0313's gateway routing, making that route optional.

The Codex plugin owns `capture_mode`: absent or `transcript` selects file
capture; `gateway` explicitly selects the existing provider writer. The old
`proxy` capability reference alone is not an opt-in. The gateway plugin remains
a dependency for the dataset and materializer; its listener is not on Codex's
inference path. Onboarding does not compose inference upstreams for Codex.

## Scheduled capture {#sweep}

Reuse the existing backfill provider and serial daemon sweep queue, with a
one-minute default cadence. Reuse `backfill.sweep_cron`, `window_days` and
`on_join`: the latter's explicit false disables automatic imports, as for
Claude. Manual history import remains available. The existing retention window
bounds scheduled rows; widening a window can recover older unchanged files
on daemon restart or manual import.

A process-local inode/size/mtime map skips unchanged files. Advance it only
after yielded items are consumed without failure; prune missing paths. No
persistent cursor is added. Cold startup reads history once; changed files
are reread in full, one file at a time. CPU and temporary memory remain
proportional to the discovered paths and changed file sizes, not total cache
rows. The map retains one small fingerprint per discovered file.

## Captured content {#content}

Reuse the existing message, tool call/result, lineage, entrypoint and usage
projection, privacy gates and durable identity. Add native
`session_meta.base_instructions.text` to the existing `system_text` field.
Developer and AGENTS instruction messages remain ordinary native response
items. Leave `tools` absent; partial dynamic definitions cannot honestly stand
in for the full submitted catalogue. Exact per-request context after compaction
is not claimed.

The Codex app container stays an unsupported location, and its
`unsupported_location` event keeps naming every route that does cover it
(LLP 0141 #unsupported-boundary). Under this default that is
`codex_sessions_rollout` alone; `gateway_live` returns with gateway mode.

For modern files carrying task lifecycle events, a scheduled import stops at
the latest usage, completion or abort boundary. This avoids permanently
committing an assistant row before its delayed token usage arrives. A crashed
unfinished suffix remains available to explicit manual import. Legacy files
without lifecycle events retain best-effort full-file import.

## Existing installs {#migration}

Default attach is endpoint-free. It uses the existing marker-owned TOML undo
to remove the managed provider, restore the prior selection and preserve
unrelated settings. It does not write a new provider or transport override.
Dry-run does not write. Gateway mode still uses the credential-aware route.

The daemon's scheduled provider also applies this idempotent undo, covering
local installs with no fleet marker. A failed settings write fails the sweep
visibly and retries next tick. Read-only activation and manual imports do not
edit settings. Existing fleet markers become stale on capture-mode change.
Explicitly disabled automatic import does not trigger the sweep migration;
manual attach still does. Running Codex clients must restart to reload their
provider configuration. The migration log records this requirement.

## Attach state on the status surface {#status}

The client manifest keeps its `attach_probe` on the managed provider header in
both modes, because it is the only thing that finds a block an earlier mode
left behind. Under the default that probe can never succeed: the attach it
would confirm is the one that *removes* the block. `hyp status` must therefore
report a transcript-mode Codex as attach **n/a**, not **not attached** - the
wrong negative LLP 0229 exists to stop, whose repair here is a command that
can never clear the warning it prints.

This extends [LLP 0229 #keys-on-the-descriptor-not-the-probe-result](./0229-status-derives-attach-state-by-the-desired-gate.decision.md#keys-on-the-descriptor-not-the-probe-result)
by exactly one config key: `attachable` is derived from the descriptor's probe
*and* the capture mode that decides whether a marker can exist, still never
from a probe result. The probe itself keeps running, so a stranded marker
still reaches `client_attached_not_configured`.

The gate stops at `attachable`. Whether the reconciler has an attach to run is
a different question with a different marker: the action record, which a
transcript attach does earn, since it removes a real provider block and
succeeds. That target stays `pending` until it runs, in both capture modes.

## Verification {#verification}

Traditional tests cover fresh and existing configuration, dry-run, gateway
opt-in, instructions, unchanged and appended files, delayed usage and retry
following materializer failure. The Codex fixture smoke uses the real sweep,
materializer and query pipeline and checks capture telemetry. Real client
acceptance must additionally prove that CLI and Desktop inference succeeds
with the HypAware daemon stopped, then that its next sweep imports the turns.
