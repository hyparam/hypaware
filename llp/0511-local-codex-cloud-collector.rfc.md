# LLP 0511: Local Codex cloud history collection

**Type:** RFC
**Status:** Draft
**Systems:** Plugins, Sources, Privacy, Backfill
**Date:** 2026-10-16
**Related:** LLP 0012, LLP 0141, LLP 0359, LLP 0403, LLP 0466

## Decision {#decision}

Extend the existing Codex adapter with an experimental, explicitly connected
cloud-history provider. `hyp codex-cloud connect <thread-id>...` replaces a
machine-local selection of at most 20 chats, bound to a fingerprint of the
current ChatGPT subject and account. `disconnect` removes that selection;
`status` reads it. `connect --all` instead grants account-wide discovery;
`--from-now` optionally fixes an earliest import timestamp. Connecting does not import data. Existing Codex setup and
central configuration never opt a machine into cloud reads.
The three command names extend the finite product-telemetry command vocabulary
(LLP 0393); arguments, chat IDs and account fingerprints are not telemetry fields.

`hyp backfill codex-cloud` uses the ordinary gateway materializer and the daemon
schedules it every five minutes. No new dataset, runtime dependency or config
key. Selected chats are re-read; the existing durable part-id dedupe suppresses
unchanged rows. No durable cursor can advance past a failed write. There is no live usage subscription.

## Discovery {#discovery}

The local grant selects any nonempty subset of `codex_cloud`, `codex_work_web`
and `codex_work_mobile`. Omitted origins mean `codex_cloud` only, including old
grants. CLI `--origins` is explicit consent to those categories; neither setup
nor an upgrade widens the grant. Work web/mobile can include personal assistant
conversations. Delegated `codex_work_cca` and unknown origins are unsupported.
The shared `source.custom = codex-cloud-agent` is insufficient on its own.
Discovery paginates unfiltered metadata and selects origins locally. Live
acceptance found that the hosted originator filter omitted eligible Work chats
that the unfiltered inventory returned. It is not a reliable discovery boundary.
Every thread read, including explicit-ID connections, checks the selected origins
before reading items. Native originator metadata remains in exchange attributes,
while `entrypoint = codex-cloud` continues to identify this collector.

The version-1 grant retains explicit selection. A version-2 account grant stores
scope and the same account fingerprint, with an optional earliest timestamp.
No new central config key grants access. Both modes use the existing backfill
history window; the optional timestamp can only narrow that window.

Each sweep lists active and archived hosted chat metadata, at most 20 pages of 100 per
archive state. Discovery retains only IDs and update timestamps, deduplicates
chats moving between states, and fails visibly on malformed or truncated lists.
It filters ignored sessions and chats older than the effective history window.
At most 20 eligible chats are read per pass. A bounded process-local map rotates
least-recently-attempted chats first; newly discovered chats have priority.
This is fairness state, not a successful-write checkpoint. All eligible chats
are revisited, including failed writes, using the ordinary durable row dedupe.
Daemon restart resets rotation. Repeated restarts can delay older batches.

Chat-specific read failures emit a failure event and allow the next chat to run.
After processing the batch, any such failures make the pass fail visibly rather
than reporting an unqualified success; earlier writes remain valid.
Transport, discovery, authentication and account-switch failures stop the pass.
Each chat still must pass complete bounded pagination before yielding records.
Large inventories take multiple five-minute sweeps; an existing chat's update
may wait for its next rotation. There is no persistent unchanged-history cache.

## Authentication {#authentication}

The collector accepts file-backed, managed ChatGPT authentication only. It asks
the installed Codex app-server for its effective credential-store setting and
account mode, then reads the current access token from the same CODEX_HOME.
It refuses keyring, auto, ephemeral and API-key modes rather than reading a
possibly stale auth.json. Codex owns renewal via account/read refreshToken true
when the access token is within five minutes of expiry. HypAware never POSTs an
OAuth refresh or stores a separate refresh token. Account fingerprints are
checked before renewal, after renewal, and before yielding collected content.

Only the fixed TLS hosted WebSocket origin receives the access token, in the
observed bearer subprotocol. There are no configurable credential destinations
or redirected requests. Failures expose fixed error codes, never raw server,
child-process, protocol or credential content. A generic socket error does not
trigger refresh. Revoked credentials require normal Codex sign-in.

This is a tested implementation interface, not a documented third-party hosted
API contract. Commercial support for third-party collection remains unresolved.
Cross-process Codex refresh races remain an acceptance concern;
HypAware rejects overlapping runs of one provider but does not claim to lock Codex.

## Projection and privacy {#projection}

Only completed native user, assistant, command and MCP items are projected.
Reasoning contents are excluded. Unsupported item types are counted and reported.
Native thread, turn and item IDs are preserved; a tool's call and result get
stable distinct message IDs. Thread-level model metadata stays in attributes,
not the per-request model column. Missing usage remains null, never estimated.
Cloud filesystem paths are metadata, not local filesystem paths: do not resolve
/workspace against the collector's host or claim its local .hypignore applies.
The provider reuses the durable SessionIgnoreSet (LLP 0403), refreshing it before
each manual or scheduled run. Corrupt state refuses capture before network work.
An in-flight import uses the run-start snapshot. The runner's client recording
switch (LLP 0466) also gates this provider through its Codex plugin ownership.
Disconnect removes the cloud-specific grant without disabling local capture.
Normal HypAware export policy still applies to imported records.

## Resource and failure bounds {#bounds}

One socket and one RPC at a time. Each run has a deadline, a total received-byte
budget and bounded pages per selected chat. A chat is yielded only after all
its pages validate. Repeated cursors, malformed identities, an account switch,
or a changed connection selection fail closed. Only completed items are
admitted, preventing append-only dedupe from freezing streaming partial output.
There is no persistent unchanged-thread cache that could suppress a failed write.
The native WebSocket allocates a frame before the application checks its budget;
this remains a transport limit of the dependency-free first implementation.

## Validation {#validation}

Deterministic tests cover account/mode gates, refresh, cancellation, transport
limits, pagination, projections, session opt-out and materialization/deduplication.
An opt-in live acceptance read uses the already-authorized synthetic chat and an
isolated HypAware state directory. Never copy raw research captures into tests;
fixtures reproduce their shapes with synthetic content.
