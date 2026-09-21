# LLP 0415: Preserve local grep automatically on upgrade

**Type:** RFC
**Status:** Accepted
**Systems:** Config, Plugins, Query, MCP
**Author:** Phil / Codex
**Date:** 2026-09-16
**Supersedes:** LLP 0413#plugin (manual activation for existing clients only)
**Extends:** LLP 0031#physical-layout (client boot may migrate the local layer)
**Related:** LLP 0010, LLP 0413#server
**Superseded-by:** LLP 0418 (#migration, in part: the central-only lane writes no local config, so there is no missing local file left to exclusively create)

## Migration {#migration}

Moving existing search into a plugin must preserve it when a client upgrades.
The client configuration load adds `@hypaware/grep` when neither valid layer
names it. This is a targeted compatibility migration, not a general rule that
activates bundled plugins or expands `compose_with` at boot.

Normal client CLI, daemon, MCP, help selection, and daemon reload use the same
migration. Explicit host activation profiles and generic config readers do not.
The discovered catalog must contain grep. A fresh install with neither config
layer remains unconfigured; an unreadable or malformed layer is never replaced
or interpreted as permission to enable search.

Any existing grep entry is preserved, including `enabled: false`. Central
precedence remains unchanged. With only a central config, write an additive
local config. Central documents and explicit host/server boot selection remain
untouched, preserving LLP 0413#server and the server-owned tool registration.

**Superseded-by: [LLP 0418 §no-forged-answer](./0418-grep-migration-forges-no-pick-answer.decision.md#no-forged-answer)**
(2026-09-18), for the "With only a central config, write an additive local
config" sentence above and for the exclusive-create clause in the paragraph
below. The additive local config named above is the one document that would
record a pick answer nobody gave, so the central-only lane keeps the
compatibility entry in memory instead of writing it, and no local file is
created at all. Everything else in this section stands.

Reuse the local config backup guard, file lock, and atomic writer. Re-read under
the lock, guard existing-file writes against concurrent edits, and exclusively
create a missing local file. Preserve unrelated settings and file permissions.
Once the entry exists, startup does no migration writes or backups. Removing
the entry makes the next client boot restore it; disabling it is the opt-out.

If persistence fails, re-read both layers and apply the entry in memory only
when neither layer now names grep. Emit a warning with a content-free error
code. This preserves search with read-only configs without hiding the failed
write. Symlink configs use the same fallback so migration cannot replace the
link or write through it into a central slot.

## Verification {#verification}

Tests cover old-config boot and MCP advertisement, backup/idempotency, explicit
enable/disable, central-only composition, reload, read-only fallback, malformed
and missing configs, concurrent startups, symlinks, and explicit host selection.
The grep roundtrip smoke starts from a legacy config and checks migration
telemetry alongside search results and the absence of indexes.

CPU and memory work is bounded by the configuration size. The migration adds no
timers, workers, network calls, data scans, or retained state. Only an absent
entry reaches the filesystem lock/write path; normal configured boot does two
linear plugin-list checks over already loaded documents.
