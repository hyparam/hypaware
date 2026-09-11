# WP2: CLI storage, ACP, persistence, and SDK Bridge

Investigated September 10, 2026. CLI: isolated `2026.09.08-6caf4ff`. Public SDK package inspected: `@cursor/sdk` 1.0.31. No paid model calls, credential extraction, global changes, or unrelated conversations were used in this work package.

## Findings that change the recommendation

**Ordinary CLI sessions already persist substantially more than hooks expose.** Three completed disposable sessions have a content-addressed SQLite conversation graph. A bounded read-only probe recovered seven visible assistant messages with native `msg_*` identities and seven tool results, including the full Read contents, matching Grep line, correct Glob name and file list, missing-file error, and both rejected shell calls. Those rejected shells had misleading successful hook completions. This is actual recovery from an exited CLI, not a hypothetical new wrapper.

**ACP works, but is less suitable for this job than its protocol initially suggests.** The hidden command initializes successfully and advertises session loading/listing. It stores ACP sessions separately from normal CLI chats, synthesizes replay tool IDs from turn/step positions, drops useful argument fields, summarizes Grep/Glob results, and marks replayed tools completed. It cannot be treated as a faithful dump of the ordinary CLI.

**The public SDK/Bridge is a much better supported controlled-run surface.** It has normalized live events, durable run-event recovery, structured conversations, and explicit per-turn usage. However, SDK agents have separate stores/catalogs; its resume/list APIs do not automatically discover normal editor or CLI sessions. It is a compelling option if the user elects to run work through a new integration, not a replacement for passive recovery.

## Evidence and sources

| ID | Source | Evidence class |
| --- | --- | --- |
| C1 | [CLI output format](https://cursor.com/docs/cli/reference/output-format) | Current official doc; fetched September 10 to `/tmp/cursor-gap-output.md`. |
| C2 | [CLI ACP](https://cursor.com/docs/cli/acp) | Current official doc; fetched September 10 to `/tmp/cursor-gap-acp.md`. |
| C3 | [CLI changelog](https://cursor.com/docs/cli/changelog) | Current official doc; fetched September 10 to `/tmp/cursor-gap-cli-changelog.md`. Latest entry August 26. |
| C4 | Isolated CLI bundle `/tmp/hypaware-cursor-cli-probe` | Static source, exact tested CLI release. Module names below survive bundling. |
| C5 | Three known disposable CLI databases under `/tmp/hypaware-cursor-live-probe/home/.cursor/chats/39318caf4103178610e8d4f5926b1f69/` | Actual read-only local recovery from previously authorized sessions. |
| C6 | [TypeScript SDK](https://cursor.com/docs/sdk/typescript) | Current official doc retrieved by WP3; local copy `/tmp/cursor-wp3-sdk.txt`. |
| C7 | [SDK Bridge](https://cursor.com/docs/sdk/bridge) | Current official doc; fetched September 10 to `/tmp/cursor-gap-sdk-bridge.md`. |
| C8 | [Bridge streaming semantics](https://github.com/cursor/sdk-bridge/blob/main/docs/streaming.md) | Public Cursor repository, fetched September 10. |
| C9 | [Bridge agent protocol](https://github.com/cursor/sdk-bridge/blob/main/proto/sdk/v1/sdk_agent_service.proto) | Public Cursor repository, fetched September 10. |
| C10 | [Published SDK 1.0.31](https://registry.npmjs.org/@cursor/sdk/-/sdk-1.0.31.tgz) | Public npm tarball, downloaded and unpacked solely for static inspection in `/tmp/cursor-gap-sdk-src`. No package installation or runtime execution. |

Non-suffixed Cursor documentation URLs worked. The `.md` ACP URL returned 404 in this run, even though the previous study retained a successful September 9 fetch. The content at the current URL matches the material used here.

## Actual CLI recovery

### Discovery and structure

The ordinary CLI path is:

`<Cursor config directory>/chats/<md5(absolute workspace path)>/<session UUID>/store.db`

The CLI's `src/state/index.ts` module in `1652.index.js` computes precisely this. It uses `cursor-config/dist/paths.js`'s config root: `CURSOR_CONFIG_DIR`, then `XDG_CONFIG_HOME/cursor`, then `~/.cursor`. This differs from transcripts, which use the data/projects root. A future adapter must not assume the two overrides are interchangeable.

`cursor-sdk-local-runtime/dist/run-store/sqlite-blob-store.js`, in `7261.index.js`, initializes:

- `blobs(id TEXT PRIMARY KEY, data BLOB)`
- `meta(key TEXT PRIMARY KEY, value TEXT)`
- WAL journaling, `synchronous=NORMAL`, and SQLite `user_version=1`.

Meta key `0` is a hex-encoded JSON metadata document. Its `latestRootBlobId` points at a protobuf `agent.v1.ConversationStateStructure` blob. Metadata contains fields beyond the capture contract, so the probe only exports the session ID and root pointer. No full metadata export is appropriate.

`agent-kv/dist/index.js` in `index.js`, `handleCheckpoint`, serializes the new root, hashes it, writes the root blob, then updates `latestRootBlobId`. The default is SHA-256 content identity, not an append-only message log. All graph blobs followed by the probe passed SHA-256 verification.

Important root fields in the current generated `agent.v1` schema:

| Field | Meaning | Capture value |
| --- | --- | --- |
| `1 root_prompt_messages_json[]` | Repeated blob references to model-facing JSON messages | Native assistant/tool identities, text, arguments and model-visible results. |
| `8 turns[]` | Repeated references to typed conversation turns | User message ID, request ID, structured tool outcomes and timestamps. |
| `5 token_details` | Used/max context tokens and prompt breakdown | Context occupancy, not per-turn consumption. Do not normalize into spend. |
| `13 summary_archives[]` | References to summary archives | Potential access to older compacted messages; not yet acceptance-tested. |
| `14 turn_timings[]` | Typed timing data | Additional timing candidate. |
| `16/31 subagent_states/subagent_state_refs` | Nested/reference state graphs | Potential explicit lineage/recovery; controlled main-session proof only here. |

The model-facing JSON messages are a useful discovery: they are already ordinary structured JSON inside the same database. They do not need a full implementation of every internal protobuf tool schema. The root needs a narrow protobuf reader, after which JSON role/content whitelisting can select visible `text`, `tool-call` and `tool-result` blocks. Thought blocks are distinct and were excluded before query results left SQLite.

### Proven results

| Session ID | Visible assistants | Tool results | Recovered evidence |
| --- | ---: | ---: | --- |
| `0eb801c8-1d88-4294-a6a6-925c3eefe5c5` | 2 | 1 | Intermediate text, final answer, native assistant IDs, full 32-byte Read result. |
| `7909a4ec-49bf-48af-bf2e-8a38a369bd6b` | 2 | 1 | Same successful Read coverage from an independent run. |
| `ec2e6c5a-9456-463f-b917-7fd3f2f3a416` | 3 | 5 | Grep match with line number, Glob with two filenames, two rejected Shell calls, missing Read error. |

The two Read results contain exactly `The probe value is MARIGOLD-42.\n`. Hook post-read results retained only the length. The Grep JSON result contains line 1 and its matching text. Glob is represented as `Glob`, where the hook was labeled `Grep`. Shell model-facing result text says `Rejected: `, and the typed graph confirms `ShellResult` variant 4 (`rejected`), rather than relying on a text heuristic.

Five of seven recovered tool IDs occur verbatim in recorded hook payloads. The two unmatched IDs are the rejected Shell calls, consistent with the previous discovery that CLI shell hooks generated different IDs. Thus the graph fixes content/status but does not justify a universal hook-to-history join for every tool.

Recovery artifacts:

- [Typed graph probe](../spikes/cli-store-probe.py) and [filtered result](../spikes/cli-store-result.json).
- [JSON-message probe](../spikes/cli-prompt-probe.py) and [filtered result](../spikes/cli-prompt-result.json).

Both are disposable research probes tied to the exact authorized workspace. The typed probe omits thinking-message payloads before UTF-8 decoding. The JSON projection uses SQLite JSON queries to return only selected visible blocks. Neither is a production importer.

### Identity, history and finality cautions

1. **Assistant identity is materially better than the hooks.** All seven visible assistant messages have native `msg_*` IDs in JSON. Typed assistant steps themselves have no message ID, only text/timing. Use the JSON ID where present; do not identify a message only by its text or blob hash. Blob hashes are revision/content identity and can change as a message changes.
2. **Tool results have native IDs and outcomes.** The typed `ToolCall` has `tool_call_id` (field 57), started/completed timestamps (59/60), and a result union. The JSON tool message ID matches its `toolCallId` in these samples. The typed graph also disambiguates terminal status that ACP/hooks lose.
3. **User identity and request attribution exist in the typed graph.** `UserMessage.message_id` and `AgentConversationTurnStructure.request_id` were present in all three sessions. Root JSON includes injected system/user context as well as real prompts. A generic role=user import would incorrectly classify injected workspace context as user speech. Recover real user prompts through typed turns or a proved join, not every root user message.
4. **The latest checkpoint is not guaranteed full historical retention.** Compaction, rewind/fork, deletion, migrations and missing blobs still need explicit tests. The schema has summary archives but their retention and identity contract was not tested. Do not scan every orphan blob to manufacture history; use reachable graph roots and bounded recovery rules.
5. **Timestamps are partial.** Intermediate assistant steps have start/end values, but the final assistant step's completed timestamp was absent in all three exited sessions. Missing completion time cannot by itself mean incomplete output.
6. **Do not treat missing properties as empty successful values.** The typed failure records in the probe had sparse tool args while the root JSON retained the actual requested path/command. The layers complement each other.
7. **These are private persisted formats.** Schema/module evidence and real observations establish feasibility, not a supported backwards-compatibility promise. Require version/shape gates, bounded reads, failure telemetry and acceptance probes.

### Resource and read safety

The three stores had 20, 20 and 35 blobs, containing approximately 52 KB, 52 KB and 90 KB respectively. The probe used exact primary-key lookups and a 1 MiB per-protobuf bound, never scanned unrelated stores, and opened completed databases read-only with `immutable=1` after observing no WAL siblings.

That immutable shortcut is suitable only for these quiescent samples. A production live reader needs proper WAL-aware read-only snapshots and bounded busy/retry behavior. An adapter should watch root/DB changes, skip unchanged roots, fetch only unseen reachable references, cap records/bytes and release SQLite connections promptly. Repeatedly deserializing the entire conversation on each hook would introduce CPU/allocation costs proportional to conversation length. No production performance claim follows from these small probes.

## ACP: supported, available, and lossy

C2 documents JSON-RPC over newline-delimited stdio, session new/load, permission requests and Cursor extension methods. The current CLI declares `acp` hidden in its command registration, explaining why normal help did not list it.

A no-model probe sent only `initialize` with protocol version 1. The real executable immediately returned:

- `protocolVersion: 1`
- `loadSession: true`
- `sessionCapabilities.list: {}`
- HTTP/SSE MCP capabilities and image prompt support
- `cursor_login` auth method.

No authenticate, new-session or prompt request was sent. The process was terminated after its initialization response.

Static current implementation in `7578.index.js`:

| Module/method | Finding |
| --- | --- |
| `src/acp/acp-storage.ts` | Stores sessions in `<Cursor config directory>/acp-sessions/<id>/store.db` with a `meta.json` sidecar. |
| `src/acp/session-list.ts` | Enumerates that ACP directory; does not enumerate ordinary CLI `chats`. Reads all sidecars before cwd filtering; no pagination cursor support. |
| `src/acp/agent-store.ts` | `session/load` resolves the ACP store path and fails if absent; normal CLI chat IDs are not a bridge into CLI history. Opens stores through the writable native implementation and updates sidecars. |
| `replayAgentTurn` | Emits visible text and separate thought chunks, then calls `replayToolCall(tool, replay-<turn>-<step>)`. |
| `replayToolCall` | Synthetic positional tool IDs; unconditionally emits status `completed`. |
| `extractToolCallInput` | Selected fields, not full inputs; for example Read retains path but not range and Grep retains pattern/path only. |
| `extractToolCallOutput` | Read content and successful/failing Shell stdout/stderr/exit code are available; Grep returns totals/truncated, Glob totals/truncated, MCP success often just success=true. |
| `extractToolCallContent` | Primarily edit/delete diffs; does not restore discarded Grep/Glob results. |

The ACP stream is a custom-client UI contract, not a faithful event archive. `session/load` also initializes shared services/model configuration and client resources; it is not a pure offline read. Owning an ACP client implies answering permissions and blocking extension methods. Its separate store and lossy replay make it inferior to direct scoped graph recovery for ordinary use.

## Stream JSON and persistent terminal sessions

C1's `--output-format stream-json` remains a practical fully supported way to capture new explicitly launched headless work. It reports assistant segments and native tool lifecycle/results; the previous controlled probes established full Grep/Glob results and correct native Shell rejection. It has no general native assistant-message ID contract and is tied to print mode. The terminal `result` repeats the aggregate response and must not be ingested as a second assistant message.

`--stream-partial-output` adds repeated buffered flushes and duplicate final text. Avoid it for economical event capture unless a UI needs token-by-token rendering. The current docs' statement about suppressed thinking does not match previously observed thought events, so filter explicitly.

C3 says `agent persist` survives terminal/SSH disconnects; `persist attach/list/stop` are lifecycle commands. `src/persistence/persistent-session.ts` in `index.js` implements this through tmux sessions, launch metadata, a chat binding and terminal attach. It adds no documented event subscription/export contract. Tapping terminal output would inherit rendering, truncation, replay and user-input ambiguity, while the same underlying conversation store is already available. No persistent-session state or environment files were opened because they are unnecessary for recovery and may contain environment secrets.

## SDK and Bridge: the supported alternative for new controlled work

C6 documents `@cursor/sdk` local agents, per-run streams, `run.conversation()`, `Agent.list/get/listRuns/getRun`, `Agent.messages.list`, stores and per-turn usage. C7/C8/C9 add a first-party standalone bridge exposing stable `sdk.v1` Connect RPCs, including `ObserveRun`, `GetRunConversation`, `ListAgents`, `ListRuns`, and `ListAgentMessages`.

### What improves

- Stable event envelope: `agent_id`, `run_id`, type, tool `call_id`, name and status. Tool args/results intentionally remain internal and must be parsed defensively.
- Live tool events include args/results and explicit truncation flags. `onDelta`/`onStep` provide lower-level observations when needed.
- `usage` events provide per-turn totals once each reported turn ends; cumulative usage lives on the run/result. Unknown remains undefined.
- SDK stores include durable agents, checkpoints, run records and run events. Custom stores and the JSONL store are documented interfaces.
- Bridge `ObserveRun` replays durable events and follows a live run, using exclusive opaque offsets. This is a real recovery contract, unlike hooks alone.

### Limits relevant to HypAware

- **Different storage and workflows.** Static C10 confirms the default SDK state root is `~/.cursor/projects/<workspace slug>/sdk-agent-store/<md5(workspace)>`, with `index.db` agents/runs catalogs and `agents/agent-<sha256(agentId)>/store.db` checkpoints. This is distinct from ordinary CLI config-root `chats` and ACP `acp-sessions`. No reviewed API documents importing or passively attaching to native editor/CLI conversations.
- **Authentication is distinct.** The SDK explicitly does not auto-discover credentials from the installed Cursor app. It accepts a user/service API key or its own supported browser-login flow. We did not initiate auth or any SDK model call.
- **Assistant IDs still need care.** The documented normalized assistant event has agent/run IDs but no native assistant message ID. `Agent.messages.list` advertises a UUID, but C10's current `getAgentMessages` implementation returns positional IDs `${agentId}:${offset + turnIndex}` from typed conversation turns. This is not equivalent to the native `msg_*` IDs found in the raw graph.
- **Offsets are stream-specific.** C8 warns that passing a live `Send` offset to durable `ObserveRun.after_offset` can skip events. Recover a dropped Send by replaying ObserveRun from the beginning, or from a previous ObserveRun offset. Do not conflate offsets merely because C9's proto comment currently says prior ObserveRun/Send; the detailed docs explicitly narrow the safe rule.
- **Payload size truncation is explicit.** The SDK docs say `truncated.args/result` signals payload-size reduction. This is separate from the unconditional per-tool summarization in hooks/ACP.
- **Not every re-fetched run supports streaming.** C6 documents `supports()`/`unsupportedReason()` and `UnsupportedRunOperationError`; account for runtime/version capabilities and use durable Bridge observation where supported.
- **Dependency and UX costs remain.** Running the SDK would add a substantial runtime/dependency stack; the standalone Bridge avoids an npm dependency in HypAware but still needs binary lifecycle, token handling and Connect framing. This is not a small drop-in addition under the repository's no-new-runtime-dependencies rule.

Static source locations for C10: `dist/esm/index.js` module `src/agent/...workspace state root` containing `sdk-agent-store`; `dist/esm/856.js` module `sqlite-agent-run-store.js`; `dist/esm/730.js` module `agent-checkpoint-store.js`; `dist/esm/index.js` method `getAgentMessages`. The package was downloaded, unpacked and inspected; none of its code was executed.

## Ranked next implementation candidates

1. **Version-gated scoped CLI graph recovery**, paired with the editor's same graph family. It fills the actual passive-use gaps with real proof: visible intermediate text, native IDs, full model-facing tool outputs and stronger typed outcomes. Before production work: test resume/compaction/rewind, live WAL snapshots, source policy and live/history convergence. Preserve the extra beforeReadFile observations as the user requested, but keep their identity separate.
2. **An explicit SDK/Bridge or stream-json runner** if the user wants a supported new-work integration. Prefer the SDK/Bridge for durable recovery contracts; stream-json is smaller for a simple invocation wrapper. This requires a workflow choice, not merely enabling telemetry.
3. **ACP only for existing ACP clients**, where capture can sit in a user's chosen client or proxy. It does not solve ordinary Cursor passive capture and still loses important tool detail.
4. **Do not pursue tmux/terminal scraping or flattened transcripts as the next fallback.** They add avoidable ambiguity when the stored graph already preserves the needed records.
