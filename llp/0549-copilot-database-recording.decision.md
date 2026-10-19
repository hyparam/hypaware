# LLP 0549: VS Code Copilot database recording

**Type:** Decision
**Status:** Draft
**Systems:** Plugins, Sources, Backfill, Privacy, Config
**Author:** Phil / Codex
**Date:** 2026-10-19
**Related:** LLP 0012, LLP 0035, LLP 0306, LLP 0359, LLP 0403, LLP 0466
**Extends:** LLP 0045 (disk-driven undo for literal JSONC settings in external files)

## Authority and identity {#identity}

One endpoint-free bundled `copilot` adapter imports completed spans from both
VS Code 1.142 harnesses. The pinned source study is in
`research/2026-10-19-vscode-copilot-recording/REPORT.md`. The stores share schema
version 1. The Local store lives in the actual profile's Copilot global storage;
the Agent Host store lives in user-data/agent-host/otel. Native data is read-only,
including WAL. No proxy, collector or runtime dependency is introduced.

Span identity is `(session, trace, span)`, with role/occurrence suffixes. Root
invoke_agent inputs own submitted user turns; chat outputs own assistant/tool
calls and one per-response usage carrier; execute_tool owns tool results. Root
aggregate usage and duplicate assistant output are omitted. Repeated full model
input history is never projected or fetched. Repeated identical submissions have
different span IDs. OTEL parent span IDs remain correlation metadata, not invented
message chronology. No UI content lane or raw OTEL payload is persisted.

Input tokens are gross-minus-cache-read-minus-cache-create, matching Local's
released `prompt_tokens` source. Reasoning is a subset of output. Native SDK
field fidelity still needs disposable installed-client verification. A terminal
span without output can own an explicit empty accounting/error observation.

## Ownership {#ownership}

Only local single-root workspaces are supported. Local session IDs join their
workspaceStorage chat metadata and workspace.json's folder URI. The bounded
mutation-log reader retains only session identity and workingDirectory. It does
not import draft text or reconstruct conversation content. Workspace-file roots,
remote URIs, conflicting bindings and observed cwd changes are incomplete.

Agent Host's synthetic session span maps the native conversation ID to its host
session URI, then to agentSessionData/session.db. Require exactly one local
copilot.workingDirectories root, and compatible copilot.workingDirectory. Peer
chat URIs and sessions with turn_workspace_transition records are withheld:
there is no proven trace/span-to-transition mapping. Require the SDK
session.start.data.context.cwd to match current provider metadata as well. Only
the bounded initial event line is parsed, never the full native history. A
current cwd alone cannot relabel historical spans. Detected moves are withheld;
moves away and back with no surviving evidence remain unqualified, so arbitrary
cwd-transition history is not a supported workflow. This is an explicit coverage gap, not claimed cwd
transition support. SDK workspace.yaml fallback remains deferred until its exact
released shape and change semantics are fixture-qualified.

## Attachment {#attachment}

Attach enables both DB exporters and Agent Host captureContent in application
settings, and discloses that Local's debug DB may contain full content even with
external captureContent off. It preserves foreign destinations and refuses an
observable protobuf/gRPC Agent Host fan-out conflict before any writes. It also
refuses disabling environment overrides. Editor-process-only environment and
enterprise effective policy remain unverified, so attach is not proof of capture.

Default Stable and Insiders roots follow platform/XDG and VSCODE_PORTABLE paths.
`user_data_dirs` (1 to 8 absolute paths) explicitly selects relocated data roots.
Profile databases are discovered below each root. Application settings are
written in User/settings.json; application scope is shared across profiles.

The home-relative `.copilot/hypaware.json` receipt follows COPILOT_HOME through
core's existing path convention. Its standard JSON `_hypaware.managed` undo
record gains `settings_files`: absolute path, literal-key managed values, and
previous values. Core restores these through a bounded JSONC token editor,
without loading the adapter and without changing comments/unrelated settings.
A user-edited value is retained with a warning. Attach journals undo before
writing settings; only a completed `database` receipt admits recording. Detach
still uses LLP 0466's recording switch; source history remains.

## Privacy {#privacy}

Configured recording plus a completed attach receipt are required independently
of upstream debug/export flags. Persistent session exclusions fail closed. The
shared folder resolver runs with zero TTL before reading content and after
asynchronous work. Known file-read tools require lexical and canonical ownership,
containment and no stricter child policy. Refused tool messages cannot reappear
inside raw attributes or repeated input context. Unknown tool semantics remain
session-scoped, as terminal commands are in existing adapters.

A private WeakMap guard accompanies each yielded item. A thin Copilot materializer
delegates expansion/dedupe to the dataset owner's implementation, then repeats
recording, receipt, session, directory and ownership checks immediately before
returning rows to core's write path. Policy changes fail the item, preventing a
successful checkpoint. Local-only remains the existing cwd-based export seam.

## Session controls {#session-controls}

When Copilot is the only registered client and no gateway capability is active,
its session commands require an explicit native ID and use the existing durable
SessionIgnoreSet directly. The receipt confirms persisted set membership only.
Other live-recorder installations retain the shared HTTP control flow. Every
recovery run refreshes exclusions; directory identity/mtime/ctime changes trigger
another refresh at write boundaries, avoiding a 10,000-marker reload per span.
In-place corruption of an unrelated marker is detected by the next run's full
refresh. No current-session guess from cwd or recency is introduced.

## Recovery and resources {#recovery}

The existing serial sweep queue performs capture every minute by default, with
backfill.sweep_cron and window_days honored. No extra poller or socket is needed.
Declining on_join history floors scheduled capture at adapter activation, as in
Codex. Manual backfill can widen the window. Source lifecycle status reports
last scan, stores, selected/read/unchanged/dropped/incomplete counts.

Every pass scans currently retained metadata in rowid pages of 128, capped at
16,384 span candidates/run and 128 sessions/store. There is no start-time cursor, so late old parents remain
eligible. A bounded process-local consumed signature map uses store generation,
span identity/row metadata and cwd; every twelfth pass reconciles payloads too.
Replacements, retention and restart replay through stored/spooled part dedupe.
Fingerprints advance only after successful consumption. Manual runs bypass them.

Bounds: eight data roots, 64 profiles/root, 1024 workspace directories, 1024 cached
UI metadata entries and 1024 SDK initial-context entries, 4 MiB per metadata/content read, 32 MiB selected content/run,
8192 normalized parts/run, and 16,384 consumed signatures. Ownership discovery is once per session/run;
write guards re-stat just the authoritative local metadata witnesses. Folder
resolvers are scoped to a guard/filter call, so path memos cannot grow with uptime. Cap hits report incomplete. Reads are serial,
SQLite busy waits are capped at 100 ms, and projection yields every 32 decoded
spans. No per-event subprocess, lifetime content cache, raw spool or whole-cache
dedupe preload is added. Metadata scanning remains O(retained spans); first/cold
or reconciliation passes decode bounded retained content. A single oversized store
can remain incomplete and is not advertised as fully captured.

System instructions and tool catalogs are retained on one dedicated system
context row per chat span, rather than copied into every output row. Native
JSON that fails decoding is preserved there as text with content_incomplete.
Visible reasoning is read from output parts or the Local-specific reasoning
attribute, without emitting a duplicate when both are present. No inference is
made about hidden reasoning. Output projection is capped at 2048 parts/span.

## Coverage and validation {#coverage}

Synthetic schema-v1 fixtures for Local and Agent Host must exercise actual SQLite
WAL and source-to-query/export, identities, repeated prompts, one-carrier usage,
replay, late parents, replacement, malformed/capped inputs, privacy and detach.
Installed editor/extension pairing and SDK payload fidelity remain unverified.
No paid calls or private installed history are needed for the hermetic gate.

Child/subagent sessions require their own admitted metadata binding. Parent span
and parent chat IDs are preserved where emitted, but a complete subagent tree
is not claimed when a binding or retained parent is missing.

Native startup retention is seven days/latest 100 conversations. Histories evicted
before capture, standalone logs/metrics/resources/links, exact binary attachments,
inline completions, remote/multi-root and changed-directory sessions are not
claimed. A later content lane requires proven identity convergence first.
