# Recovering Cursor activity beyond hooks

**The missing information is often still available locally.** Cursor's native session stores retained full tool results and intermediate assistant messages that its hooks and display records omitted. Controlled recovery succeeded for both the editor and CLI. A bounded reader of those stores is the strongest way to improve capture while preserving ordinary Cursor usage. It uses a private format, so it needs compatibility checks and explicit incomplete-data handling before becoming a production source. [^1][^2]

Cursor also has supported SDK and Bridge interfaces with structured conversations, replay and usage. They are good options for programmatically launched runs, but their catalogs are separate from normal editor and CLI sessions. Enterprise usage APIs can supplement token accounting; neither those APIs nor Enterprise OTEL recover the missing conversation content. [^3][^4][^5]

## What the controlled sessions prove

The editor test used Cursor 3.19.19 and the existing disposable workspace. Recovery followed only that conversation's stored references. The CLI tests examined three completed disposable sessions produced by CLI 2026.09.08-6caf4ff. These were read-only inspections of already recorded activity, not new paid model runs. [^1][^2]

| Evidence | Hooks or display records | Recovered local records |
| --- | --- | --- |
| Editor assistant text | 5 final-response callbacks | 8 visible segments, including 3 intermediate messages |
| Editor tool coverage | 10 completed-tool callbacks | 12 tool results, including 2 missing dynamic-tool discovery calls |
| Small file read | Path and length; display storage also strips content | Exact 32-byte `notes.txt` result containing `MARIGOLD-42` |
| Grep | Pattern/success summary; display storage prunes match text | Actual matching lines, 3,740 characters in the editor test |
| Glob | Reported as Grep by generic hooks | Correct Glob identity and returned file lists |
| Dynamic tool discovery | No corresponding hooks | Search response and requested `cursor_dialog` schema |
| CLI Shell rejection | Generic callback claimed empty output and exit code 0 | Native result correctly identified both rejected calls |
| CLI assistant text | Headless response hooks absent | Intermediate and final text recovered from saved sessions |
| Identity | Response-delivery IDs; some helper-generated tool UUIDs | Native user IDs, turn request IDs, tool IDs, timestamps and visible assistant IDs |

The dynamic-tool records clarify an earlier uncertainty: Cursor discovered the `cursor_dialog` schema. That does not establish that it executed `cursor_dialog`. Likewise, retained tool output is the result Cursor stored or supplied to the model, not a promise of unlimited raw operating-system output. Tool-level clipping can occur before persistence. [^1][^2]

## Why the earlier capture looked incomplete

There are three different representations, and their fidelity differs substantially.

**Hooks are observations prepared by tool-specific code.** A generic completed-tool callback does not imply a verbatim result. Read and Grep were summarized even when their output was tiny. Some editor web-tool paths include useful content already, so the rule is not that every tool is summarized. The result depends on the executor and tool type. [^1][^3]

**Display bubbles are also deliberately reduced.** The editor's persistence code removes completed Read contents, strips Grep match text, reduces directory listings, and removes full before/after edit contents from the binary tool copy. It also has a size threshold for some MCP structured content. Decoding a display bubble's binary field therefore cannot restore everything: some content was removed before that field was written. [^1]

**The underlying agent graph is fuller.** It separately stores typed messages and tool-call steps for continuing the conversation. In the tested sessions, this graph still contained the omitted results and intermediate text. The successful recovery came from those records, not from rereading today's files or reconstructing what a command might have returned. [^1][^2]

This answers the size hypothesis more precisely. Size limits exist, but the observed 32-byte Read omission is a deliberate type-specific projection. Large results may still be clipped elsewhere, so a fuller source does not remove the need to represent truncation and missing data.

## The strongest passive recovery path

### Editor

The local `state.vscdb` database contains a conversation catalog and keyed records. A known conversation resolves to `composerData:<conversation-id>`. Its structured state references content-addressed blobs under `agentKv:blob:<hash>`. One set contains typed JSON prompt messages; another contains structured turns, user messages and steps. [^1]

The typed JSON preserves visible text, tool calls and model-visible results. The structured turns provide actual user message IDs, generation correlation, tool variants and timing. Their complementary strengths make them more useful than either flattened transcripts or display bubbles alone.

The controlled read verified the workspace association, bounded each record, checked blob hashes and projected only selected fields. It did not extract account credentials or encryption keys. The local blobs used by this path are readable without either. Thinking remained in separate typed variants and was excluded from the exported evidence. System prompts, the initial ambient-context message and provider metadata were also excluded. [^1]

### CLI

Ordinary CLI sessions persist a `store.db` beneath their workspace/session directory. The database records a latest state root and content-addressed blobs. The same broad graph structure is present: typed prompt messages plus user/assistant/tool steps. Read-only traversal recovered seven visible assistant messages and seven tool results across the three tested sessions, including the two properly represented Shell rejections. [^2]

This is more useful for ordinary CLI capture than relying on headless response hooks. The session can be recovered after execution even if no response callback arrived, and the native tool state corrects misleading hook summaries. It does not require replacing the user's normal CLI command with a wrapper.

### How to combine this with existing hooks

Use native records as the eventual source of the recorded conversation, with hooks providing prompt observation, lifecycle signals, useful file observations and recovery triggers. Keep the additional before-read observations already selected; they record a different moment from a completed file-read result. [^1][^2]

Do not simply append recovered messages to current hook rows. That would duplicate final responses and many tools. A small implementation should establish source precedence and reconciliation before publishing both representations as the same conversation.

The existing HypAware repository already uses Node's built-in SQLite support for another adapter. A bounded store reader is therefore feasible without a new runtime dependency. Decoding Cursor's private state descriptors and preserving the existing privacy/export rules remain implementation work. This report does not change the current adapter. [^14]

## Identity, timing and history require care

The private stores solve much of the missing information, but several findings rule out a naive importer.

**Native IDs are useful but not universally unique.** All eight visible editor text records had native `msg_*` IDs, while two tool-only assistant envelopes both used the ID `1`. A record hash is not sufficient either: legitimate repeated messages can have identical content. Identity must account for conversation, turn and occurrence, using stronger native IDs where their contract is demonstrated. [^1]

**Shell hook IDs do not match native tool IDs.** Eight editor tool results matched hook IDs exactly. The two Shell hooks used different helper-generated UUIDs. The two dynamic discoveries had no corresponding hook. Joining Shell records by command text or timestamp would be unsafe when the same command runs twice. The five native turn request IDs did match the five nonempty hook generation IDs, which supplies a useful turn boundary. [^1]

**Invocation order and completion order differ.** Two parallel Glob steps were persisted in completion order, while the assistant's tool-call list represented invocation order. Native start/completion timestamps provide better evidence than list position. Some assistant completion timestamps are absent; absence should remain unknown. [^1][^2]

**The latest prompt timestamp is not a completion cursor.** In the editor sample, the catalog's last-updated value reflected the final prompt, while its checkpoint timestamp advanced after the response finished. A recovery poll based only on the prompt timestamp could miss later writes. Read the actual checkpoint/state and permit bounded retries for temporarily missing references. [^1]

**History completeness is not established yet.** The schema has summary archives, nested subagent states and older state references, but these experiments did not exercise compaction, branching, restart, deletion, retention, remote workspaces or many models. Those are concrete acceptance cases. The existence of archive references is evidence for a recovery mechanism, not a guarantee that all previous content remains on disk. [^1][^2]

## Supported alternatives and their limits

| Route | What it can add | Works with ordinary local use? | Recommendation |
| --- | --- | --- | --- |
| Native editor/CLI stores | Visible messages, richer tool results, IDs, timing, saved history | Yes, proven on disposable sessions | First implementation candidate; private compatibility contract |
| CLI `stream-json` | Live text and native tool results | Requires capturing the launched CLI process | Useful explicit runner; saved-store recovery is more transparent |
| CLI ACP | Client-facing updates, load/list and replay | ACP sessions use a separate store | Integration option; replay can synthesize IDs and lose status fidelity |
| SDK / SDK Bridge | Structured conversations, durable run events, resume offsets, usage | SDK-managed runs only | Best supported explicit-run route |
| Additional file-edit hook | Old/new edit hunks | Yes | Narrow supplemental observation after a real edit probe |
| Specialized MCP hook | Server attribution and mapped MCP result | Yes | Usually duplicates generic result content |
| MCP protocol wrapper | Original responses from routed MCP servers | Requires routing changes | Only for specific missing MCP fields |
| Enterprise Admin usage API | Historical usage and optional conversation association | Yes, server-side metadata | Usage companion when eligible |
| Enterprise OTEL | Request usage, attribution and operational events | Yes, after enterprise configuration | Metadata companion, no conversation-content recovery |
| Cloud Agent SSE | Rich events and replay for cloud runs | No, separate workflow | Future cloud source |
| Share/export UI | Conversation snapshot | Manual sharing workflow | Unsuitable for automatic local capture |
| Native network proxy | Potentially detailed live protocol content | Requires routing/trust changes | Defer; more intrusive and less proven than local recovery |

### SDK and Bridge

The supported SDK offers saved agents/runs, structured `run.conversation()`, streaming tools and text, and per-turn usage. SDK Bridge exposes an authenticated local protocol with run catalogs, conversation reads and resumable observation. Its versioned protocol is a stronger supportability contract than the private editor graph. [^4][^6]

However, the published SDK implementation uses its own store/catalog layout. Ordinary CLI sessions and editor conversations are not automatically in that catalog. Attaching to an existing Bridge endpoint means an already running SDK Bridge, not an arbitrary Cursor editor process. It should be offered as a separate integration for intentionally managed runs. [^2][^3]

Replay itself needs care. Bridge observation offsets are distinct from send-stream offsets; substituting one can skip events. The CLI ACP replay path also synthesizes some tool IDs and completion statuses, making raw native state a better evidence source for failures. A successful ACP initialize verified that the hidden command exists in the tested CLI, but it did not establish access to ordinary CLI histories. [^2]

### Specialized hooks and MCP

`afterFileEdit` can add actual old/new edit hunks. It is a useful candidate where generic write results lack edit detail. It has no documented native tool-call ID, so it should remain a separate observation until a reliable match is proven. [^3][^7]

The current editor sends the same mapped result string to specialized `afterMCPExecution` and generic `postToolUse`. Text and images survive that mapping, while unsupported content kinds can become `unknown`. Adding the specialized callback does not undo the mapper. A protocol wrapper could preserve the original MCP response for selected servers, but would not observe built-in Read/Grep/Shell or general assistant messages. [^3]

The documented hooks do not provide a special result callback for every built-in tool. Subagent stop supplies a summary and transcript pointer, and Tab hooks cover inline file activity rather than complete Agent turns. Extra hooks alone cannot close all the gaps. [^7]

### Network and extension routes

Installed Cursor code has native interaction updates, tool RPCs, checkpoints and blob transfer in its Connect/protobuf protocols. A properly implemented proxy could observe some of that live data. It would also need to handle bidirectional streams, retries, blob references and changing protocol versions, while excluding thought variants and credentials. Official network guidance warns that TLS inspection can disrupt streaming. [^3][^11]

BYOK still routes requests through Cursor servers; it is not a documented direct OpenAI-compatible capture route. Private extension APIs are proposal-gated and important runtime operations additionally require a built-in extension identity. Cursor's tracing API emits telemetry; it is not a global conversation subscription. The NDJSON debugging extension ingests application debug logs rather than exporting Cursor conversations. These routes offer no demonstrated advantage over the recovered local stores. [^3][^12]

## Usage is a separate problem

The current Admin API documents historical usage events with an optional `conversationId`, model and four token counters. It can supply session-attributed usage without deploying a public protobuf OTEL collector. It is still an Enterprise/admin interface. Hourly polling is recommended, pages are bounded, and conversation association is not always available. The response does not document a unique event ID, so correction and deduplication behavior must be established. [^5]

There is stronger official evidence for token semantics than the hook page alone. The SDK defines total tokens as input plus output plus cache-read plus cache-write. Reasoning tokens are already part of output and must not be added again. SDK stream usage is per reporting turn; result usage is cumulative. The Cloud usage API gives the same additive definition and links its counts to the Admin usage format. [^4][^8]

That is evidence against subtracting cache-read from those APIs' input counts. It also explains why a cache count larger than input need not be contradictory. The existing hook fields still need a verified link to the same producer semantics before changing their canonical normalization. Native context-window occupancy is not billed usage. [^1][^3][^4]

Enterprise OTEL remains useful for attribution and request usage, but ordinary tool events are aggregate metrics rather than complete per-call content. It requires a publicly reachable OTLP/HTTP protobuf receiver; the current HypAware listener accepts JSON. It does not fill the content gaps proven recoverable locally. [^9][^14]

## Recommended implementation sequence

1. **Add bounded native-store recovery for the known editor and CLI formats.** Reuse the controlled fixtures, project visible user/assistant/tool records, and preserve explicit unknown or missing states. Prefer structured tool status over misleading generic callback success.
2. **Resolve hook/native reconciliation before enabling combined conversation capture.** Make native identity authoritative where proven; retain file and lifecycle observations as such. Do not deduplicate by text or claim arbitrary envelope IDs are unique.
3. **Validate the unsupported boundaries with real clients.** Exercise repeated identical messages and commands, parallel tools, restarts, active database writes, compaction, session deletion, subagents, large outputs and an upgrade. Include a fixture that fails clearly on an unknown shape.
4. **Keep usage integration independent.** Establish hook token semantics, or add an eligible Admin/OTEL source with a clear identity and correction contract. Do not add several copies of the same turn's usage.
5. **Offer SDK/Bridge capture only as an intentional workflow option.** It has excellent replay support but should not become a prerequisite for normal editor or CLI recording.

This sequence addresses the largest proven gaps without placing a proxy in the model-request path. Production work should follow the existing privacy admission and export policy at both read and write time, and preserve the selected extra file observations.

## Resource and compatibility assessment

No production code changed during this investigation, so there is no new runtime CPU or memory regression to assess. The proposed reader has clear cost controls: indexed lookups, limits on record bytes and graph traversal, short read transactions, bounded concurrency, checkpoint-based incremental work and limited retained deduplication state. [^1][^2][^3]

Avoid loading entire conversations on every hook, polling every stored blob, retaining an unbounded hash cache, or holding SQLite snapshots for long periods. Long snapshots can prevent WAL reclamation. Missing graph edges should cause a bounded retry, not a busy loop. Full tool results increase stored data volume, so normal capture limits and truncation reporting still apply.

Confidence is high that the tested native stores can recover substantially more than hooks. Confidence is moderate that a small passive adapter can support these exact versions economically. Cross-version stability, exhaustive history, remote workspaces and complete normalized billing remain unproven. Those limitations are specific validation work, rather than reasons to settle for hook summaries.

## Sources

Primary documentation and installed implementation evidence were examined September 10, 2026. Public pages did not consistently expose publication dates. Version-specific findings are deliberately tied to the tested builds. The full source ledger and reproduction notes are in [SOURCES.md](SOURCES.md).

[^1]: [Editor storage findings and controlled evidence](work/WP1-editor-storage.md), Cursor 3.19.19.
[^2]: [CLI, ACP and SDK findings and controlled evidence](work/WP2-cli.md), CLI 2026.09.08-6caf4ff.
[^3]: [Supported-interface and transport findings](work/WP3-interfaces.md), with installed-code hashes and source anchors.
[^4]: Cursor, [TypeScript SDK](https://cursor.com/docs/sdk/typescript), especially Token usage, Stream events, Conversation turns and Local agent stores.
[^5]: Cursor, [API overview](https://cursor.com/docs/api) and [Admin API: Get Usage Events Data](https://cursor.com/docs/account/teams/admin-api).
[^6]: Cursor, [SDK Bridge](https://cursor.com/docs/sdk/bridge) and [published service protocol](https://github.com/cursor/sdk-bridge/blob/main/proto/sdk/v1/sdk_agent_service.proto).
[^7]: Cursor, [Hooks](https://cursor.com/docs/hooks).
[^8]: Cursor, [Cloud Agents endpoints](https://cursor.com/docs/cloud-agent/api/endpoints), especially Stream a Run and Get Agent Usage.
[^9]: Cursor, [OpenTelemetry Export](https://cursor.com/docs/enterprise/opentelemetry-export) and [Wire Reference](https://cursor.com/docs/enterprise/opentelemetry-export/wire).
[^10]: Cursor, [Shared transcripts](https://cursor.com/help/ai-features/shared-transcripts).
[^11]: Cursor, [Network configuration](https://cursor.com/docs/enterprise/network-configuration).
[^12]: Cursor, [Bring your own API key](https://cursor.com/docs/settings/api-keys).
[^13]: Cursor, [CLI ACP](https://cursor.com/docs/cli/acp) and [output format](https://cursor.com/docs/cli/reference/output-format).
[^14]: HypAware, existing [SQLite adapter](../../hypaware-core/plugins-workspace/hermes/src/state_db.js), [OTLP listener](../../src/core/otlp/server.js), and [Cursor capture evidence](../../docs/cursor-capture-evidence.md).
