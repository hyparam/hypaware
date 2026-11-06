# LLP 0589: OpenCode owns its Claude SDK transcripts

**Type:** Decision
**Status:** Draft
**Systems:** Plugins, Backfill, Privacy
**Author:** Phil / Codex
**Date:** 2026-11-05
**Related:** LLP 0140, LLP 0306, LLP 0576

## Evidence {#evidence}

OpenCode 2.2.3's Claude Agent provider persists primary SDK sessions under the
user's Claude projects tree. Its `SessionRecord` stores the Claude UUID in
`claudeSessionID` under `sessions/<OpenCode session ID>` in the provider's
namespaced KV storage. Native OpenCode capture uses different IDs, so ordinary
part dedupe cannot merge a transcript imported by Claude with the native copy.

Isolated probes with Agent SDK / Claude Code 0.3.283 / 2.1.283 and
0.3.301 / 2.1.301, using only fixture prompts against a local fake Anthropic endpoint,
confirmed `entrypoint: sdk-ts` for both OpenCode-shaped and ordinary SDK
sessions. Claude backfill materialized four OpenCode-shaped rows as `claude`;
the OpenCode source opt-out withheld none. The entrypoint is a mode, not proof
of the launching client. This was not a complete real OpenCode provider run.

Claude 2.1.301 can write `api-request-shape.shape.tools`, but a first text-only
reply omitted it in the runtime probe. Both tested binaries preserve actual `mcp__opencode__*` tool calls and
`attributionMcpServer: opencode` on later assistant records. OpenCode's tool
server uses that namespace. Its SDK forks copy the conversation prefix with
new message UUIDs and `forkedFrom.sessionId` on each copied record. A real
text-only SDK fork confirmed the ancestry survives when no tool marker exists.

## Launch provenance {#launch-provenance}

The managed OpenCode plugin sets the existing `CLAUDE_CODE_ENTRYPOINT`
environment variable to `opencode` when its module loads. The SDK preserves
an explicit value instead of substituting `sdk-ts`. Claude consequently
stamps the first persisted user line with the launching client, before the
first model reply, tool call, or saved provider UUID mapping. SDK forks keep
the same value. A currently running OpenCode must restart to load the updated
managed plugin, as the attach command already instructs.

This assignment lives in OpenCode's process. Shells and standalone SDK apps
started outside OpenCode are unaffected; OpenCode's own child processes
inherit the value (see [limits](#limits)). Native OpenCode snapshot frontend
attribution still reads `OPENCODE_CLIENT`; the new value labels only the
embedded Claude transcript. The value is not a manifest admission claim:
Claude must refuse this producer entirely, not import a second copy labeled
OpenCode. Shared SDK modes remain Claude's, subject to LLP 0140's existing
fail-open rule.

## Ownership {#ownership}

Extend LLP 0140 for a shared-tree session with stronger native ownership
evidence: the explicit OpenCode launch entrypoint, an exact UUID in OpenCode's
Claude Agent KV namespace, or structured OpenCode MCP declarations, calls or
attribution in the transcript. Tool and attribution evidence count only when
the session's entrypoint is an SDK mode (`sdk-*`) or missing: any Claude Code
user can name an MCP server `opencode`, so an interactive `cli` session stays
Claude's. Evidence rows such as `api-request-shape` carry no entrypoint, so
the session's entrypoint decides. Native SDK
fork ancestry propagates this ownership in both directions. Read a currently
mapped transcript before its ancestors, following their filenames as the
upstream SDK does, so an ancestor cannot be projected before its ownership is
known. Each candidate file is still read at most once. Examine the
whole file before time-window filtering, including metadata the message
projector discards. Prompt and reply text are never searched for markers.

Read the indexed provider KV range once per import, in read-only mode. Honor
`XDG_DATA_HOME` and `OPENCODE_DB`; include channel databases beside the stable
database. A missing store or pre-provider schema is ordinary. A read failure,
invalid provider record or exhausted budget stops this import before yielding
rows, with a sanitized ownership error. It cannot establish Claude ownership.
No new dependency, schema field, config key or entrypoint claim is added.

## One producer {#single-producer}

Claude backfill skips OpenCode-owned sessions regardless of whether the
OpenCode adapter is configured, attached, ignored or opted out of sync. Native
OpenCode capture and export remain their only producer and enforce its session
and client privacy rules on native IDs. Relabeling the SDK copy as OpenCode
would still duplicate conversations and evade native session ignores.

LLP 0140's existing entrypoint and container rules continue to govern other
transcripts. Ordinary Claude SDK history with a shared or absent entrypoint
continues to import. No SDK mode is claimed by OpenCode in the manifest.
Previously captured or exported copies are not rewritten or recalled.

## Limits and cost {#limits}

The first-turn gate no longer depends on a settled mapping or optional tool
metadata for launches from the updated managed plugin. Older running children
and unmarked historical artifacts still need the native UUID, fork or tool
evidence. An orphaned unmarked transcript with none of that evidence is
indistinguishable from ordinary SDK history; no heuristic changes its owner.
An OpenCode instance that never loads the managed plugin cannot supply its
launch marker. Process-local data roots or custom database paths invisible to
HypAware likewise cannot supply historical UUID mappings. Existing captured
or exported copies are not recalled.

OpenCode's child processes, including tool shells, inherit
`CLAUDE_CODE_ENTRYPOINT=opencode`. A `claude` or SDK app started from an
OpenCode tool shell is therefore stamped `opencode` and skipped by Claude
backfill. This is an accepted residual.

On Node 22.12, `node:sqlite` needs a flag. With an OpenCode database present,
every Claude history import fails closed there.

Opening an OpenCode database prints Node's SQLite `ExperimentalWarning` on
stderr. It is harmless; HypAware does not override process warnings to hide it.

## Real-client validation {#validation}

On macOS arm64, official OpenCode CLI and Desktop 2.2.3 ran their real Claude
Agent provider with Claude Code 2.1.301 against a local fixture Anthropic API.
No real credentials or hosted inference were used. Desktop was exercised in
its UI, using its isolated test profile and an empty temporary project.

Before each frontend's first model reply, its native UUID mapping was absent,
its transcript already carried `entrypoint: opencode`, and the real Claude
import runner wrote zero rows. Both turns completed normally. Local cache
queries held exactly the two native OpenCode sessions (nine rows, including
metadata/idle rows) and ten output tokens, matching the two fixture replies.
Real native session exports replayed through the importer wrote zero duplicate
rows. With the OpenCode source withheld, the real export-read seam withheld
all nine rows and yielded no payload. A separate real CLI session ignored by
native session ID wrote zero rows on both capture paths.

An independent ordinary SDK session in the same temporary home retained
`sdk-ts`: its two Claude rows and five output tokens imported normally, and
only those two rows remained eligible for export beside the withheld OpenCode
rows. A real SDK fork also retained the explicit launch entrypoint.

The unmarked OpenCode 2.2.3 / Claude 2.1.301 baseline emitted sufficient tool
metadata for the earlier draft filter. The minimal SDK text-only probe did
not, so the launch marker removes reliance on optional emission shape rather
than claiming that baseline failed. OpenCode's first-turn attempt with Claude
2.1.283 was refused by its upstream initialization-version check; no successful
real OpenCode turn on that older binary is claimed.

Hosted authentication and request headers with the `opencode` entrypoint were
not exercised; only the fixture endpoint was.

## CPU and memory {#cost}

The launch assignment and entrypoint comparison add constant work, no I/O,
no retry, and no retained state. There is no additional transcript read or persistent ownership cache. Native
rows are checked while the existing parser reads them; ownership is a set
lookup before window filtering, policy lookup, projection or git probes. The
per-run index retains at most 65,536 IDs across at most 32 databases, visits at
most 65,536 provider records, and refuses values over 1 MiB or 16 MiB of
provider metadata in total. Directory discovery stops at 4,096 entries.
Busy waiting is capped at 100 ms per database. SQLite returns only lengths
and UUIDs, not checkpoint histories or unrelated messages. All handles close after the read.
