# WP1: editor storage recovery

## Finding

Cursor 3.19.19 keeps three materially different representations: observational hooks, pruned display bubbles, and a fuller local agent state graph. The graph recovers the missing tool results and intermediate assistant text in the controlled editor conversation. This is an observed private format, not a supported export contract.

The read-only probe is [editor-storage-probe.py](../spikes/editor-storage-probe.py); its selective, thought-excluding evidence is [editor-storage-evidence.json](../spikes/editor-storage-evidence.json). It targets only `a04677b4-01ac-478d-a4ef-37ab5ddd0d9a`, verifies the disposable workspace path, uses a read transaction and per-record 1 MiB limit, and verifies blob SHA-256 pointers. No keys, provider options, selected context, system prompts or thought content are exported.

## Observed coverage

| Item | Native hooks | Structured local graph |
| --- | --- | --- |
| Actual user turns | 5 beforeSubmitPrompt | 5 structured UserMessage records with native IDs |
| Visible assistant text segments | 5 afterAgentResponse | 8 visible text segments, including 3 intermediates |
| Tool executions/results | 10 postToolUse | 12, including 2 GetDynamicTools absent from hooks |
| Read | path and content length | 4 results; 3 exact 32-byte notes reads and 1 hooks-file read |
| Grep | success/pattern summary | 3,740 characters of matching lines, including line 1 with MARIGOLD-42 |
| Glob | presented as Grep | correct Glob name plus actual file lists on 3 calls |
| Shell | output, helper IDs | model-visible result text with exit status; native tool IDs/timestamps in steps |
| Dynamic tool discovery | no corresponding callback | search results and cursor_dialog schema, with native tool IDs |

The `cursor_dialog` record is tool discovery of its schema, not proof that Cursor executed that tool. The earlier assistant statement alone was insufficient; the native graph resolves the distinction.

## Exact storage path and traversal

The database is `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb`. Observed tables include `composerHeaders`, `cursorDiskKV`, and `ItemTable`. `cursorDiskKV.key` has a unique index. `composerHeaders` has indexed workspace/subagent/archive/recency and recency/composerId access paths.

1. Resolve only the known conversation: `composerData:<conversation-id>`.
2. Read the allowlisted `workspaceIdentifier` path and `conversationState` property. In this build, state is `~` followed by base64 protobuf bytes. Legacy code also accepts hex.
3. Decode the current `agent.v1.ConversationStateStructure` descriptor. Field 1 is repeated `root_prompt_messages_json` blob references, field 8 is repeated turn references, and field 13 is summary archive references. References are 32-byte hashes.
4. Read exact keys `agentKv:blob:<hex-hash>`. The current local values are plain binary data, not encrypted remote blobs. No encryption keys or account credentials are needed.
5. Field 1 references JSON messages. SQL JSON path projection extracts only visible text, tool-call arguments, tool-result values and identity. System messages and the initial large synthetic user context are excluded. The graph has 29 root messages, of which 22 are assistant/tool messages.
6. Field 8 references `ConversationTurnStructure` and then `AgentConversationTurnStructure`: user-message reference, step references and request ID. `UserMessage` supplies actual prompt text and native message ID without copying selected context. Steps distinguish assistant text, tool call, and thinking. The probe skips the thinking payload entirely.

The local graph's source is the installed `workbench.desktop.main.js`, SHA-256 `b58c85c5304741e433b21dbfb2714d39f8c7ced47ceb1112a001ee8c3edb8846`. Relevant searchable symbols: `agent.v1.ConversationStateStructure`, `agent.v1.AgentConversationTurnStructure`, `agent.v1.ConversationStep`, `agent.v1.UserMessage`, `composerBlobStore.js`, `function Ehd`, `function Dhd`, `function mwf`.

## Why ordinary bubble extraction is insufficient

`bubbleId:<conversation-id>:<bubble-id>` records retain stable visible message identities and native tool metadata. They correctly distinguish Glob from Grep and contain missing GetDynamicTools records. But they deliberately discard useful content:

- `Ied`, under `serializeToolformerBubbleData.js`, removes completed Read contents and converts Grep/List results into a pruned summary.
- `fff` empties the Read output even inside the binary tool-call copy; `YFi` removes Grep match content while retaining structure.
- Edit binary persistence removes before/after full file contents and diff strings.
- Large MCP structured content is dropped beyond `Red = 256 * 1024` in the binary serialization path.

These operations apply by tool type. A 32-byte Read is pruned too. Therefore size alone does not explain the omissions, and decoding the bubble's binary field does not recover what has already been stripped. The separately stored agent graph retained the underlying results in the tested session.

Flattened transcript JSONL is also weaker. `Dhd` combines `text` and `thinking` into one text block and emits tool-use names/inputs without IDs. The underlying JSON messages preserve typed blocks, native IDs and result bodies. A safe recovery source should use the structured graph rather than regex-remove thoughts from flattened text.

## Identity and ordering findings

The 5 structured turn `request_id` values exactly match the 5 nonempty hook generation IDs. Actual user message IDs match user bubble IDs. All 8 visible assistant message records have native `msg_*` IDs in this sample. However two tool-only assistant envelopes both have ID `1`, so a raw message ID is not guaranteed unique even within one conversation. Content hashes alone also cannot identify legitimate repeated messages: any implementation needs occurrence identity and turn/step structure.

Eight native tool-result IDs match hook IDs exactly. The remaining four native results are the two missing dynamic discoveries and two Shell calls. Shell hooks use helper-generated UUIDs instead of the native tool IDs in both editor examples. Do not deduplicate those by time or command text: legitimate repeated commands make that lossy.

The protobuf graph and JSON messages sometimes encode an embedded newline differently from the display bubble. Source-aware normalization must be tested before treating these spellings as interchangeable. It was unnecessary for the eight matching hook IDs.

Parallel Glob steps were persisted in completion order in one turn, whereas the assistant tool-call list records invocation order. These are different, valid orders. Start/completion timestamps are available in native tool steps and should drive timing, not list position.

## Update and history limits

The observed `composerHeaders.lastUpdatedAt` is `1789077893408` (last prompt), while `checkpointAt` and `conversationCheckpointLastUpdatedAt` are `1789077907577` (after completion). A cursor based only on lastUpdatedAt can miss writes made after a turn starts.

The graph references summary archives and nested subagent state, which offer plausible recovery through compaction and parent-child attribution. This probe has no compaction, subagents, restart, archive/deletion, provider diversity or long-session coverage. Their existence in the schema is not proof of complete retained history. Cursor can remove data, graphs can be temporarily incomplete, and private formats can change on upgrade.

Prefer hook-triggered/debounced reads plus a bounded scheduled recovery pass using the current checkpoint, with missing/oversize/unknown-format records surfaced as incomplete. Do not automatically scan unrelated history during attachment merely because a global database is accessible.

## CPU and memory assessment

No production path changed. The spike uses indexed exact-key lookups, a short SQLite read transaction, explicit record/reference bounds and no global content scan. It hashes each reached blob and materializes selected text in the evidence document; this is appropriate for this small study, not a production performance model.

A production reader should bound graph depth, blobs/bytes per pass, concurrency and retained identity state; avoid whole-database copies and loading entire histories on every hook. Long SQLite snapshots can retain WAL pages, so release transactions promptly and retry missing graph edges. Timestamp-only polling, unbounded content-addressed caches and full-file exports on each event would cause avoidable CPU/memory or disk costs.
