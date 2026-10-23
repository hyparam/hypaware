# LLP 0556: Native session titles

**Type:** Spec
**Status:** Draft
**Systems:** Plugins, Sources, Gateway, Backfill
**Date:** 2026-10-23
**Related:** LLP 0030, LLP 0359, LLP 0429

## Capture {#capture}

Native names live on metadata parts in `attributes.session.title`, with a normalized ISO
`attributes.session.title_updated_at`. No message-table column or model call
is added. Claude reads `ai-title` and `custom-title` transcript records,
preferring the latest nonempty custom name. Codex reads its bounded local
`session_index.jsonl` and the newest `state_N.sqlite` thread database once
per scan, taking the latest revision per thread. The database contributes
`threads.name`, never the `title` prompt-preview field. Read-only SQLite uses
the standard library and degrades to the index when unavailable.
Metadata is admitted only through the source's existing session opt-out,
cwd policy, entrypoint, attachment, and import-window gates.

## Updates {#updates}

Old content is immutable and deduplicated. Each native title revision also
produces a `session_metadata` part with a deterministic message/part identity.
It has no content, usage, tools, or model output. Its message timestamp is the
last admitted content timestamp, so late generation and renames dirty the
existing content day without moving session activity or importing older content.
Replays deduplicate; a repeated name at a later native revision is a new update.
Claude uses title-record ordinal as revision and transcript mtime as the
observed title time because its title records have no native timestamp.

Session readers exclude these parts from content counts, model counts, and
conversation rendering. The server's daily summary retains the latest title
and its update time; query and pager merges choose by update time rather than
lexical title or content day. Existing rows remain usable without a title.

## Cost and other sources

Reuse scheduled transcript scans and native metadata already fetched by each
adapter. Codex metadata reads are byte/entry bounded; no per-message filesystem
lookup or lifetime-growing title cache is introduced. Title values never enter
diagnostic logs. OpenCode snapshots and Codex cloud thread metadata use the
same update contract. Their native snapshot update time can advance on a
content change too, producing at most one additional metadata part per native
snapshot revision. The synthetic part never copies system prompts or tools
and never becomes a conversation predecessor.

## Collector audit

| Collector | Finding |
| --- | --- |
| Claude Code and Claude Desktop | Implemented through the shared Claude transcript provider, including Desktop sandbox roots. |
| Local Codex CLI and Desktop | Implemented through both the name index and native SQLite `name`; index-only capture misses some Desktop-generated names. |
| OpenCode CLI and Desktop | Implemented through the existing SDK/export session snapshot's `info.title` and `time.updated`. Existing session-update wake-ups deliver renames. |
| Codex cloud and ChatGPT Work | Implemented through existing thread metadata `name` and `updatedAt`. |
| Pi | [HYP-289](https://linear.app/hyperparam/issue/HYP-289/capture-pi-native-session-names-and-idle-renames): native `session_info.name` entries are a concrete follow-up. They are currently filtered from projected messages, and an isolated rename batch needs the last content timestamp carried from recovery to keep activity unchanged. |
| OpenClaw | [HYP-290](https://linear.app/hyperparam/issue/HYP-290/capture-openclaw-custom-and-generated-session-titles-including): native `label` (custom) and `displayName` (including generated names) are available. The current SQLite transcript discovery prefers `transcript_updated_at`; title-only changes need a separate metadata freshness witness before enabling capture. See [native schema](https://docs.openclaw.ai/reference/session-management-compaction/schema). |
| Cursor | Existing readers admit versioned CLI `meta.json` and editor composer metadata, but retain no verified name field. Add a native-schema fixture before mapping a title. |
| Copilot | Existing passive session metadata reconstructs identity and cwd, including mutations. It does not retain a title. A name must never substitute for the exact-session ownership check. |
| Hermes | The current session-column allowlist includes no native title. Verify supported store versions before extending it. |
| Droid | The current validated transcript header/message contracts supply no name. Do not derive one from prompts. |
| NanoClaw | Reuses Claude transcripts, but group/container names are not necessarily chat titles. No group label is promoted automatically. |
| Raw API, OTEL, LangGraph, Gascity and completion providers | No verified generated chat-name mapping in these collector contracts. Preserve supplied attributes; do not invent a title. |

This change respects existing recording, backfill-window and sweep opt-outs;
name collection runs when the owning provider scans. It does not enable a
previously disabled history-import lane. The dashboard needs the paired server
rollup change (server LLP 0658) and UI change (hypscope LLP 0124).
