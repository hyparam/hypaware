# LLP 0432: Codex saved provider compatibility

**Type:** Spec
**Status:** Draft
**Systems:** Config, Plugins, Backfill
**Author:** Phil / Codex
**Date:** 2026-09-24
**Related:** LLP 0429, LLP 0045

## Compatibility {#compatibility}

Extends LLP 0429 #migration and #status and LLP 0045's disk-driven undo.
Codex persists `model_provider=hypaware` in saved tasks. Deleting the provider
breaks their resume even though new tasks work. Releasing inference routing
must retain that identity as an unmarked compatibility provider: Responses,
OpenAI authentication required, WebSockets supported, no `base_url`. Codex
chooses its normal OpenAI endpoint from the user's current authentication.
Never add a root provider selection, inspect credentials, or route through
HypAware to recover a task. Restore the prior root selection only when the
managed selection still belongs to us; preserve an explicit replacement.

Core disk detach and transcript attach/sweep share one transform. Remove exact
Codex ownership markers and their routing assignments, preserving unrelated
root keys and tables even inside markers. Leave an existing unmarked provider
untouched. The probe names the managed provider comment, not the surviving
compatibility table. Explicit gateway attach can replace the alias with the
managed gateway provider; transcript-mode background work never does so.

## Recovery {#recovery}

Already-migrated installs have no marker. Add a missing alias only with evidence
from a native `session_meta.model_provider` equal to `hypaware` under that
settings file's Codex home. Inspect active and archived rollout headers,
without applying the import window or modifying history. Stream directory
entries, do not follow symlinks, bound traversal depth to five, read at most
64 KiB per header, stop at the first match, and retain no file list. An oversized
or malformed header cannot establish evidence. This detection runs once per
scheduled provider lifetime, on explicit transcript attach, or disk detach.
Retry failed reads/writes on a later sweep. Manual imports and dry-run sweeps
never write. No evidence leaves a fresh installation unchanged. Existing
explicit provider definitions are never overwritten by recovery.

This restores provider identity only. Settings already deleted by 1.38.0
cannot be reconstructed without a user backup. Restart Codex to reload config.
Disabled automatic imports still require explicit attach for recovery.

## Verification {#verification}

Regress forward migration, core detach, already-removed markers, archived
sessions, explicit providers, unrelated tables inside markers, idempotency,
dry run, gateway opt-in, and smoke isolation from inherited client homes.
Validate real CLI and Desktop-bundled config loaders against disposable homes.
A real authenticated saved-task resume remains a release acceptance check.

CPU and memory: the transform is linear in the settings file; recovery performs
one bounded prefix read per candidate until evidence is found, with constant
buffer space and bounded directory-handle depth. No per-minute history rescan
is added after successful detection, including a negative result.
