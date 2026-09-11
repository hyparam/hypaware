# Source ledger

Access date for this follow-up: September 10, 2026. Public sources are first-party Cursor documentation or published Cursor code. Publication dates are unavailable unless a version/release date is explicitly listed. Installed code and disposable-session observations are version-specific evidence, not supported API promises. No secondary search snippet is used as primary support.

## Controlled local evidence

| Source | Version / access scope | Claims supported | Strength and limit |
| --- | --- | --- | --- |
| [Editor projection and graph probe](spikes/editor-storage-probe.py), [result](spikes/editor-storage-evidence.json) | Editor 3.19.19; exact disposable conversation a04677b4-01ac-478d-a4ef-37ab5ddd0d9a only | 8 visible segments vs 5 hooks; 12 results vs 10 hooks; actual Read/Grep/Glob results; dynamic-tool discovery; native identity and turn timing | Direct repeatable observation, workspace check and hash-verified graph; one editor conversation, no compaction/restart/upgrade proof |
| [CLI graph probe](spikes/cli-store-probe.py), [result](spikes/cli-store-result.json) | CLI 2026.09.08-6caf4ff; 3 completed disposable sessions | Native user/request/tool IDs, timestamps, complete small Read, typed Shell rejection | Direct read-only recovery; small closed stores without WAL |
| [CLI JSON projection](spikes/cli-prompt-probe.py), [result](spikes/cli-prompt-result.json) | Same 3 CLI sessions | 7 visible assistant messages and 7 results, matching Grep line, Glob names, rejected Shell | Typed allowlist before output; no full retention guarantee |
| Existing controlled hook evidence | `/tmp/hypaware-cursor-live-probe/evidence/hooks.jsonl`; selected comparison in editor artifact | Baseline event counts and identity matches | Previously recorded synthetic workspace only; not copied wholesale |
| [Previous capture evidence](../../docs/cursor-capture-evidence.md) | Earlier hook/stream probes in this task | Hook summaries, headless omissions, extra file observations, prior passing implementation checks | Describes current draft adapter, not native recovery implementation |

The editor source database was opened in read-only query mode with a short snapshot. The CLI probes used immutable mode only after confirming the completed samples had no WAL siblings; this is explicitly unsuitable for an actively written production database. Probes exclude thought content and unrelated context from their artifacts. They are research code, not production readers.

## Installed and published implementation

| Source | Version / identity | Exact location / anchor | Claims supported |
| --- | --- | --- | --- |
| Cursor workbench | 3.19.19; SHA-256 b58c85c5304741e433b21dbfb2714d39f8c7ced47ceb1112a001ee8c3edb8846 | `/Applications/Cursor.app/Contents/Resources/app/out/vs/workbench/workbench.desktop.main.js`; `composerBlobStore.js`, `serializeToolformerBubbleData.js`, `ConversationStateStructure`, `ConversationStep`, `Dhd`, `mwf` | Graph traversal, pruned UI records, flattened transcript loss, private native protocol |
| Cursor extension host | SHA-256 29a0a49d237cf02b846f3004ce41fc350597e00d8d11b665248d4f1f4c3c1fb7 | `.../out/vs/workbench/api/node/extensionHostProcess.js`; guard `function Ro`, cursor API `Ns={rgPath:`, tracing `const kh=` | Private proposal/built-in extension gating; telemetry emission is not global observation |
| Cursor agent executor | SHA-256 1a59636aabc69033eed639958e2877eee84dcb239942a4f62e267930466606df | `.../extensions/cursor-agent-exec/dist/main.js`; `result_json:s`, `file_path:r.path,edits:u` | Specialized/generic MCP same payload, edit-hunk hook, richer web-tool paths |
| Isolated CLI distribution | 2026.09.08-6caf4ff | `/tmp/hypaware-cursor-cli-probe`; `1652.index.js` state paths, `7261.index.js` SQLite store, `7578.index.js` ACP replay, `index.js` checkpoint/persistence | Ordinary vs ACP storage, lossy ACP replay, checkpoint hashing, persistent terminal mechanics |
| [Cursor SDK npm distribution](https://registry.npmjs.org/@cursor/sdk/-/sdk-1.0.31.tgz) | @cursor/sdk 1.0.31; public tarball statically inspected, no install/execution | `dist/esm/index.js`, `856.js`, `730.js`; `sdk-agent-store`, `getAgentMessages` | Separate SDK catalog, positional list-message IDs, native checkpoint storage |
| HypAware current source | Local draft | [Hermes SQLite reader](../../hypaware-core/plugins-workspace/hermes/src/state_db.js), [OTLP listener](../../src/core/otlp/server.js) | Existing built-in SQLite precedent, JSON-only OTLP listener |

Detailed symbol offsets and implementation observations are in [WP1](work/WP1-editor-storage.md), [WP2](work/WP2-cli.md) and [WP3](work/WP3-interfaces.md). Public distribution URL for the isolated CLI: `https://downloads.cursor.com/lab/2026.09.08-6caf4ff/darwin/arm64/agent-cli-package.tar.gz`.

## Current official interfaces

| Source / publisher | Date or version | Relevant claim / section | Evidence qualification |
| --- | --- | --- | --- |
| Cursor, [Hooks](https://cursor.com/docs/hooks) | Current page, accessed Sep 10 | Specialized file/MCP/shell/subagent events; no universal result-recovery hook | Actual payload fidelity checked against installed implementation and prior probes |
| Cursor, [MCP](https://cursor.com/docs/context/mcp) | Current page | Extension API registers servers | Registration does not imply global observation |
| Cursor, [API overview](https://cursor.com/docs/api) | Current page | Enterprise Admin availability; SDK/Bridge all users | Availability/auth statement, not tested account eligibility |
| Cursor, [TypeScript SDK](https://cursor.com/docs/sdk/typescript) | Current page; package inspected at 1.0.31 | Conversations, stream events, stores, usage, resume/capabilities | Supported SDK-managed workflows; tool payloads explicitly unstable |
| Cursor, [SDK Bridge](https://cursor.com/docs/sdk/bridge) | Current page | Loopback Connect protocol, capabilities/versioning, auth | No bridge launched |
| Cursor, [Bridge streaming semantics](https://github.com/cursor/sdk-bridge/blob/main/docs/streaming.md) | Main branch as accessed Sep 10 | ObserveRun exclusive durable offsets; never substitute Send offsets | Detailed docs narrower than proto comment; use conservative documented rule |
| Cursor, [SDK agent service proto](https://github.com/cursor/sdk-bridge/blob/main/proto/sdk/v1/sdk_agent_service.proto) | Main branch as accessed Sep 10 | GetRunConversation, ObserveRun, catalog operations | Public supported sdk.v1 protocol, distinct from private agent.v1 |
| Cursor, [Admin API](https://cursor.com/docs/account/teams/admin-api) | Current page | POST /teams/filtered-usage-events, optional conversationId, tokenUsage, hourly recommendation, inclusive time bounds, max 1,000 rows per page | No authenticated API call; unique usage event ID not documented |
| Cursor, [Cloud Agent endpoints](https://cursor.com/docs/cloud-agent/api/endpoints) | Current page | Rich run SSE, replay retention and truncation, additive usage accounting | Cloud-managed scope, no passive local editor/CLI claim |
| Cursor, [Analytics API](https://cursor.com/docs/account/teams/analytics-api) | Current page | Conversation Insights aggregate classifications | Does not expose raw conversations |
| Cursor, [Cloud webhooks](https://cursor.com/docs/cloud-agent/api/webhooks) | Current page | Terminal status change plus summary | Does not expose every tool or turn |
| Cursor, [Shared transcripts](https://cursor.com/help/ai-features/shared-transcripts) | Current page | Shared full history/results, Teams/Enterprise, privacy restrictions | Publication changes audience; never invoked as recovery |
| Cursor, [Network configuration](https://cursor.com/docs/enterprise/network-configuration) | Current page | HTTP/2 bidirectional, SSE fallback, TLS inspection problems | Confirms transport constraints, not a supported capture proxy |
| Cursor, [BYOK](https://cursor.com/docs/settings/api-keys) | Current page | Requests still routed through Cursor servers | Does not establish direct OpenAI-compatible interception |
| Cursor, [CLI output format](https://cursor.com/docs/cli/reference/output-format) | Current page | Print-mode stream events | Actual previous probes emitted thought events despite doc statement; explicit filtering required |
| Cursor, [CLI ACP](https://cursor.com/docs/cli/acp) | Current page | New/load sessions and updates over stdio | Actual initialize succeeded; static replay/store behavior limits fidelity |
| Cursor, [CLI changelog](https://cursor.com/docs/cli/changelog) | Latest visible entry Aug 26 | agent persist terminal lifecycle and saved sessions | Persistence is not an event export interface |
| Cursor, [OpenTelemetry Export](https://cursor.com/docs/enterprise/opentelemetry-export) | Current page | Enterprise, server-side public HTTPS binary OTLP/HTTP | No local exporter or content tap documented |
| Cursor, [OTEL Wire Reference](https://cursor.com/docs/enterprise/opentelemetry-export/wire) | cursor.telemetry / 0.1.0 | Usage logs, optional conversation IDs, aggregate ordinary-tool metrics, retry semantics | Grok Bot recording must not be generalized to ordinary editor/CLI |

Exact SDK accounting statement: `totalTokens` is `inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens`. The text clarifies reasoning is already within output, so it is not added again. This establishes SDK accounting; current hook equivalence remains a separate validation requirement.

## Conflicts and uncertainty retained

- Some canonical Cursor `.md` links returned markdown 404 pages. The suffix-free pages listed here were fetched successfully; earlier successful cached documentation was not silently treated as current when a fresh equivalent was available.
- SDK/Bridge protocol docs support rich replay, while its storage implementation establishes a separate catalog. Neither supports a claim of passive attachment to arbitrary editor/CLI sessions.
- Native display persistence strips results that the separate graph retains. Claims of missing content based on display bubbles alone would be false for these sessions.
- Hook callback completion differs from actual rejected Shell state. Native typed result evidence wins for those test cases; no universal success convention is inferred.
- No private-format promise, exhaustive old history, live WAL acceptance, compaction, remote host capture, subagent lineage or normalized hook billing is claimed as proven.
