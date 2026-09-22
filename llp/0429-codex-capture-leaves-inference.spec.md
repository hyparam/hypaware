# LLP 0429: Codex capture leaves the inference path

**Type:** Spec
**Status:** Accepted
**Systems:** Plugins, Sources, Backfill, Config, Onboarding
**Author:** Phil / Codex
**Date:** 2026-09-22
**Related:** LLP 0141, LLP 0313, LLP 0359, LLP 0045

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

## Verification {#verification}

Traditional tests cover fresh and existing configuration, dry-run, gateway
opt-in, instructions, unchanged and appended files, delayed usage and retry
following materializer failure. The Codex fixture smoke uses the real sweep,
materializer and query pipeline and checks capture telemetry. Real client
acceptance must additionally prove that CLI and Desktop inference succeeds
with the HypAware daemon stopped, then that its next sweep imports the turns.
