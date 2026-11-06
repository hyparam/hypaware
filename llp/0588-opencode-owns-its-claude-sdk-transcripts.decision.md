# LLP 0588: OpenCode owns its Claude SDK transcripts

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

An isolated probe with Agent SDK 0.3.301 and real Claude Code 2.1.283 and
2.1.301, using only fixture prompts against a local fake Anthropic endpoint,
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

## Ownership {#ownership}

Extend LLP 0140 for a shared-tree session with stronger native ownership
evidence: an exact UUID in OpenCode's Claude Agent KV namespace, or structured
OpenCode MCP declarations, calls or attribution in the transcript. Native SDK
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

The mapping records the current Claude UUID after a request settles. A
text-only first request can lack an OpenCode marker before its first mapping
is saved, including on Claude 2.1.301. An orphaned transcript whose mapping,
fork links and identifying prefix are all gone has the same problem.
That artifact is indistinguishable from ordinary SDK history. This
change does not claim to classify it. Process-local data roots or custom DB
paths invisible to HypAware likewise cannot supply mappings. Real OpenCode
CLI/Desktop Claude Agent validation, including first-turn timing, remains
needed; the hermetic smoke cannot prove upstream persistence or emission order.

There is no additional transcript read or persistent ownership cache. Native
rows are checked while the existing parser reads them; ownership is a set
lookup before window filtering, policy lookup, projection or git probes. The
per-run index retains at most 65,536 IDs across at most 32 databases, visits at
most 65,536 provider records, and refuses values over 1 MiB or 16 MiB of
provider metadata in total. Directory discovery stops at 4,096 entries.
Busy waiting is capped at 100 ms per database. SQLite returns only lengths and UUIDs, not
checkpoint histories or unrelated messages. All handles close after the read.
