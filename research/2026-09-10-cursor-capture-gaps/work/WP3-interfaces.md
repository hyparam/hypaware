# WP3: supported interfaces and native transport

Access date: 2026-09-10. Scope: public Cursor documentation, published SDK Bridge protocol, and installed Cursor 3.19.19 application code. No account API was called, model run launched, certificate installed, credential inspected, unrelated conversation read, or installation modified. WP1/WP2 own the controlled local-store tests.

## Finding

There are useful alternatives, but they serve distinct jobs. The native editor and CLI stores established by WP1/WP2 are the strongest passive content recovery candidates. Additional hooks have narrow value. Cursor's supported SDK now offers much more complete events and replayable structured history for SDK-managed runs. Enterprise Admin usage events can supply historical session-attributed usage without an OTEL receiver. A native transport tap has broad theoretical coverage but significantly worse maintenance and operational costs than reading the already persisted native records.

### Coverage matrix

| Route | Additional content or metadata | Identity and recovery | Ordinary editor/CLI use | Evidence and recommendation |
| --- | --- | --- | --- | --- |
| `afterFileEdit` hook | Actual old/new edit hunks | Conversation/generation, no documented tool-call ID; live only | Yes, documented | Narrow useful observation after a controlled edit probe; do not synthesize a tool match. |
| `afterMCPExecution` hook | Text/image MCP result plus server attribution | No extra tool ID in specialized payload; live only | Yes | Static editor code sends the same serialized result to generic `postToolUse`; usually redundant. |
| MCP transport wrapper | Original MCP protocol input/result, potentially fields dropped by Cursor's hook mapper | MCP request IDs, but no guaranteed global Cursor turn correlation | Requires changing MCP routing | Only worthwhile for specific MCP fidelity needs. Does not observe built-in tools or general assistant text. |
| TypeScript/Python SDK, SDK Bridge | Full visible segments, tool lifecycle/results, structured run conversation, per-turn usage, request IDs | Stable agent/run/call envelope; catalog and event replay; some assistant structures lack message IDs | SDK-managed workflows | Best supported explicit-run integration; no documented passive subscription to arbitrary editor/CLI history. |
| Cloud Agents SSE | Text deltas, tool args/results, optional detailed interaction updates | Call IDs, run IDs, event replay within retention | Cloud runs, including separately configured self-hosted runs | Good future Cloud source; not local editor recovery. Large tool fields may be omitted with truncation flags. |
| Enterprise Admin usage events | Historical token counts, model, billing, optional conversation ID | Session join possible; no unique event ID in documented response | Server-side usage across surfaces | Useful usage companion; Enterprise/admin key required. No content. |
| Conversation Insights / webhooks | Aggregate classifications / terminal cloud summary | Aggregates / cloud agent status | Separate analytics/cloud surfaces | No raw conversation recovery. |
| Shared transcripts | Conversation, tools and results | Published snapshot, manual sharing | Explicit share flow | Not an automatic local source; Teams/Enterprise, sharing changes visibility. |
| VS Code/Cursor extension APIs | Own tools/runs, internal runtime providers | Private APIs are proposal-gated; important agent-host operations additionally require exact built-in extension identity | Not a supported global tap | Do not build on internal provider replacement or extension-ID impersonation. |
| Native network interception | Interaction updates, tool RPCs, conversation checkpoints/blobs | Native call/model IDs, stream/checkpoint state; no passive historical replay guarantee | Potentially transparent after routing/trust changes | Technically plausible, source-only; prefer native store recovery. |

## Specialized hooks: what actually adds information

The current official Hooks page documents `afterShellExecution`, `afterMCPExecution`, `afterFileEdit`, `beforeReadFile`, Tab-specific events, subagent events and generic tool hooks [I1]. There is no separate documented after-Grep, after-Glob, after-WebFetch, after-ReadLints or after-computer-use hook. Extra callbacks cannot universally undo generic tool summaries.

`afterFileEdit` receives `file_path` and `edits: [{old_string,new_string}]`. In installed `cursor-agent-exec/dist/main.js`, the write wrapper computes zero-context diff hunks from pre-write content and requested written text. Creation, or an unavailable pre-read, becomes an empty old string plus the written text. It invokes the hook after successful writing. The Cmd+K path in the workbench separately derives the replaced old/new range. This can be more faithful about actual edits than a generic path/count result. It is not a full resulting-file snapshot or a guaranteed one-to-one match to a native tool call. As with the retained before-read observations, use an explicitly separate file observation unless a real identity contract is established [L1, L3].

`afterMCPExecution` is described as including the full JSON result, but current implementation imposes a meaningful qualification. On success it maps each MCP content block: text is preserved; images become base64 and MIME type; other cases become `{type:"unknown"}`. It serializes `{content,isError}`, then passes the identical string first as specialized `result_json`, and then to generic `firePostToolUse`. Errors/rejections/permission denial get explicit serialized objects. A specialized hook thus does not restore content dropped by that mapper. It also observes the result before generic hooks can return `updated_mcp_tool_output`, so it need not equal the post-hook model-visible result [L3]. This is static source evidence, not a new live MCP test.

A stdio/HTTP MCP proxy could preserve the protocol response before Cursor's conversion, including original richer content kinds or structured fields when actually present. That is a specific MCP transport capability, not a general Cursor recording interface: it will not see built-in Read/Grep/Shell calls or assistant messages. It would also add one routing hop, request-ID correlation, cancellation and backpressure requirements, and config ownership work. Given the generic hook already preserves ordinary text/image content, there is no current justification to wrap every MCP server. Cursor's documented `vscode.cursor.mcp.registerServer()` registers servers; it is not an all-tool observer [I2].

The blanket statement that every web tool result is summarized would also be too broad. Installed editor code has a WebFetch path whose generic success output contains `content` as well as `content_length`, with content passed through the same clipping helper used in rendering. WebSearch's corresponding output includes `references_count` and a `content` array of title, URL and chunk. These paths depend on hook-enabled execution branches; they are not new live guarantees. The exact executor and tool must be tested before deciding another observation is required [L3].

Shell's specialized callback contains full captured output but no exit code in the documented schema. Prior controlled CLI evidence already showed that both generic and specialized hooks can misdescribe a rejected shell. Adding the specialized callback does not repair that status defect. Subagent stop supplies a summary and transcript pointer, not the child's full conversation. Tab hooks add inline read/edit observations, not Agent prompt or completion history [I1; existing probe evidence].

## SDK and Bridge: a supported rich interface for managed runs

The current API overview lists TypeScript SDK, Python SDK and SDK Bridge for all users [I3]. These are agent runtimes, not plain model-inference endpoints. Local means local tools and agent loop, with model calls still remote. Their auth contract is a user or service-account API key, not a Team Admin key or a documented way to borrow the editor's login [I4, I5].

The TypeScript interface provides [I4]:

- `Agent.list`, `Agent.get`, `Agent.listRuns`, `Agent.getRun`, and `Agent.resume` for saved agents and runs.
- `run.stream()` with stable agent/run identifiers and tool envelope `type`, `call_id`, `name`, `status`. Tool input/output schema is explicitly unstable. Large fields can be truncated with explicit flags.
- `run.conversation()` returning structured user messages, assistant steps, tool-call steps and shell turns with stdout/stderr/exit code. It also returns a distinct thinking-message variant, which a HypAware reader must discard before persistence. The documented assistant structure is just `{text}`; this does not solve native assistant message identity by itself.
- Raw `onDelta` / `onStep` callbacks for text deltas, tool-call start/completion, `modelCallId`, nested task updates and turn boundaries. Callbacks are awaited, so an expensive recorder can delay the agent; bounded local enqueue is preferable.
- Durable local agent metadata, content-addressed checkpoints, runs and append-only run events. The default uses SQLite. A documented JSONL store writes `agents.ndjson`, `runs.ndjson`, `run_events.ndjson`, and `checkpoints.ndjson`; a custom store can compose four substores. Catalogs use opaque pagination, events exclusive offsets.

The SDK Bridge embeds that SDK and exposes supported `sdk.v1` Connect services over authenticated loopback HTTP/1.1. It accepts protobuf or JSON, and has additive versioning, version/capability discovery and standalone binaries. The published service proto explicitly includes `GetRunConversation`, `ObserveRun` with an exclusive resume offset, and agent/run catalogs [I5, I6]. This is distinct from undocumented internal `agent.v1` backend transport. Bridge verbose logs intentionally omit request/response bodies, so enabling them does not produce a transcript.

The phrase "attach to an existing endpoint" refers to an already running SDK Bridge, not any ordinary Cursor editor process. `Agent.resume` refers to records in the SDK's selected checkpoint store; neither its docs nor the examined Bridge schema promise compatibility with arbitrary existing editor composer records or CLI `store.db` histories. No SDK package or bridge was installed, and no compatibility probe was run. Treat this as an excellent supported option for explicit programmatic workflows. It cannot be presented as a tested passive fix for the user's current editor/CLI use. A bridge would also be an additional binary deployment, and adding the SDK as a runtime dependency conflicts with this repository's no-new-runtime-dependencies constraint unless scope changes.

## Usage: stronger semantics and a pull alternative to OTEL

The Enterprise Admin API has `POST /teams/filtered-usage-events`. Its current response explicitly includes optional `conversationId`, model, timestamp, billing kind, chargeability, headless flag and `tokenUsage` containing input, output, cache-read and cache-write counts. The endpoint accepts bounded time windows, user filters and pagination up to 1,000 rows. Both time bounds are inclusive. Data is aggregated hourly and polling more often than hourly is discouraged. Rate limit is 60 requests/minute/team [I7].

The API overview is explicit: Admin API availability is **Enterprise teams**, with an `admin:*` key and Basic authentication. Ordinary Teams/Pro access should not be assumed [I3]. It can fill historical session usage without a public HTTPS OTLP/protobuf receiver, but does not avoid Enterprise eligibility. No documented unique usage-event ID appears in the response schema, so incremental deduplication/corrections need an explicit contract rather than an invented timestamp/model hash. `conversationId` is optional; when absent, exact session attribution is unavailable. `isHeadless` is not a reliable editor-versus-CLI label.

There is now better authoritative token-accounting evidence than the hook page:

> `totalTokens`: `inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens`. Excludes `reasoningTokens`.

The SDK says reasoning tokens are already inside output tokens. Usage events fire once per reporting turn; `run.usage` and `result.usage` are cumulative over reporting turns and remain undefined when no turn reports usage [I4, Token usage]. The Cloud usage API also defines total as the sum of those four counts, and says its `tokenUsage` matches the team usage-events endpoint [I8, Get Agent Usage]. This establishes additive cache accounting for SDK/Cloud usage and its Admin counterpart. It is strong evidence against subtracting cache-read from those input counts. The tested hook counters should still be linked to that same producer/semantic contract before changing their canonical normalization; a familiar field name alone is insufficient. The installed native `TurnEndedUpdate` has the same four optional count fields, but its protobuf declaration does not explain semantics [L1].

Conversation Insights explicitly returns aggregate classifications, not raw content or exports. Cloud webhooks only send terminal ERROR/FINISHED status plus summary, not turn/tool events [I9, I10].

## Cloud exports and native transport

Cloud run SSE is a real supported content stream: assistant deltas, tools, and optional SDK-shaped interaction updates. It has opaque event IDs, `Last-Event-ID` resumption and a retention header; expired streams can return 410. Simplified and detailed events represent overlapping observations, so choose one lane. Tool arguments/results may be omitted when too large, with matching truncation flags. Terminal result repeats the final assistant reply and should not become an extra assistant message. Thinking is a distinct event to discard [I8]. These APIs address cloud-managed runs, including separately configured self-hosted workers, not ordinary editor chats.

Shared transcripts include full conversations, code snippets, tools and results. They require Teams/Enterprise, are unavailable in No Storage mode and have a daily sharing cap. Creating a share publishes a snapshot to the selected audience; it is not an acceptable automatic local-history recovery step [I11]. No sharing was attempted.

Official network docs confirm HTTP/2 bidirectional streams with HTTP/1.1 SSE fallback. They acknowledge TLS inspection but warn it commonly causes timeouts and streaming errors, recommending inspection exclusions [I12]. BYOK still routes every request through Cursor servers for final prompt construction; it is not a direct OpenAI-compatible local interception lane [I13].

Installed editor source establishes that full information exists on native protocol surfaces [L1]:

- `agent.v1.AgentService.Run` is bidirectional; `RunSSE` and `RunPoll` alternatives are present.
- `AgentServerMessage` carries interaction updates, execution messages, conversation-checkpoint updates, key-value messages and interaction queries.
- `InteractionUpdate` distinguishes text, thinking, tool start/completion/deltas, step boundaries and turn end. Tool completion carries `call_id`, `model_call_id`, and structured tool payload. Plain text deltas have no assistant-message UUID in that declaration.
- `KvServerMessage` includes get/set blob requests. A body tap would therefore need stream/checkpoint/blob semantics as well as visible text; raw bytes are not an already normalized transcript.
- Older `aiserver.v1.ChatService` APIs coexist and have their own tool/result messages, adding version and execution-path coverage work.

A proxy could theoretically recover more complete live content, but would require a native Connect/protobuf decoder, bounded streaming without response buffering, routing/trust changes, safe header handling, explicit exclusion of thought variants, and robust handling of retries/reconnects and checkpoint/blob references. It would see only traffic occurring while active and might miss context reused from local state. A local structured-store reader avoids placing HypAware in the model request path and already has stronger controlled evidence from WP1/WP2. No network interception was attempted.

The extension host exposes private `vscode.cursor` runtime and Connect transport provider APIs. Ordinary methods are wrapped in the `cursor` proposal check; key agent-host catalog/runtime operations additionally call a guard requiring `isBuiltin` and exact `anysphere.cursor-agent-host` or `anysphere.cursor-agent-exec` identity. They are not supported third-party observation hooks. `vscode.tracing` exposes emission functions such as spans, breadcrumbs and counters, not a subscription/exporter for all Cursor agent events [L2]. The built-in `cursor-ndjson-ingest` extension is an HTTP input server for application debugging logs written to `.cursor/debug.log`, not an automatic output stream of Cursor conversations [L4].

## CPU, memory and operational assessment

Specialized hooks add a process and payload serialization per callback. Add only events with demonstrated new information. MCP wrappers add transport and request-tracking costs; avoid buffering unlimited result bodies or keeping completed request maps forever. SDK callbacks can directly stall agent progress, so bounded queues and prompt disposal matter. Bridge adds a resident runtime and deployment/update work. Admin polling can be economical with bounded pages and hourly schedules. Native network interception has the broadest hot-path cost: parsing streamed frames, assembling tools/blobs and handling reconnect state while preserving interactive latency. Native store recovery should reuse existing cursors and bounded changed-record reads, as the coordinator is testing. No measured production CPU/memory regression is claimed because this package changed no runtime code.

## Sources and reproducibility

All public sources accessed 2026-09-10. Public docs were fetched using `Accept: text/markdown`; several `.md` URLs in Cursor's index returned a markdown 404 page, so canonical suffix-free URLs below were verified. Temporary copies are `/tmp/cursor-wp3-<name>.txt`.

| ID | Primary source | Local suffix / relevant section |
| --- | --- | --- |
| I1 | [Hooks](https://cursor.com/docs/hooks) | `hooks`; specialized hooks and common payload |
| I2 | [MCP](https://cursor.com/docs/context/mcp) | `mcp`; Using the Extension API |
| I3 | [API overview](https://cursor.com/docs/api) | `api-overview`; availability, auth, rate limits |
| I4 | [TypeScript SDK](https://cursor.com/docs/sdk/typescript) | `sdk`; Token usage, Stream events, Conversation turns, Resuming agents, Local agent stores |
| I5 | [SDK Bridge](https://cursor.com/docs/sdk/bridge) | `bridge`; supported contract, lifecycle, auth, versioning |
| I6 | [Published SDK agent service proto](https://github.com/cursor/sdk-bridge/blob/main/proto/sdk/v1/sdk_agent_service.proto) | `bridge-proto`; GetRunConversation, ObserveRun, catalog RPCs |
| I7 | [Admin API](https://cursor.com/docs/account/teams/admin-api) | `admin`; Get Usage Events Data |
| I8 | [Cloud Agents endpoints](https://cursor.com/docs/cloud-agent/api/endpoints) | `cloud-endpoints`; Stream a Run, Get Agent Usage |
| I9 | [Analytics API](https://cursor.com/docs/account/teams/analytics-api) | `analytics`; Conversation Insights |
| I10 | [Cloud webhooks](https://cursor.com/docs/cloud-agent/api/webhooks) | `webhooks`; statusChange only |
| I11 | [Shared transcripts](https://cursor.com/help/ai-features/shared-transcripts) | `share`; content, plans and restrictions |
| I12 | [Network configuration](https://cursor.com/docs/enterprise/network-configuration) | `network`; streams, TLS inspection |
| I13 | [Bring your own API key](https://cursor.com/docs/settings/api-keys) | `api`; all requests routed through Cursor servers |

Installed code is static implementation evidence, not a stable API or proof every branch runs in each session. Search anchors below refer to UTF-8 decoded character offsets for this exact installation:

- L1: `/Applications/Cursor.app/Contents/Resources/app/out/vs/workbench/workbench.desktop.main.js`, SHA-256 `b58c85c5304741e433b21dbfb2714d39f8c7ced47ceb1112a001ee8c3edb8846`. `agent.v1.AgentService` near 18,374,715; `agent.v1.InteractionUpdate` 14,003,078; `agent.v1.TurnEndedUpdate` 14,000,283; `agent.v1.KvServerMessage` 15,429,327. Cmd+K edit hook anchor: `executeAfterFileEditHook`.
- L2: `/Applications/Cursor.app/Contents/Resources/app/out/vs/workbench/api/node/extensionHostProcess.js`, SHA-256 `29a0a49d237cf02b846f3004ce41fc350597e00d8d11b665248d4f1f4c3c1fb7`. Built-in guard `function Ro(` 3,884,996; cursor API block `Ns={rgPath:` 3,891,044; tracing block `const kh=` 3,903,891.
- L3: `/Applications/Cursor.app/Contents/Resources/app/extensions/cursor-agent-exec/dist/main.js`, SHA-256 `1a59636aabc69033eed639958e2877eee84dcb239942a4f62e267930466606df`. MCP `result_json:s` 5,671,466; edit `file_path:r.path,edits:u` 5,687,352; WebFetch generic config 2,744,071; WebSearch generic config 2,754,269.
- L4: `/Applications/Cursor.app/Contents/Resources/app/extensions/cursor-ndjson-ingest/package.json`, description and contributed commands. Read metadata only; no debug logs opened.
