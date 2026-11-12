# LLP 0598: Droid session token snapshots

**Type:** Spec
**Status:** Draft
**Systems:** Plugins, Sources, Backfill, Query
**Extends:** LLP 0551#capture, LLP 0035#per-turn
**Related:** LLP 0449#read-commit-guard, LLP 0590#derivation

## Evidence

The 2026-11-11 local experiment found `tokenUsage` in each session's
UUID.settings.json accumulates across turns and a restart. Child sessions
have independent counters and native `callingSessionId` headers. Parent
`inclusiveTokenUsage` and `childInclusiveTokenUsageBySessionId` are different
fields and must not be added to the children's own counters. `lastCallTokenUsage`
does not reconstruct historical calls. These observations are not a billing
reconciliation or proof for every Droid version.

## Accounting {#accounting}

Read only the adjacent session settings sidecar, after transcript containment,
session exclusion and directory policy checks. Do not retain the rest of that
file (which can include system prompts). Open without following symlinks and
bound reads to 1 MiB. Invalid or concurrently changing files retry, never turn
an unknown count into zero. Missing sidecars leave existing accounting alone.

Map inputTokens/outputTokens/cacheCreationTokens/cacheReadTokens/thinkingTokens
to the existing usage fields. Keep factoryCredits as an explicitly named Droid
attribute, never dollars. Do not fabricate total_tokens or add thinking to output.
Native transcript `tokens` remains a context estimate, not usage.

Emit one system/status message with provider_subtype=session_usage and stable
identity per session. Scope reconciliation to client_name, session_id and that
message_id so it cannot remove conversation parts. Hold the existing scope
guard from the sidecar read through commit. Both hook and backfill paths use
the same projector. Fill token columns explicitly because reconciliation does
not run the append settlement pass. Changes to just the settings file invalidate
the scheduled recovery fingerprint.

The snapshot uses the first native message's timestamp as a stable session
date, and attributes.droid.usage_observed_at records the sidecar mtime. Window
selection for accounting is by session start, not when the tokens were spent;
an until bound is not an as-of reconstruction. Keep model/provider unattributed
on totals because a session can switch models. No per-message, per-model, or
daily allocation is inferred. Child messages and snapshots carry parent_thread_id
from callingSessionId, never a guessed relationship from names or nearby times.

## Remote revisions {#remote}

Local reconciliation replaces the snapshot. Exported revisions may coexist on
the server. Queries must choose the greatest usage_observed_at per gateway_id
and message_id, keeping all fields from that one revision, before summing.
Server usage rollup includes Droid's explicit system/session_usage rows,
selects one revision per identity on the anchored session day, and does not
count these as assistant messages. No independent MAX of token fields.
Totals grouped by date mean lifetime usage of sessions starting that day.

## Bounds and checks

No full-history payload cache or scan for parent links. Existing 64 live cursors
retain only a first-message timestamp and sidecar fingerprint each. Unchanged,
settled sidecars skip parsing and reconciliation on subsequent hooks. Recovery reserves the
sidecar size in its scan budget. Server revision selection retains one snapshot
per Droid session in the existing org/day scan. Test updates without transcript
changes, replay/restart, children, privacy, missing/invalid counters, concurrent
file changes, and repeated live/backfill writes against real storage.
