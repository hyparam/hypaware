# LLP 0399: Cursor native session recovery and file observations

**Type:** Decision
**Status:** Draft
**Systems:** Sources, Plugins, Config, Privacy, Onboarding, CLI, Backfill
**Author:** Phil / Codex
**Date:** 2026-09-10
**Related:** LLP 0306, LLP 0045, LLP 0050, LLP 0035, LLP 0256, LLP 0359

## Evidence and scope {#capture}

One bundled `@hypaware/cursor` adapter covers editor Agent Chat and native CLI
sessions without a gateway endpoint or a new conversation table. It reuses
`ensureAiGatewayStorageContracts`, `createProjectedExchangeWriter`, and the
existing backfill materializer. No runtime dependency is added.

Research inspected editor 3.19.19 and CLI 2026.09.08-6caf4ff. Native hooks omit
assistant segments and summarize even tiny Read/Grep results; rejected CLI
Shell calls can emit ordinary successful-looking callbacks. Cursor's saved
conversation graph contains substantially richer results and actual outcomes.
The candidate reader recovered the disposable editor's five user turns, eight
assistant segments and twelve tools, plus two disposable CLI sessions. See
`research/2026-09-10-cursor-capture-gaps/EVIDENCE.md` and the linked research for observed counts.
This is a version-specific integration, not a supported Cursor export API.

## Identity and finality {#identity}

Native records own conversation content. Hooks schedule recovery; additional
`beforeReadFile` and terminal usage observations write separate hook rows. No prompt,
response or generic tool hook fallback can race the native lane into duplicate
rows. This deliberately trades immediate hook text for recoverable native
identity, including Shell calls whose hook helper IDs differ from native IDs.

A human prompt is identified by `(session, native user-message ID)`. Assistant
segments use `(session, user-message ID, request ID, typed step ordinal)`;
tool calls and results use separate role tags with
`(session, user-message ID, native tool-call ID)`. The shipped result ID stays
unchanged; replay can fill missing call rows without duplicating old results.
Encoding is a JSON
tuple. Identical text in distinct steps remains distinct; repeated saved
snapshots converge through stored/waiting-part identity. Native request IDs are
retained, but do not alone identify assistant messages. No parent chain is
invented from callback arrival or typed completion order.

Editor reads require a completed checkpoint. Pending tool calls or missing
results refuse the snapshot. CLI final assistant steps can lack completion
timestamps even after exit: such text must also be present in saved model
context. Streaming typed text without that corroboration is refused. This is a
conservative checkpoint check, not proof of all upstream streaming, rewind,
or regeneration behavior; those remain real-client acceptance cases. A later
request gets distinct assistant identities. Rewrites within the same request
and ordinal are not treated as new messages.

## Native format {#native-format}

Open SQLite read-only, with a short busy timeout and a read transaction.
Never use immutable mode: a live WAL contains committed data the main file
may not yet contain. Do not checkpoint, repair or migrate Cursor's stores.

Editor metadata comes from `composerHeaders` and `composerData:<id>` in
`User/globalStorage/state.vscdb`. Require composer format 18. Read its base64
conversation state and exact `agentKv:blob:<sha256>` references. CLI uses
`<config root>/chats/<md5 launch cwd>/<session>/store.db`, schema version 1,
with `meta.json` providing workspace ownership. Read only the needed identity
and root pointer from database metadata; never project keys or other metadata.
CLI configuration honors `CURSOR_CONFIG_DIR`, then `XDG_CONFIG_HOME/cursor`,
then `~/.cursor`, separately from hook configuration.

A narrow wire reader follows state field 8 turns, typed user messages and steps,
and field 1 JSON message references plus reachable summary archives. Actual
user text comes from the typed message, avoiding injected model context.
Typed thinking steps are skipped without decoding their contents. Only text,
tool arguments and results are projected from the allowlisted source shapes;
system context, reasoning blocks and metadata never become raw frames.
Content-addressed references are hash-checked. Repeated archive references are
visited once. Missing blobs, oversized data and unknown required shapes are
observable failures, not empty successful conversations. Local subagent graphs
are traversed as described below. Standalone shell turns, external user-text blobs and older formats are outside
this implementation; orphan blobs are never scanned to invent history.

## Recovery and usage {#recovery}

The listener coalesces hook triggers by session/workspace, reads the exact
matching store, verifies workspace ownership and applies admission before
reading conversation bodies. Three bounded attempts cover checkpoint delay;
later callbacks and the scheduled provider cover missed attempts and downtime.
Only session/workspace metadata and bounded generation/version strings enter
the pending queue, never hook payloads. A live hook's version is attached only
to the exact matching native generation, never to older turns in the same
snapshot. Offline recovery leaves version unknown; the currently installed
client is not evidence of the client that produced history.

`backfill cursor` and scheduled recovery use the same reader and identities.
The existing `backfill.on_join`, `window_days`, and `sweep_cron` controls apply.
The default cron is every five minutes; `on_join: false` disables automatic
sweeps. Discovery is metadata-only and isolates malformed stores. Existing
retention/window semantics filter dated messages, while unknown timestamps
remain unknown and use the storage owner's normal receipt-time fallback.
The adapter does not infer billed usage from context occupancy or hook counts.
The inspected native `ConversationTokenDetails` carries used/max context tokens,
not response billing. Live usage is captured separately as described below; native recovery never
fabricates counters when that terminal observation was missed.
Provider remains unknown; editor/CLI entrypoint comes from the native store.
A bounded saved routed-model display label is attributed to assistant rows of
that turn. It is not inferred from the current selected model or encrypted
model metadata, and absence remains unknown.

Following LLP 0359, a bounded process-local map skips unchanged roots during
scheduled runs. The reader checks metadata/root only before that shortcut;
no graph or storage dedupe is performed for unchanged roots. Fingerprints
advance only after successful, non-dry consumption without admission drops.
Manual runs bypass them, and restarts begin cold. Live recovery has a separate
64-entry root cache with the same no-drop rule. A shared active-session set
prevents live writes overlapping backfill consumption of that session. A busy
live trigger retries; a busy backfill session waits until another pass.

## Local subagent graphs {#subagents}

Cursor 3.19.19's ConversationStateStructure contains inline SubagentPersistedState
map entries in field 16 and content-addressed references to that type in field
31. Follow only explicitly local states (environment=1) with a conversation
state; cloud/first-class cloud or machine references and unspecified environments are not
proof of local workspace ownership. Never follow transcript path strings.
When both forms name a child, require identical state bytes and project it
once. Conflicting copies or duplicate keys within either map are refused.

Reuse the same message projection for each child, excluding thinking/system
context as for the root. Keep session_id and cwd owned by the root so existing
session opt-outs and file/workspace admission apply to every child. Derive a
stable conversation_id from the root session and native ancestor IDs, scope
message identities to it, and set the existing agent_id, is_sidechain and
parent_thread_id fields. Root identities are unchanged. Where the native run
map unambiguously connects a child and parent tool call, retain that call as
cursor.spawned_by_tool_use_id, the same provenance concept used by Claude.
Multiple parent calls for a resumed child leave that link unknown.

One worker and one shared 4,096-read/32-MiB budget cover the whole tree, with
at most 64 child states and depth 16. Limits and missing referenced blobs
refuse the snapshot observably; neither receives a fresh budget per child.
Pending children retain the existing incomplete-checkpoint refusal behavior.
Traversal follows saved references only, with no blob scan or persistent map.
Synthetic SQLite, replay, privacy and nesting fixtures verify this contract;
real-client nested/background/resume behavior remains a compatibility limit.

## Live token usage {#live-usage}

Cursor 3.19.19 copies agent.v1 TurnEndedUpdate counters into turnTokenUsage,
clears them at generation start, and emits them on stop and afterAgentResponse.
The SDK documents additive input, output, cache-read and cache-write counters
and per-turn usage events (https://cursor.com/docs/sdk/typescript#token-usage).
Only stop is an accounting source here. Require all four counters to be
nonnegative safe integers and their sum to be safe; omission means unknown,
not zero. These are runtime token counts, not a billed-cost claim.

A system hook observation with an empty text block carries attributes.usage,
keyed by (session, 'usage', generation). It contains no hook response text or
raw payload. It uses the existing row schema and shared stored/spooled dedupe.
Duplicate delivery, repeated stop callbacks and daemon restart converge to one
row. First valid accounting wins; afterAgentResponse remains a recovery trigger.
This is a Cursor-specific exception to LLP 0035's assistant-last-row carrier:
late counters cannot enrich an already deduplicated native assistant row.
Native backfill never emits usage, so the two paths cannot double count it.
Selected hook model settings are not attributed as the billed model.

The existing hook admission, serialized writes, failure retry and writer
rotation apply. No pending usage map, transcript dependency or raw spool is
added. Offline history and clients that omit counters remain unsupported.

## File contents and tool outcomes {#file-content}

Full Read/Grep/Glob/Shell results come from saved tool messages, joined by
native tool ID to typed outcomes. Each typed tool step also emits an assistant
tool-call row with its native arguments when available; result rows retain the
arguments for compatibility. Calls precede results and share their native ID.
Verified union alternatives establish
success or error; unrecognized alternatives explicitly retain unknown status.
For Shell, independent sandbox/background/terminal/pid metadata (fields
101-104) is not part of the outcome union. Failure, timeout, rejection,
spawn error and permission denial are errors. A success payload's signed
exit code and signal decide whether a completed process failed; background
success remains unknown. Text that merely resembles an exit code never
establishes an outcome. Verified Delete, Edit, Ls, ReadLints, MCP, WebSearch,
Task and Fetch unions also classify their explicit failures. Read includes
permission-denied and invalid-file outcomes. MCP success inspects its nested
is_error flag; approval alone remains unknown. Unknown alternatives never
inherit the numbering conventions of a different tool.
The shared projector preserves explicit `is_error: null` without changing its
existing missing-field convention. A hook's claimed Shell exit code is never
substituted for the native result.

Keep `beforeReadFile` as a separate `system` observation with
`provider_type: hook`, `hook_event: beforeReadFile`, and delivery identity.
It is a permission-stage observation, not a completed tool result. Transport
retries converge; separate delivered observations remain separate. No thought
hooks are installed, and no complete raw hook frames are persisted.

Before saving file observations or native Read results, resolve workspace and
file paths. Drop unresolved successful reads, out-of-workspace targets,
symlink escapes, and lexical/canonical parents with stricter policy than the
workspace. The one-cwd export contract cannot express a local-only file under
a full workspace. Explicit missing-file errors can pass lexical scope/policy
checks because they contain no successful file contents. Recheck session ignore
after asynchronous path resolution and directory policy before writing.
A refused Read also drops its paired call, so adding call rows cannot restore
arguments excluded by the file policy. Other tool results use the existing workspace policy contract, not an invented
interpretation of arbitrary command text or result paths.

## Attachment {#attachment}

Both inspected native loaders use `$HOME/.cursor/hooks.json`. CLI configuration
honors `CURSOR_CONFIG_DIR` and `XDG_CONFIG_HOME` for `cli-config.json`, but its
native hook loader does not. Neither hook loader uses `CURSOR_HOME`. Core path
resolution follows the actual hook loader for attach, probe, and disk detach.

Attach adds direct command entries to existing event arrays, with explicit
`failClosed: false` and short timeouts. The shared JSON marker's
`managed.hook_entries` lists exact event/command ownership, reusing the disk undo
contract. The existing remover understands direct command entries as well as
Claude's nested groups. Unknown config versions, malformed arrays, foreign
markers, and unowned command collisions are refusals. Writes are atomic with an
mtime conflict check. Detach after adapter unload removes only matching owned
commands and preserves unrelated configuration.

The handler references the packaged standalone script and Node executable with
shell-quoted absolute paths. The endpoint argument is only local host and port:
CLI comment stripping corrupts a literal `http://` inside a JSON string. The
standalone sender restores the scheme. No full kernel boot or marketplace plugin is needed.
The script emits no permission decisions, context injection, or follow-up prompt.

## Privacy and coexistence {#coexistence}

The receiver applies session ignore and directory policy before projection or
persistence, then rechecks immediately before a queued write. No raw spool exists.
Missing/ambiguous workspace ownership is an observable drop; multi-root input is
refused because the existing row/export contract has only one cwd. Local-only
rows retain their cwd for the existing export withholding seam.

Cursor's native hook environment supplies `CURSOR_VERSION` even for inherited
Claude hooks. The binary skips these exact inherited mechanism commands before
configuration or dispatch can reject an inactive Claude plugin. This applies
even with broken configuration; help and other commands retain normal dispatch.
Claude context/classification handlers also skip those invocations so
they cannot misattribute context, sweep a Claude spool, or inject classification
instructions. This does not establish or assert duplicate conversation capture.
Cursor session commands require an explicit conversation ID; no current-session
resolver is invented. Tab completion and cloud continuation are excluded.

## Resource bounds {#resources}

The hook handler remains a standard-library Node process with 1 MiB input,
two attempts and a 2.5-second deadline. The receiver admits four bodies and
serializes its own writes on a queue the recovery lane does not share: a hook
answered from behind a whole recovery pass is a callback the handler has
already abandoned at 800 ms. The two lanes write disjoint identities through
separate writers, and the scheduled sweep already appends beside the listener,
so storage dedupe orders them, not a shared chain. File-observation writers and
directory-policy memos rotate every 1,024 callbacks. Native identity strings are
bounded at 256 characters.

Recovery queues at most 64 session/workspace entries, processes at most 16 per
pass, has one timer, and stops on source shutdown. Each graph is limited to
4,096 blob reads, 1 MiB per record, 32 MiB cumulative bytes and 16,384 wire
fields per record. Discovery inspects at most 1,000 editor headers and 1,000
CLI directory entries per pass; hitting a cap reports incomplete coverage.
Older sessions beyond these bounds are not promised recovery. Sweep root
fingerprints retain at most 1,000 entries; live fingerprints retain 64.
No durable offset, polling loop, persistent raw spool or lifetime content cache
is added. SQLite connections close before asynchronous writes.

Native parsing is synchronous, and a per-graph limit bounds its CPU rather than
the daemon's latency: a graph at the ceiling measured 109-144 ms of straight-line
work, and a pass runs sixteen of them, so decoding on the event loop stalled the
hook receiver, the OTEL listener and the gateway together. The decode therefore
runs on a worker thread, in the shape LLP 0264 #lifecycle already uses for
sidecar builds. One worker serves one backfill run, or a run of recovery passes
that never leaves the queue empty, and is closed with it, so an idle daemon
holds no decode thread and no graph-sized heap. It is not one worker per pass:
hooks arrive throughout an agent run, so the queue refills every debounce and
most passes only re-answer `unchanged` from the fingerprint. Spawning an isolate
for each measured 29.8 ms of CPU against 0.20 ms inline, which at the one-second
debounce is about three points of a core burned for as long as the run lasts.
Holding the worker across those passes costs 13.5 MiB while the queue is busy
and does not grow with the number of passes.
Nothing about the reader changes; the SQLite handle and its read transaction move
with it, so Cursor's store is never held open across a pause. Yielding between
blobs would have been the alternative and was rejected for that reason.

The projected snapshot crosses the thread boundary by structured clone. That
costs a transient second copy bounded by the same 32 MiB per graph: a graph whose
bytes are all projected measured a peak RSS of 91 MiB against 46 MiB inline,
while the main thread blocked 2-7 ms rather than the whole decode. Worker startup
is ~27 ms per pass, amortized over up to sixteen sessions.

CPU and memory review found bounded queues, graph allocation and identity maps.
Shared dedupe still costs work proportional to relevant committed data and
waiting spool size. Process startup, real-store recovery-pass latency, catalog-cap
coverage and sustained heap behavior remain unmeasured against real
stores. These bounds are not a claim of measured
production throughput.
