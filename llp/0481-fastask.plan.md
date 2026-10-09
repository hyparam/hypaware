# LLP 0481: Fastask - Plan

**Type:** Plan
**Status:** Accepted
**Systems:** CLI, Graph, Query, MCP, Daemon, Plugins, Privacy
**Author:** HypForge designer
**Date:** 2026-10-09
**Related:** LLP 0480 (the design), LLP 0479 (the request), LLP 0482 (leave keeps the replica), LLP 0483 (lease renewal and credential change), LLP 0484 (edge kinds and build memory), LLP 0485 (process-CPU work budget), LLP 0486 (stress thresholds after measurement), LLP 0487 (agent-directed operations and skill), LLP 0488 (planner deferred; path-token discovery), LLP 0489 (guarded skill for existing installs); server LLP 0555 and LLP 0556 (server plans), server LLP 0555 T11 (server-first command names)
**Integration branch:** `integration/fastask`

> Tasks to build [LLP 0480](./0480-fastask.design.md). Everything integrates
> on `integration/fastask`. Only the three small core helpers (T2, T3, T4)
> may merge to master early, because they register nothing. The plugin's
> commands, telemetry names and skill guidance reach master only through the
> enabling task (T14), after both server changes are merged, deployed and
> verified, server LLP 0555 T11 is deployed, and integrated acceptance (T13)
> has passed (LLP 0479#ordering, LLP 0480#enablement).

## Scope {#scope}

- New plugin `hypaware-core/plugins-workspace/fastask/` (manifest, `index.js`,
  replica store and sync, index builder and discovery, evidence client,
  output, control route, commands), small core changes in
  `src/core/util/` (backoff helpers, work budget), `src/core/mcp/client.js`
  (abort signal, error code), `src/core/daemon/status.js` and its renderers
  (generic `summary_line`), `src/core/runtime/bundled.js`,
  `src/core/product_telemetry/contract.js`, `src/core/cli/remote_commands.js`
  (replica removal on `remote remove`), the two `hypaware-query` skill copies
  and their divergence fixture, `docs/CONFIGURATION.md`, tests and smokes.
- Out: server changes (server LLP 0555, LLP 0556), delta sync, replicas of
  non-default remotes, persisted indexes, any model call, the context hook,
  Jev.

## Ordering {#ordering}

- External inputs: the server fixture sets from server LLP 0555 T1
  (session evidence, with LLP 0557 and LLP 0558) and server LLP 0556 T1
  (graph snapshot and reference verifier). T1 pins them; nothing else waits
  on a server merge until T13.
- T2, T3, T4 start immediately and are independent.
- T5 (sync), T6 (index and discovery) and T7 (evidence and output) are
  parallel once their inputs exist.
- T8 joins sync and index in the daemon; T9 registers the commands on the
  integration branch; T10 adds the hermetic smokes; T11 and T12 are
  independent close-outs; T13 is integrated acceptance; T14 enables.

## Tasks

- id: T1  branch: codex/fastask/T1  deps: []  complexity: 2  -- Pin the server contract fixtures (server fixtures pinned). Copy test/fixtures/contracts/graph-snapshot/v1/ (server LLP 0556 T1) and test/fixtures/contracts/session-evidence/v1/ (server LLP 0555 T1, as extended by server LLP 0557 and LLP 0558) from the named server commits into this repo under test/fixtures/contracts/, each with a SOURCE.md naming the server repository, branch, commit and contract version; a test fails if a file differs from the recorded SHA-256 list, so a refresh is a deliberate commit. Port the server's reference snapshot verifier (line encoding and order-independent set digest, node:crypto only) into hypaware-core/plugins-workspace/fastask/src/contract.js with tests that verify the pinned graph fixtures and reject a one-byte change. No plugin registration, no manifest commands.
- id: T2  branch: codex/fastask/T2  deps: []  complexity: 1  -- Move the generic helpers parseRetryAfter, abortableSleep, readBodyCapped, discardBody and the retry ladder from hypaware-core/plugins-workspace/central/src/backoff.js to src/core/util/ (behaviour-preserving, per LLP 0480#sync and the steward), with central re-importing; central-specific constants stay in central. Existing central tests pass unchanged; add direct unit tests at the new location. May merge to master early.
- id: T3  branch: codex/fastask/T3  deps: []  complexity: 2  -- MCP client per LLP 0480#evidence: createHttpMcpClient (src/core/mcp/client.js) accepts an optional AbortSignal applied to every fetch, and a JSON-RPC error throws an error that keeps the numeric code (for example err.rpcCode) beside today's message, so callers can tell -32601 from -32602. Default behaviour unchanged for its two existing callers. Tests: abort mid-request rejects promptly and the fake server sees the disconnect; code preserved for -32601 and -32602; existing remote verb tests unchanged. May merge to master early.
- id: T4  branch: codex/fastask/T4  deps: []  complexity: 1  -- Client work budget helper in src/core/util/ per LLP 0480#cooperative as extended by LLP 0485 (slice by rows and by whole-process CPU measured with process.cpuUsage, await setImmediate from node:timers/promises, abortable proportional sleep of cpuUsed x (1 - duty) / duty capped at 2 s, default duty 0.2, throws the signal reason when aborted, a no-sleep mode for the command's cold path). Fake-clock tests; no busy wait; existing ad hoc yields are not migrated. May merge to master early.
- id: T5  branch: codex/fastask/T5  deps: [T1, T2, T4]  complexity: 5  -- Replica store and sync loop per LLP 0480#replica and #sync, as plugin modules with no registration: replica key from canonicalOrigin plus login org; layout replicas/<key>/{replica.json, generations/<g>/, staging/}; the check with If-None-Match, resolveAccessJwt and attachWithRefresh, redirect error and a 30 s AbortSignal; the full interpretation table (304, same or new 200, 401, 403 withdrawn, 400 unsupported, 404 unknown_path and disabled, 410, 429, 503 with retry-after, 5xx, network) into states synced, stale (reason credential or outage), expired, withdrawn, unsupported, unavailable; lease from the hyp-snapshot-lease header, renewed only on the active generation or a new activation, with a credential fingerprint forcing one unconditional check after a token change (LLP 0483); poll interval from the manifest with jitter, clamped to 5 minutes to 6 hours; T2 backoff; streamed download with on-the-fly SHA-256 and a byte ceiling (MAX_REPLICA_BYTES 1 GB); verification with the T1 verifier; atomic replica.json; deletion on withdrawal, expiry, key change and target removal; hyp leave does not touch the replica (LLP 0482). Tests against an in-process fake server built from the T1 fixtures for every table row, a corrupt file, a truncated stream, disk-full simulation, crash between staging and activation (restart leaves the old generation active and staging removed), and coalesced refresh triggers. Spans per LLP 0480#observability.
- id: T6  branch: codex/fastask/T6  deps: [T1, T4]  complexity: 5  -- Index builder and discovery per LLP 0480#index and #discovery, pure modules: stream-decompress and parse NDJSON in T4 slices into the node table, typed-array CSR in both directions with edge type and first-seen, exemplar message map, basename/stem/owner-repo/suffix lookups, placeholders for unresolved endpoints, and a running byte estimate refusing above MAX_INDEX_BYTES (256 MB, and up front from manifest row counts times 100 bytes, LLP 0484) with replica_too_large, per-edge-type counts and the vocabulary_mismatch guard (LLP 0484#edge-kinds); discovery with term extraction (no model), anchor resolution preferring the caller's repository and marking suffix or absolute matches unproven, session scoring, ambiguity groups, 50-anchor and 20,000-visit budgets, truncation and unresolved counts. Tests: the pinned graph fixture plus a generated graph with same-basename files in two repositories (ambiguity returns competing groups), a missing endpoint, a term with no anchor, budget exhaustion, and repository preference. A benchmark script (benchmarks/fastask-client/) builds a generated graph of the measured size and records build time, resident bytes and warm discovery p50/p95.
- id: T7  branch: codex/fastask/T7  deps: [T1, T3]  complexity: 4  -- Evidence client and output per LLP 0480#evidence and #output: entries as JSON strings (server LLP 0557), window of touch time plus or minus 15 minutes and an extra message_ids entry when an exemplar exists, per-call allowance split evenly, deadline_ms from the remaining budget minus the measured server round trip (the daemon's recorded round trip when warm, the handshake when connecting cold) with a 250 ms floor and the T3 abort at the command's own budget, tools/list detection of session_evidence and the contract enum on cold connections (LLP 0480#warm-connection), timings_ms with load, connect, discovery, evidence and total, fallback to per-session query_sql --remote and to local query sql, status wording (not_found reads "no readable text (purged, deleted or outside your access)"), continuation commands for partial and deadline entries, the fastask/1 JSON shape and the human rendering with the freshness header. Tests with the pinned session-evidence fixtures through a fake MCP server: every status, -32601 fallback, -32602 reported as a client defect, invalid_request, aggregate failure exits 1, deadline abort reaches the server, and every generated follow-up command parses with the real command parsers.
- id: T8  branch: codex/fastask/T8  deps: [T5, T6]  complexity: 4  -- Daemon wiring per LLP 0480#index and #status-line: the team-graph-replica source (vector-search precedent) runs the T5 loop, builds the T6 index after activation, swaps it and releases the old one; a 127.0.0.1 port-0 listener with the misdirected-Host guard (src/core/util/loopback.js, isMisdirectedHost), body cap (src/core/util/reject_body.js), per-boot bearer token in a 0600 file, advertised through details.listen_port and details.control_routes; status() details including summary_line in the guardian's wording; the generic summary_line rendering in hyp status (status.js renderers, every state, LLP 0394 extension) with tests; stop() aborts builds and removes staging; the evidence forwarding op per LLP 0480#warm-connection: one kept-alive MCP session per remote, session_evidence support and contract enum recorded per remote and server version, re-initialized on session rejection, -32601, -32602 or a server version change, the caller's abort propagated upstream, and per-call initialize as the recorded fallback if the server refuses session reuse. The plugin manifest declares the source; still no commands. Tests: discover and evidence over the control route with and without the token, session reuse across two calls (one initialize), re-initialize after a rejected session, misdirected Host refused, oversized body refused, summary_line in each state, stop during a build.
- id: T9  branch: codex/fastask/T9  deps: [T7, T8]  complexity: 4  -- Commands on the integration branch per LLP 0480#command and #sources: hyp fastask (flags --remote, --org, --repo, --file, --budget-ms default 2000, --leads, --json; exit codes 0, 1, 2), graph replica status and graph replica refresh beside graph project and compact, and the query evidence verb (tool session_evidence, exposure cli-only, usage error without --remote); source selection warm, cold (labeled with load time), team_server (remote SQL discovery labeled slow, with the reason the replica is unusable), local (local capture graph and local evidence, labeled local captures only); hyp remote remove deletes the target's replica directory directly. Add the four names to COMMANDS so the consistency gate passes on this branch. This branch never merges to master before T14. Tests for each source path, flag validation, exit codes and the LLP 0248 tree checks.
- id: T10  branch: codex/fastask/T10  deps: [T9]  complexity: 3  -- Hermetic smokes per LLP 0480#observability, each with stable smoke_step values and span assertions: fastask_replica_sync (fake server in the remote_oidc_login.js style: first sync, 304 with no download, new generation activated, 403 deletes the replica, 503 re-checks at retry-after, leave leaves the replica in place (LLP 0482)), fastask_query (warm via daemon, cold with the daemon stopped, team_server fallback, local-only; every printed follow-up is executed and must exit 0), and fastask_replica_never_exported (local_only_export_withhold.js template: real sink driver and central sink against a fake ingest; nothing from the replica is ever sent, and the replica is not a registered dataset).
- id: T11  branch: codex/fastask/T11  deps: [T8]  complexity: 3  -- Stress and resource bounds per LLP 0479#acceptance: a generated graph several times the measured size; initial load and refresh in the daemon while capture smokes, health checks and interactive queries run; record event-loop delay p95 and max (budget: p95 at most 20 ms, max at most 100 ms), build CPU duty (whole-process CPU attributable to the work at most 0.25 cores in every 10 s window at the default duty 0.2, download verify at 4x included, LLP 0485), foreground latency regression (at most 10 percent), resident index bytes at the measured size (target at most 128 MB) and at the larger size (within MAX_INDEX_BYTES or refused), no growth across back-to-back 1x refreshes (RSS after the 20th at most RSS after the 10th plus 32 MB, LLP 0486), OTLP ingest added median during builds at most 1 ms (up to 2 ms if documented; gateway capture and discovery within 10 percent), slice time cap 4 ms, and the per-build memory bounds of LLP 0484#build-memory (1x peak increase at most 256 MB; 4x at most 4.5 times the index plus 64 MB or refused up front; up-front refusal at most 32 MB), swap overlap peak, disk use, shutdown latency during a build (under 1 s). Commit sanitized results with hardware stated under benchmarks/fastask-client/results/.
- id: T12  branch: codex/fastask/T12  deps: [T9]  complexity: 2  -- Status and cleanup lifecycle: account or org switch deletes the old replica at the next pass, including a static-token swap to another org detected by the credential fingerprint (LLP 0483), default-remote change, expiry with the daemon stopped (cold path refuses an expired replica), disk-full during download, abandoned staging after a kill, and docs/CONFIGURATION.md's path table gains the replica directory and its bounds. Tests for each.
- id: T13  branch: codex/fastask/T13  deps: [T10, T11, T12]  complexity: 5  -- Integrated acceptance and evaluation (mission evidence under project/missions/fastask/, not a repository procedure: LLP 0430 retired those). Requires server builds containing both merged server changes; record exact server commits and the contract versions hypaware.graph-snapshot/1 and hypaware.session-evidence/1. Run node runtime/product-check.mjs --candidates with the client integration head and that server, then the journey of LLP 0479#completion-gate over the real authenticated transport with the plugin enabled through a plugins[] entry: log in and select the remote, first sync, natural-language fastask, cited original evidence, a server graph change and automatic refresh, later discovery reflecting it, permission withdrawal deleting the replica, leave leaving it in place until a later 403 deletes it (LLP 0482), and fallback against a server without each capability. Include live ingest and a compacted source record: an up-to-date graph must not hide an incomplete evidence index, and an old graph reports its watermark. Time each hyp fastask call end to end at the terminal beside the server elapsed_ms and the connect and load phases (UX guardian requests 1 and 4). These Docker timings leave out the production network and are recorded as such. Run the repeated evaluation matrix (local graph on/off by server index on/off, multiple questions and runs, fixed model and effort, recorded prompts, randomized order, all failures kept), with the agent-directed path of LLP 0487 (query team-graph discover, neighbors, search, then query evidence) as the primary condition, the tested-question acceptance case of LLP 0488#acceptance-case (answered without being given any file, session or message id), and the deferred hyp fastask planner reported separately, never as a gate with fresh Codex and Claude chats using the candidate skill text (the routing paragraph and fastask.md side file, written in this task on the integration branch, installed into the test clients only, and shipped unchanged by T14), and agree release thresholds before the final run.
- id: T14  branch: codex/fastask/T14  deps: [T13]  complexity: 2  -- Enablement per LLP 0480#enablement and #skill. Externally gated: both server changes merged, deployed and verified on the target server, server LLP 0555 T11 deployed, and T13 passed. Remove @hypaware/fastask from V1_EXCLUDED_FROM_DEFAULT and add it through compose_with plus the Claude and Codex presets for new installs (LLP 0489#new-installs); ship T13's evaluated routing paragraph (agent-directed exploration; the deferred planner is not mentioned, LLP 0488) in both hypaware-query copies and the fastask.md side file unchanged, regenerate the skill-host divergence fixture, and update the skill description and content-boundary tests; release notes and user help. The release notes must not claim the two-second target is met for real users from T13's local-server timings; that claim waits for a measurement against a deployed server, which needs its own deployment authority (UX guardian request 5). Verify both clients receive the shipped skill through the normal install and update path. Then integration/fastask merges to master under GITHUB.md.

## Acceptance journey {#acceptance}

Worker and independent reviewer each run, from their own managed context, on
the exact candidate commit:

1. `npm test`, `npm run typecheck`, and `npm pack --dry-run` (the plugin's
   files are in the package).
2. The three hermetic smokes of T10 plus the existing release smoke battery,
   with `HYP_DEV_TELEMETRY=1`, asserting the user-visible result and the
   spans that prove the path.
3. T6's and T11's benchmark runs on stated hardware.
4. For T13 only: the integrated journey above in the HypForge Docker recipe
   (`runtime/product-check.mjs --candidates`, disposable state, no
   production credentials), recording command, UTC time, exit status, server
   commits, contract versions, terminal timings and server `elapsed_ms`.

Fixtures are synthetic or the pinned server fixtures. No organization data,
private paths, credentials or evaluation ground truth enter Git or test logs.
Native macOS install and sleep/wake behaviour need a macOS runner; a Linux
container result is Linux evidence only. Release and deployment need their own
human authority.

## Task rationale {#rationale}

- T1 first: every later test is written against the pinned contracts, so a
  server-side contract change shows up as a deliberate fixture refresh.
- T2, T3 and T4 are small core changes with their own tests; landing them
  early cannot expose the feature.
- T5, T6 and T7 split the three hardest correctness areas (sync states,
  index bounds and discovery honesty, evidence statuses and deadlines) so
  each is proven without the daemon.
- T9 is the first task that registers commands; keeping registration on the
  integration branch until T14 is what keeps telemetry and the skill honest.
- T13 is the HYP-111 integrated gate the request assigns to this issue.
