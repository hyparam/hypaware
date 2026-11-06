# LLP 0564: Skill evidence updates

**Type:** Spec
**Status:** Active
**Systems:** Graph, Plugins
**Date:** 2026-10-29
**Related:** LLP 0023, LLP 0428

## Skill evidence

Keep existing Skill and File identities. A shell reference to a skill file is
not an invocation. New shell read evidence uses `dispatch_file_read`; searches
use `dispatch_shell_search`. Legacy `dispatch_shell_read` may mean either and
must remain visibly unverified. Explicit tool/slash flags mean an invocation
was requested, never that it executed successfully. The marker means supplied
instructions. Presence flags combine; a session-skill relationship is not an
event count. Text output calls the relationship skill evidence and names the
flags. JSON preserves the raw relation and flags for filtering.

## Incremental evidence

Extend LLP 0428's append-only default narrowly: existing `ran` edges to Skill
receive merged evidence from their owning projector/source dataset. Partial
source scans must preserve earlier evidence, first-seen time, and exemplar
rules. Reuse the conditional maintenance generation swap; fail on unreadable
partitions or concurrent writes. Unchanged rows cause no rewrite. Other graph
identities keep their existing behavior. No version-triggered replacement.

Explicit `graph project --refresh` remains the correction path for old labels:
re-derive the complete intended source scope with the current parser and replace
matching owned rows. An incremental merge must never reinterpret a legacy flag
as a verified read or silently retract historical evidence.

## Cost

Parse shell operands once per action and retain only the current source row.
An ordinary projection containing existing skill relationships streams the edge
tables once more to merge evidence. It retains a replacement map only for
changed matching rows and reuses 10,000-row rewrite batches. A changed
relationship requires rewriting its partition; this is an offline projection
cost, not a query-time cost. Existing full-source and identity scans remain.
No dependencies, timer, or persistent cache are added.
