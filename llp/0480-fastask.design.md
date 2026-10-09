# LLP 0480: Fastask - Implementation Design

**Type:** Design
**Status:** Accepted
**Systems:** CLI, Graph, Query, MCP, Daemon, Plugins, Privacy
**Author:** HypForge designer
**Date:** 2026-10-09
**Related:** LLP 0479 (request), LLP 0004 (paths and state directories), LLP 0023 (graph identity and provenance), LLP 0033 (remote attach), LLP 0034 (verbs and MCP), LLP 0063 (connection ladder), LLP 0064 (graph query), LLP 0070 and LLP 0105 (export and query seams), LLP 0166 and LLP 0300 (local control trust), LLP 0213 (graph guidance lives in the query skill), LLP 0248 (command tree), LLP 0305 (central eligibility), LLP 0393 (product telemetry vocabulary), LLP 0394 (source health in status), LLP 0430 (no manual acceptance procedures), LLP 0457 and LLP 0458 (skill updates); server LLP 0554 (`hypaware.graph-snapshot/1`), server LLP 0553, LLP 0557, LLP 0558 (`hypaware.session-evidence/1`), server LLP 0555 T11 (server-first command vocabulary)
**Implemented-by:** [LLP 0481](./0481-fastask.plan.md)
**Extended-by:** [LLP 0488](./0488-planner-deferred-and-discover-matches-path-tokens.decision.md) (the planner is deferred from the shipped surface; discover matches path tokens)
**Extended-by:** [LLP 0487](./0487-fastask-teaches-agent-directed-exploration.decision.md) (agent-callable `query team-graph discover|neighbors|search`; the skill teaches agent-directed exploration first; the planner is optional)
**Extended-by:** [LLP 0486](./0486-t11-stress-thresholds-after-measurement.decision.md) (slice time cap 4 ms; memory plateau and no-growth window)
**Extended-by:** [LLP 0485](./0485-the-client-work-budget-is-clocked-on-process-cpu.decision.md) (the work budget is clocked on whole-process CPU, duty 0.2, sleeps capped at 2 s)
**Extended-by:** [LLP 0484](./0484-discovery-walks-touched-and-the-build-is-bounded-before-it-starts.decision.md) (discovery walks `touched` with a vocabulary-drift guard; up-front size refusal; `MAX_INDEX_BYTES` 256 MB)
**Extended-by:** [LLP 0483](./0483-replica-lease-renews-only-on-the-active-generation.decision.md) (the lease renews only on the active generation; a changed credential forces an unconditional check)
**Extended-by:** [LLP 0482](./0482-leave-keeps-the-team-graph-replica.decision.md) (`hyp leave` keeps the replica; the "not kept after leave" status line is not used)
**Extends:** [LLP 0248](./0248-task-oriented-cli-rollover.decision.md) (adds the top-level `fastask` journey to the canonical tree, [#command-tree](#command-tree)); [LLP 0394](./0394-a-source-reports-its-own-health.decision.md) (a source may publish one always-shown summary line, [#status-line](#status-line))

> The design for [LLP 0479](./0479-fastask.spec.md). A new bundled plugin,
> `@hypaware/fastask`, off by default. In the daemon it keeps one replica of
> the default remote's authorized team graph on disk, synced through the
> server's snapshot protocol, and one compact index of it warm in memory. The
> `hyp fastask "<question>"` command asks that warm index for leads, reads
> original evidence for the best leads through the server's
> `session_evidence` tool within a deadline, and prints leads with their
> provenance, freshness and incompleteness. Nothing is registered or
> advertised until the feature is enabled.

**Covers (coverage anchor):**

- @ref LLP 0479#req-replica [implements] - replica lifecycle, sync, warm index, bounds: [#replica](#replica), [#sync](#sync), [#index](#index), [#cooperative](#cooperative).
- @ref LLP 0479#req-interface [implements] - command, sources, discovery, evidence, output: [#command](#command), [#sources](#sources), [#discovery](#discovery), [#evidence](#evidence), [#output](#output).
- @ref LLP 0479#req-skill [implements] - skill guidance and its gating: [#skill](#skill).
- @ref LLP 0479#ordering [constrained-by] - disabled, unregistered and unadvertised until enablement: [#enablement](#enablement).

## What exists today {#today}

- Remote targets, OIDC credentials with silent refresh and one-retry-on-401
  (`src/core/remote/credentials.js`: `resolveAccessJwt`,
  `attachWithRefresh`), the remote MCP client (`src/core/mcp/client.js`,
  no `AbortSignal`), and `runRemoteVerb` that forwards a verb's params to the
  server tool of the same name (LLP 0033).
- A conditional poll precedent: the central config pull loop
  (`central/src/config_client.js`, ETag, 304, `Retry-After`, abortable
  sleeps), with backoff helpers private to that plugin
  (`central/src/backoff.js`).
- Plugin background work runs as a source in the processing child (the
  vector-search refresh source), which reports `status()` into
  `status.json` (LLP 0394). There is no daemon-to-CLI query channel; the only
  local daemon surface is `/_hypaware/` control routes on localhost
  listeners, found through `status.json` (session ignore).
- The local context graph: `node`/`edge` datasets, content-addressed ids,
  `mergeRow`, and seed resolution by id, then key, then label, never choosing
  among ambiguous matches (LLP 0023, LLP 0064, LLP 0431). The pure in-memory
  traversal LLP 0064 names was removed; reads are frontier-scoped SQL now.
- The `hypaware-query` skill copies (Claude and Codex plugins), distributed
  with the client-asset materializer and ledger (LLP 0457, LLP 0458). There
  is no feature flag for assets.
- The product-telemetry command vocabulary must equal the registered command
  set (`test/core/cli-consistency-gate.test.js`), and a server that does not
  know a name refuses the whole batch (LLP 0393#contract).
- `hyp ask` exists (LLP 0198, LLP 0398): it launches a client with gathered
  evidence. Fastask is the opposite shape: no client launch, no model call,
  just leads for whoever asked.

## Packaging and enablement {#enablement}

**Extended-by:** [LLP 0488#planner-deferred](./0488-planner-deferred-and-discover-matches-path-tokens.decision.md#planner-deferred): `fastask` is not part of the shipped surface; it is unregistered on the integration branch and its code kept for later evaluation.

- One new bundled plugin, `hypaware-core/plugins-workspace/fastask`
  (`@hypaware/fastask`), listed in `V1_EXCLUDED_FROM_DEFAULT`
  (`src/core/runtime/bundled.js`). It activates only through an explicit
  `plugins[]` entry, which is how a tester enables it before release.
- While inactive the feature is absent: no commands, no source, no files, no
  skill text. `hyp fastask` is an unknown command. Nothing half-works (UX
  guardian journey 7).
- **Preparatory merges register nothing.** Modules, tests and fixtures may
  merge to master early (LLP 0479#ordering), but the plugin manifest's
  commands, its `activate()` registrations and its product-telemetry names
  merge only in the enabling task, because the consistency gate makes every
  registered command a telemetry name, and a telemetry name the receiver does
  not admit drops the user's whole batch (server LLP 0555 T11 must be deployed
  first).
- **Final enablement** (one task, after both server changes are merged,
  deployed and verified, and integrated acceptance passes): remove the plugin
  from `V1_EXCLUDED_FROM_DEFAULT`, add its command names to `COMMANDS`, and
  ship the skill guidance ([#skill](#skill)).

Command names the client will report (for server LLP 0555 T11): `fastask`,
`graph replica status`, `graph replica refresh`, `query evidence`.

## Commands {#command}

**Extended-by:** [LLP 0487#decision](./0487-fastask-teaches-agent-directed-exploration.decision.md#decision): three agent-callable operations, `query team-graph discover`, `neighbors` and `search`, join the commands below; `hyp fastask` stays as an optional shortcut.

<a id="command-tree"></a>Following LLP 0248's tree (journeys stand alone, operations sit under a
noun). `query evidence` sits under the query journey and `graph replica
status|refresh` beside `graph project|compact`, both within the tree as
settled. `fastask` is a new top-level journey beside `ask`: this document is
the extension of LLP 0248 that records it (steward, 2026-10-09), and LLP 0248
carries an `Extended-by` line pointing here.

| Command | Kind | Purpose |
| --- | --- | --- |
| `hyp fastask "<question>"` | plugin command | The journey: leads plus evidence. |
| `hyp graph replica status` | plugin command | Replica state for the selected remote. |
| `hyp graph replica refresh` | plugin command | Ask the daemon to check now (coalesced). |
| `hyp query evidence --remote <t> --session '<entry json>' ...` | verb, `tool: session_evidence`, `exposure: cli-only` | A runnable follow-up and continuation for one or more sessions, forwarded by `--remote` to the server tool (LLP 0033). Without `--remote` it exits 2: "query evidence reads a team server; pass --remote". |

`hyp fastask` flags: `--remote <target>` (default: the default remote),
`--org <label>` (as elsewhere), `--repo <path>` (default: the caller's
repository), `--file <path>` (repeatable anchors), `--budget-ms <n>`
(default 2000, the user-facing time budget: the RFC's target is useful
partial results at two seconds, and tuning is judged against that target,
not by loosening it), `--leads <n>` (default 8,
maximum 40), `--json`. Exit 0 when leads or an explicit "no leads" result was
produced, 1 on an aggregate failure (nothing could be read), 2 on usage.

`--json` follows the `--json` convention of `query graph neighbors`
(LLP 0214); agents are the main caller (journey 6).

## Sources {#sources}

Every result names the source that answered (journey 1). In order of
preference:

| Source | When | Discovery | Evidence |
| --- | --- | --- | --- |
| `team_replica` (warm) | A replica generation is active and within lease, and the daemon answers. | Daemon's warm index. | `session_evidence` on the remote. |
| `team_replica` (cold) | Same, but the daemon is not running or not reachable. | The command builds the index itself from the active generation on disk, bounded, and says "daemon not running: loaded the team graph in N ms". | `session_evidence`. |
| `team_server` | A remote is selected but no usable replica exists: not downloaded yet, expired, withdrawn, server too old, or snapshots disabled. | Remote fallback: bounded `query_sql --remote` over `node`/`edge` (the prototype's original path), labeled slow, with the reason the replica is unusable. | `session_evidence`, or per-session `query_sql --remote` when the server predates it (server LLP 0553#discovery). |
| `local` | No remote is configured or logged in. | Local capture graph (`node`/`edge`) loaded into the same index builder, bounded, labeled "local captures only". | Local `ai_gateway_messages` through `query sql`, per session, same window rules. |

The local capture graph and every team replica stay separate: separate
storage, separate indexes, and every lead names its source. Fastask never
merges them.

## The replica {#replica}

**Extended-by:** [LLP 0483#credential-change](./0483-replica-lease-renews-only-on-the-active-generation.decision.md#credential-change): static and environment-token logins key on origin plus an empty org until `manifest.org` is known, and `replica.json` records a credential fingerprint.

- **Scope.** One replica per process: the default remote target (LLP 0062)
  when it has a login, keyed by the canonical server origin plus the org on
  that login (`sameServer`/`canonicalOrigin`, `builtin_remotes.js`). A login
  to a different org or server yields a different key; replicas whose key is
  no longer current are deleted by the next sync pass. An explicit
  `--remote` naming another target is answered through `team_server`.
- **Location.** `<state>/plugins/@hypaware/fastask/replicas/<key>/`
  (`ctx.paths.stateDir`, LLP 0004). Never under the cache, never a registered
  dataset: a dataset is enumerated by the sink driver and is eligible for
  central forwarding by default (LLP 0305#eligibility), and it would be
  filtered through this machine's `cwd` visibility rules, which mean nothing
  for teammates' paths (LLP 0105). The replica is teammates' data and must
  never ship anywhere (journey 3).
- **Layout.**

  ```
  replicas/<key>/
    replica.json                   # target, origin, org, active generation, lease expiry, last check, last error
    generations/<g>/manifest.json  # as served, verified
    generations/<g>/nodes.ndjson.gz
    generations/<g>/edges.ndjson.gz
    staging/<random>/              # removed at start and after any failed sync
  ```

- **Retention.** The active generation, plus the previous one only until the
  new one's index is live. Disk is bounded by about two generations plus one
  staging download (about 150 MB at the measured graph size); a manifest
  whose files exceed `MAX_REPLICA_BYTES` (default 1 GB) is refused with
  `replica_too_large` and the previous generation stays.
- **Deletion.** The replica is deleted at: `403 snapshot_access_withdrawn`
  (immediately); lease expiry (the daemon stops serving it at expiry and
  deletes it at the next pass); `hyp remote remove <target>` (the sync loop
  deletes replicas whose target is gone; the command also removes the
  directory directly so it is immediate); a change of default remote or org.
  **Extended-by:** [LLP 0482#decision](./0482-leave-keeps-the-team-graph-replica.decision.md#decision): `hyp leave` does not touch the replica; the leave rule below is reverted.
  `hyp leave`: when the central enrollment for the replica's server is
  removed, the source deletes that server's replica (all generations and
  staging) and suspends sync for it until the next successful `hyp remote
  login` or `hyp join` to that server. It needs no server call, so it works
  offline. This deletes derived data only; the query login itself stays, as
  LLP 0063's connection ladder requires (`leave` keeps query sessions). The
  source detects it at start and reload (`leave` restarts the daemon) by
  comparing the replica's recorded enrollment with `readCentralEnrollment`;
  the cold path checks the same before serving. Involuntary credential loss
  (`401`) keeps the replica within the lease (UX guardian, 2026-10-09). The
  client has no explicit sign-out today (`hyp remote logout` is a known gap,
  LLP 0063); when one is added it deletes the replica like `leave`.

## Sync {#sync}

A plugin source, `team-graph-replica`, in the processing child (the
vector-search refresh source is the precedent), owns all replica writes. It
runs a self-rescheduling loop modelled on the central config pull loop:

1. **When.** At source start, on reload, after a reconnect (a failed check
   followed by a success), on `graph replica refresh` (coalesced with any
   check in flight), and otherwise after the manifest's
   `poll.interval_seconds` plus uniform jitter up to `poll.jitter_seconds`,
   clamped to [5 minutes, 6 hours]. `Retry-After` on `429`/`503` overrides
   the interval. Errors back off through the existing ladder (30, 60, 120,
   300 seconds). The generic helpers in `central/src/backoff.js`
   (`parseRetryAfter`, `abortableSleep`, `readBodyCapped`, `discardBody` and
   the ladder) move to `src/core/util/` as their own behaviour-preserving
   step, with central re-importing them; central-specific constants stay in
   central (steward).
2. **Check.** `GET <base>/v1/graph/snapshot?protocol=1` with
   `If-None-Match: "<active generation>"`, the target's access JWT through
   `resolveAccessJwt` and `attachWithRefresh` (one forced refresh on `401`),
   `redirect: 'error'`, and an `AbortSignal` deadline (30 s). The endpoint is
   derived from the registered base URL like the MCP and reports endpoints
   (LLP 0084).
3. **Interpret** (server LLP 0554#responses):

   | Answer | Replica action | State |
   | --- | --- | --- |
   | `304` | Renew lease from `hyp-snapshot-lease`. | `synced` |
   | `200`, same generation | Renew lease. | `synced` |
   | `200`, new generation | Renew lease; download ([step 4](#sync)). | `synced` (old) then `synced` (new) |
   | `401` after refresh | Keep serving within lease. | `stale` (reason `credential`) |
   | `403 snapshot_access_withdrawn` | Delete the replica now. | `withdrawn` |
   | `400 unsupported_protocol` | Keep nothing new; serve old within lease. | `unsupported` |
   | `404 unknown_path` / `graph_snapshots_disabled` | Serve old within lease. | `unsupported` / `unavailable` |
   | `503 snapshot_pending` | Re-check at `retry-after`. | `stale` or `unavailable` |
   | `429`, `5xx`, network | Back off. | `stale` (reason `outage`) |

   Past lease expiry with no successful check, the state is `expired`: the
   index is dropped from memory and the files are deleted at the next pass.

   **Extended-by:** [LLP 0483#lease-renewal](./0483-replica-lease-renews-only-on-the-active-generation.decision.md#lease-renewal): the `200, new generation` row renews the lease only once that generation is activated; a `200` the client cannot activate does not renew it. [LLP 0483#credential-change](./0483-replica-lease-renews-only-on-the-active-generation.decision.md#credential-change): after a credential change the next check is sent without `If-None-Match`.
4. **Download.** For a new generation: refuse unknown `schema_version`,
   `id_recipe` or protocol major before downloading. Stream each file with
   `fetch` into `staging/` (Web stream to file through `pipeline`, so
   backpressure holds), hashing SHA-256 on the fly and failing past the
   manifest's `bytes`. A `410` restarts from the manifest once per pass.
5. **Verify.** Compressed SHA-256 equals the manifest's; decompressing
   (streamed) yields exactly `rows` lines, each a JSON object with exactly
   the manifest's columns; the set digest (sum modulo 2^256 of per-line
   SHA-256) equals `set_digest`. The reference verifier from server LLP 0556
   T1 is ported or vendored as the test oracle.
6. **Index and activate.** Build the index from the staged files
   ([#index](#index)) in bounded slices; on success move staging into
   `generations/<g>/`, write `replica.json` atomically (`fs_atomic.js`), swap
   the in-memory index pointer, release the old index, then delete the old
   generation. A failure at any step deletes staging and leaves the old
   generation active and untouched (never a partial index).

The source's `status()` reports `{state, reason, generation, watermark,
watermark_age_s, published_at, last_check, last_success, lease_expires_at,
bytes_on_disk, index_bytes, rows, refresh_in_progress, summary_line}` in
`details`, which `hyp status --json` carries. `hyp graph replica status`
prints all of it, always including the watermark age.

<a id="status-line"></a>**Status line.** `hyp status` prints the source's
`details.summary_line` as one plain line, in every state, including healthy.
This extends LLP 0394's quiet-when-healthy rule for this one line: the age
of the team's data is information the user needs even when nothing is wrong
(UX guardian). The renderer is generic (any source may publish one
`summary_line`); only this source does today. Wording, always with the
data's age:

```
team graph: synced, data as of 14 h ago (acme), 52 MB
team graph: stale, server unreachable since 09:12, data as of 2 d ago, usable until Oct 12 09:00
team graph: stale, sign in again (hyp remote login), data as of 2 d ago, usable until Oct 12 09:00
team graph: expired, not used; reconnect to refresh
team graph: removed, access to acme was withdrawn
team graph: unsupported, upgrade hypaware (or the server is older than this feature)
team graph: unsupported, upgrade hypaware; still using data as of 2 d ago until Oct 12 09:00
team graph: not kept after leave; queries still use your login to <server>   (not used, LLP 0482)
team graph: not available yet (server has not published one)
```

`hyp fastask` repeats the same state and age in its header line.

## The warm index {#index}

**Extended-by:** [LLP 0484#build-memory](./0484-discovery-walks-touched-and-the-build-is-bounded-before-it-starts.decision.md#build-memory): `MAX_INDEX_BYTES` defaults to 256 MB, a generation is refused before download when its manifest row counts times 100 bytes exceed it, and a transient build peak of about four times the index is accepted.

One index per active generation, built from the two NDJSON files:

- **Nodes.** `node_id` to a dense integer through a single string-keyed map;
  per node: type (interned to a small integer), `natural_key`, `label`, and
  for Session nodes `first_seen` and the `props` fields fastask shows
  (`cwd`, `git_branch`, `client_name`, `user_id`). Other `props` and
  provenance stay on disk and are read on demand from the generation file
  only when a lead needs them.
- **Edges.** Typed-array CSR adjacency in both directions (`Uint32` node
  indexes, `Uint8` edge type, `Float64` first-seen milliseconds), plus a
  sparse map of exemplar `message_id`/`part_id` for edges whose
  `source_keys` carries them (some action-derived rules do; most `touched`
  edges carry only `session_id`). Edges to absent nodes get placeholder
  indexes, counted, never dropped (server LLP 0554#manifest `unresolved`).
- **File lookup.** A map from lowercased basename and from basename stem to
  File node indexes, and a map from `owner/repo` to the File nodes keyed
  under it, so anchor lookup never scans every File node (the RFC's 61k-node
  scan is replaced). Absolute-path File keys are also indexed by their last
  three path segments for suffix candidates.
- **Memory.** The prototype measured 80.8 MB heap plus 9.5 MB buffers for
  142,766 nodes and 462,042 edges with full Session props. The index target
  is at most 128 MB resident at that size; a hard ceiling
  (`MAX_INDEX_BYTES`, default 512 MB, estimated during the build) refuses a
  larger generation with `replica_too_large` instead of growing. During a
  swap two indexes exist briefly; the old one is released before the old
  generation's files are deleted.

The daemon serves the index through one control route on a `127.0.0.1`
listener the source opens on an ephemeral port, advertised as
`details.listen_port` and `details.control_routes` in `status.json` (the
session-ignore discovery path, `resolveLiveControlRouteEndpointsFromStatus`).
The listener binds `127.0.0.1` on port 0, rejects misdirected `Host`
headers with the existing guard (`src/core/util/loopback.js` and
`isMisdirectedHost`, `src/core/otlp/server.js`) against DNS rebinding, caps
request bodies with the existing drain (`src/core/util/reject_body.js`), and
requires a per-boot random bearer token that the source writes to a
mode-0600 file in its state directory; the state directory is the trust
boundary (LLP 0166, LLP 0300), so another local user cannot read the replica
through the port. Requests are small JSON (`discover`), bounded
([#discovery](#discovery)), and answered from memory only.

Material alternative: a Unix socket in the state directory (the prototype's
choice). Equivalent trust and no token file, but it has no precedent here and
adds platform code; rejected with the steward (2026-10-09).

## Discovery {#discovery}

**Extended-by:** [LLP 0488#path-tokens](./0488-planner-deferred-and-discover-matches-path-tokens.decision.md#path-tokens): terms match path tokens (directory segments and basename parts split on `/ - _ .` and camelCase, prefix for terms of four or more characters), not only basenames and stems, under stated bounds.

**Extended-by:** [LLP 0484#edge-kinds](./0484-discovery-walks-touched-and-the-build-is-bounded-before-it-starts.decision.md#edge-kinds): discovery walks `touched` edges (the projectors' vocabulary, passed through the snapshot unchanged); a generation with File nodes but no `touched` edges is flagged `vocabulary_mismatch` and answered through the `team_server` fallback.

Input: the question, the repository context (`--repo`, else the caller's
repository from its git remote and root), and `--file` anchors.

1. **Terms.** Extract up to 12 terms: path-like tokens and filenames as
   written, identifiers split on camelCase, snake_case and punctuation,
   remaining words minus a short stopword list. No model call.
2. **Anchors.** `--file` paths resolve exactly (`owner/repo:relpath` when the
   repository is known, else the absolute path), then by suffix. Each term
   matches File basenames and stems through the lookup maps, preferring Files
   in the caller's repository (exact `owner/repo` key) and marking suffix or
   absolute-path matches as candidates, not proven identity (LLP 0479).
   At most 50 anchors.
3. **Sessions.** Walk `touched` edges into each anchor (bounded: 20,000 edge
   visits), and score each session by matched anchors (exact repository
   match weighs most), distinct terms covered, and recency of the touch
   (`first_seen` of the edge, used only as an ordering hint).
4. **Ambiguity.** Anchors group by the term that matched them. When the best
   groups name different files (two `login.js` in different places, or
   `login` matching several files), the result returns competing leads per
   group and says so; it never collapses them into one confident lead
   (journey 5).
5. **No anchor.** When no anchor matches, discovery returns no graph leads
   and the command falls back to the existing server text search
   (`grep_search --remote` with the terms, server LLP 0127) or, for `local`,
   local grep; results are labeled "found by text search, not the graph".

Output of discovery: up to `--leads` sessions, each with the anchors and
edges that justify it, the touch time, the exemplar message id when known,
the Session's shown props, plus `visits`, `truncated` and the unresolved
count met. Warm discovery is pure in-memory work bounded by the visit budget;
the target is under 100 ms p95 on the reference graph (LLP 0479#acceptance).

The graph ranks; it never excludes (LLP 0479). Every result includes a
follow-up that widens beyond the graph.

## Evidence {#evidence}

For the top leads (default 6, at most 16), one `session_evidence` call on
the selected remote (server LLP 0553#contract as extended by LLP 0557 and
LLP 0558):

- Each entry is `JSON.stringify` of `{session_id, from, to, order: "asc",
  max_parts}`: the window is the touch time minus 15 minutes to plus 15
  minutes; when the edge carried an exemplar `message_id`, the entry also
  asks for that message by `message_ids` in a second entry. `max_parts`
  divides a per-call allowance (default 240 parts) evenly. `roles` is
  `["user", "assistant"]`, `part_types` is `["text"]`, `max_text_chars` is
  2,000.
- <a id="warm-connection"></a>**One round trip on the warm path.** A fresh
  MCP `initialize` plus `tools/list` per command would spend much of a
  two-second budget before the evidence call starts (remote calls measured
  about 0.8 to 1.3 s in the RFC). So on the warm path the command sends the
  evidence request to the daemon's control route, and the daemon forwards it
  over an MCP session it keeps per remote: initialized once, with
  `session_evidence` support and the `contract` enum recorded per remote and
  server version, kept alive between calls, and re-initialized only when the
  server rejects the session, answers `-32601` or `-32602`, or the server
  version changes. The command's abort travels to the daemon, which aborts
  the upstream request. If the server does not accept a reused session, the
  daemon initializes per call and the plan records it (LLP 0481 T8). The cold
  and `team_server` paths connect from the command and time the handshake as
  its own phase (`connect` in `timings_ms`).
- **Deadline.** `deadline_ms` is the remaining budget after discovery minus
  the measured round trip to the server (the daemon's last measured round
  trip on the warm path, the handshake on a cold connection), per server
  LLP 0553#deadline and LLP 0558 item 7, with a floor of 250 ms. The MCP
  client gains an optional `AbortSignal` (`createHttpMcpClient`) so the
  request is aborted at the command's own budget; the server sees the
  disconnect and stops (LLP 0418 on the server).
- **Discovery of support.** `session_evidence` support is known from the
  daemon's record on the warm path, and from `tools/list` on a cold
  connection: the tool must be present with `hypaware.session-evidence/1` in
  its `contract` enum. Otherwise the command uses per-session `query_sql
  --remote` with the same window and a `LIMIT`, labeled "server without
  evidence index support" (slower, same rows).
- **Statuses.** Per entry, as the server reports them (server LLP 0558): a
  `not_found` lead is shown as "no readable text (purged, deleted or outside
  your access)", never "this session does not exist" (UX guardian). `partial`
  and `deadline` entries carry a runnable continuation
  ([#output](#output)).
- **Failures.** `-32601` means the server lacks the tool (fallback above);
  `-32602` and `invalid_request` are client defects and are reported, not
  hidden; an aggregate failure (nothing read at all) exits 1 with the reason.
  The client's MCP error path keeps the JSON-RPC error code (today it is
  folded into the message text, `src/core/mcp/client.js`), so these channels
  are distinguishable.

## Output {#output}

Human output is a short list: per lead, the session (time, repository,
branch, client), why it was chosen (anchors and edges), up to three excerpts
with role and timestamp, and coverage notes; then the follow-ups; then one
freshness line ("team graph as of <watermark> (<age>), evidence received
through <time>"). Leads, not an answer (journey 4).

`--json` output (`fastask/1`, stable fields):

```json
{
  "contract": "fastask/1",
  "question": "why is the login function shaped this way",
  "source": {
    "kind": "team_replica",
    "path": "warm",
    "remote": "hyperparam",
    "org": "acme",
    "generation": "1760000000000-7",
    "watermark": "2026-10-09T01:45:00.000Z",
    "watermark_age_s": 3600,
    "replica_state": "synced",
    "note": null
  },
  "leads": [
    {
      "session_id": "s-1",
      "rank": 1,
      "group": "login.js",
      "why": [{ "anchor": { "type": "File", "key": "acme/app:src/login.js", "match": "basename", "proven": true }, "edge": "touched", "touched_at": "2026-08-31T22:35:40.016Z" }],
      "session": { "first_seen": "2026-08-31T22:01:00.000Z", "cwd": "/repo", "git_branch": "main", "client_name": "claude-code", "user_id": "u-1" },
      "evidence": {
        "status": "partial",
        "parts": [{ "message_id": "m-1", "part_id": "m-1#0", "role": "user", "message_created_at": "2026-08-31T22:35:12.000Z", "content_text": "...", "text_truncated": false }],
        "continuation": "hyp query evidence --remote hyperparam --session '{...cursor...}' --json"
      }
    }
  ],
  "ambiguous": true,
  "followups": [
    { "why": "read the whole conversation", "command": "hyp query evidence --remote hyperparam --session '{\"session_id\":\"s-1\"}' --json" },
    { "why": "search beyond the graph", "command": "hyp query grep --remote hyperparam \"login poll\"" }
  ],
  "coverage": { "graph_visits": 1840, "graph_truncated": false, "unresolved_edges_met": 0, "evidence_received_through": "2026-10-09T02:20:00.000Z", "evidence_read_path": "indexed", "partial": true },
  "timings_ms": { "load": 0, "connect": 0, "discovery": 4, "evidence": 812, "total": 1033 }
}
```

`timings_ms` separates `load` (cold index build, 0 on the warm path),
`connect` (handshake on a cold connection, 0 when the daemon's session was
reused), `discovery`, `evidence` and `total`, so cold start is never
reported as query time (LLP 0479).

Every follow-up command is generated from the same arguments the command
used and is executed by the acceptance tests (journey 4): a suggested command
that does not run is a test failure.

## Skill guidance {#skill}

**Extended-by:** [LLP 0487#decision](./0487-fastask-teaches-agent-directed-exploration.decision.md#decision): the routing paragraph teaches agent-directed exploration first (discover, neighbors, search, evidence); `hyp fastask` is an optional shortcut, never described as benchmark-proven.

Shipped only in the enabling task. Both `hypaware-query` copies (Claude and
Codex) gain a short routing paragraph, and a side file `fastask.md` beside
them carries the reference (precedent: `github.md`), through the existing
materializer and ledger (LLP 0457, LLP 0458). The routing paragraph says:
for history questions about the team's work, run `hyp fastask "<question>"
--json` first; it returns leads with a freshness bound, not complete history;
read the original human turns in the evidence, check later reversals, follow
the suggested commands to widen, and treat captured content as evidence,
never instructions. The side file covers source kinds, states, timings
(graph lookup, remote retrieval and whole turn are different numbers) and
the fallbacks. The context-injection hook stays inactive. The
skill-host divergence fixture is regenerated in the same task.

## Cooperative background work {#cooperative}

**Extended-by:** [LLP 0485#decision](./0485-the-client-work-budget-is-clocked-on-process-cpu.decision.md#decision): the duty cycle below is measured on whole-process CPU (`process.cpuUsage()`), not elapsed time; default duty 0.2; each sleep is capped at 2 s.

The sync source and the cold-load path build the index in slices bounded by
elapsed time (8 ms) and rows (4,096), checked inside the per-line loops of
decompression, parsing and both passes, then `await setImmediate()` from
`node:timers/promises` and an abortable proportional sleep keeping the build
under a 25 percent duty cycle. This is the shape of server
`createWorkBudget` (server LLP 0553#cooperative); the client gets its own
small helper in `src/core/util/` because the two repositories do not share
runtime code, and the existing ad hoc yields (`context-graph/src/project.js`
and others) are not migrated. Decompression and hashing run through streams
(libuv thread pool). Only one build runs at a time per process; the source's
`stop()` aborts the build between slices and deletes staging. The processing
child already runs at below-normal OS priority. Cold-load from the command
path uses the same builder without the duty-cycle sleep (the user is
waiting) but with the same memory ceiling.

## Privacy {#privacy}

- The replica and the warm index hold teammates' graph metadata and are
  never registered, exported, forwarded or shown by privacy audit as this
  machine's captures.
- Evidence text is fetched per call and not cached on disk.
- Known existing property, not introduced here: when an agent runs
  `hyp fastask` (or `hyp query sql --remote`) inside a captured session,
  the output becomes that session's captured content (the LLP 0105
  transcript leak) and follows that session's export rules. This design
  states it in the skill side file and does not change it.
- No telemetry carries questions, terms, keys or text; spans carry counts,
  timings, states and error kinds.

## Observability {#observability}

Spans: `fastask.run` (source kind, path, leads, ambiguous, timings),
`fastask.discover`, `fastask.evidence` (entries, statuses, deadline,
fallback), `replica.check` (answer, state), `replica.download`,
`replica.verify`, `replica.index` (rows, ms, bytes), `replica.activate`,
`replica.delete` (reason). Attributes follow LLP 0021's contract; smokes
assert them with stable `smoke_step` values.

## CPU and memory review {#cpu-memory}

- Command, warm path: one small request to the daemon, an in-memory
  discovery bounded by 50 anchors and 20,000 edge visits, and one bounded
  evidence call. No graph parse per prompt.
- Command, cold path: one bounded index build per invocation (labeled), the
  same ceiling as the daemon.
- Daemon: one resident index (target 128 MB at the measured size, hard
  ceiling 512 MB); a swap briefly holds two. Downloads stream to disk; no
  whole-file buffers. One build at a time, duty-cycled.
- Disk: about two generations plus staging; refused above 1 GB.
- Network: one conditional check per poll interval; a full download only on
  a new generation.

## Material alternatives {#alternatives}

- **Register the replica as a dataset and query it with SQL.** Rejected:
  sinks and central forwarding would see it (LLP 0305), and LLP 0105's
  visibility filter does not apply to teammates' paths.
- **Load the index in every command, no daemon.** Rejected as the primary
  path (the request forbids a graph parse per prompt); kept as the labeled
  cold path when the daemon is down.
- **Extend `hyp ask`.** Rejected: `ask` launches a client with gathered
  evidence; fastask returns leads to whoever is already asking, often an
  agent, without a launch or model call.
- **Replicate every logged-in remote.** Deferred: one replica for the default
  remote bounds disk and memory; others use `team_server`.
- **Persist the built index to disk.** Deferred: rebuilding from the verified
  NDJSON at daemon start is bounded and avoids a second format to version.

## Open questions {#open-questions}

1. Settled with the UX guardian (2026-10-09): `hyp leave` deletes the
   replica and suspends its sync without removing the query login
   ([#replica](#replica)). Extended-by [LLP 0482](./0482-leave-keeps-the-team-graph-replica.decision.md): reverted, `leave` keeps the replica.
2. Release thresholds for relevance and latency (LLP 0479#completion-gate)
   are set before the final evaluation run; the plan names the run, not the
   numbers.
3. Default `--budget-ms` 2000 and lead and evidence allowances are proposals
   tuned by the evaluation matrix, judged against the two-second user
   target (UX guardian).
4. How the sync source finds the default remote. Decided default
   (2026-10-09, team; overrulable by Phil): the kernel hands plugins only
   their own config section (LLP 0422, LLP 0425), so the source resolves the
   default remote and its login through the same loader and function
   `hyp status` uses (`HYP_CONFIG` or the default path, plus the central
   layer), never a reimplementation; it re-resolves on every source reload,
   and puts the resolved config path and target name in its status details.
   A daemon started with a different explicit `--config` diverges exactly as
   `hyp status` does today; a kernel accessor for the effective query config
   is a follow-up only if that divergence is seen (steward fit: no kernel
   contract change; CLAUDE.md: reuse before you add).
