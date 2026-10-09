# LLP 0479: Fastask With a Local Team Graph and Remote Evidence

**Type:** Spec
**Status:** Accepted
**Systems:** CLI, Graph, Query, MCP, Daemon, Clients
**Author:** Phil (issue) / HypForge designer
**Date:** 2026-10-09
**Source:** [HYP-111](https://linear.app/hyperparam/issue/HYP-111/hypaware-add-fastask-with-a-local-team-graph-and-model-retrieval) (revision 2026-10-09T00:38:08Z)
**Origin:** Phil's draft RFC "Fastask with a local team graph and remote evidence" (October 8, 2026, uncommitted, numbered 0473 in its author's checkout; that number belongs to LLP 0473 on another branch). Its replication contract, local serving bounds and experiment results are the explored design this request draws on.
**Related:** LLP 0023 (context-graph projection), LLP 0064 (graph query), LLP 0033 (remote query attach), LLP 0105 (local-only visibility); server LLP 0552 and LLP 0554 (graph snapshots, `hypaware.graph-snapshot/1`), server LLP 0551, LLP 0553, LLP 0557, LLP 0558 (session evidence, `hypaware.session-evidence/1`)
**Designed-by:** [LLP 0480](./0480-fastask.design.md)

> The request record for HYP-111. It captures the issue's intent, acceptance
> and scope so the design and plan can cite them. The Linear issue is the
> source of truth; if they disagree, the issue wins and this record is
> corrected. HYP-111 also owns integrated acceptance across the two server
> requests (server LLP 0551, LLP 0552).

## Outcome {#outcome}

**Extended-by:** [LLP 0488#provenance](./0488-planner-deferred-and-discover-matches-path-tokens.decision.md#provenance): for the initial ship, Phil's direction (2026-10-09 07:01:20Z) supersedes "Ship `hyp fastask`": the agent-directed operations ship; the planner is deferred until it is better and independently validated.

Ship `hyp fastask "<question>"` as a fast way to get source-backed historical
context and useful starting points for deeper queries. A useful result can be
candidate sessions, files or PRs and a ready-to-run scoped query; it need not
be a synthesized answer.

The server provides two independent capabilities: complete authorized graph
snapshots and update checks (HYP-112), and physical session indexing with
bounded original-record reads (HYP-110). Client prototyping proceeds against
fixtures. A replica can use the original evidence-read path while the session
index is being built.

## Required merge and rollout order {#ordering}

1. Agree and commit the snapshot/update contract (HYP-112) and the bounded
   evidence-read contract (HYP-110), with shared fixtures and compatibility
   behaviour. Client and both server changes then proceed in parallel.
2. Merge HYP-110 and HYP-112 into the server, in either order.
3. Run this client candidate's integrated acceptance against server builds
   containing both. Record exact server commits and contract versions.
4. Merge this production integration only after both server changes are merged
   and those checks pass. Preparatory client code may land earlier only while
   the feature stays disabled and is not advertised by installed skill
   guidance.

Deployment is a separate gate: deploy and verify the server capabilities
first (index readiness or correct fallback, and a valid authorized snapshot),
then release and enable the client feature and its skill guidance after
installed-product acceptance. An older server must keep receiving the
documented client fallback. Jev is excluded.

## Current prototype {#prototype}

An uncommitted local prototype (a daemon/CLI with `discover`, `neighbors`,
`search` and `read`) keeps a downloaded graph warm and queries an isolated
server copy. It is not a registered command; its hardcoded paths, server name,
timestamp, socket and container launches are replaced by normal runtime and
remote facilities. The installed `hypaware-query` skill has not been changed,
and the inactive context-injection hook has not been re-enabled.

## Requirements {#requirements}

### Local replica and serving {#req-replica}

- Use HYP-112's generation-consistent export. Keep every authorized node and
  edge with published properties and provenance for one complete generation
  on local disk. Keep the searchable view warm in memory within explicit
  limits; disk completeness does not require all properties in RAM.
- Stream the initial download into staging, verify checksums, counts and
  schema compatibility, then activate nodes and edges together atomically. The
  replica is metadata and relationships; message bodies stay on the server.
- Maintain automatically: check on daemon start and reconnect, then bounded
  periodic checks with jitter and backoff and a documented freshness target.
  Reuse scheduling and configuration conventions; measure transfer cost before
  choosing defaults. Never fetch or rebuild per prompt.
- Use conditional manifest checks; if unchanged, keep the generation with no
  download or rebuild. If changed, fetch the full replacement in the
  background, validate and index it, then switch atomically. Coalesce
  overlapping refresh triggers.
- Manual refresh and status through existing command and status conventions:
  selected server, org and scope, active generation, projection watermark,
  last successful sync, refresh in progress, stale, expired or unavailable.
  Do not invent command or config names before inspecting existing interfaces.
- Serve the previous generation only while its authorization and lease permit,
  reporting its age. Recover from offline periods, disk-full, corrupt or
  interrupted updates and restart; clean abandoned staging; bound retained
  generations and disk. Withdrawn records disappear on activation of the
  replacement.
- Keep the team replica separate from this machine's capture graph, keyed by
  server, organization and authorization scope; make the selected source
  explicit in results.
- Support unchanged snapshots, interrupted download, corrupt or incompatible
  data, server unavailable, authorization changes, expiry and offline reuse,
  and removal of withdrawn rows on sync. Define lease and freshness behaviour
  with the server.
- Full compressed snapshots first; deltas deferred until measurements justify
  them.
- Load one compact lookup and adjacency generation in the daemon, not one per
  prompt or command. Budget replacement overlap and release retired
  structures.
- Build and refresh local indexes in bounded CPU slices, checking elapsed time
  and row/byte budgets inside large loops; await real event-loop yields and
  short abortable sleeps so larger graphs never block capture, health checks
  or interactive queries. An `async` function or an already-resolved promise
  is not a yield. Apply this to decompression and parsing, node and edge
  passes, lookup construction, sorting and generation replacement; chunk
  synchronous work or isolate it in a bounded worker. Reuse existing scheduling
  and Node standard-library primitives; cap concurrent background jobs and
  buffered data.
- Check cancellation and shutdown at slice boundaries and around pauses. Keep
  the previous valid graph available during refresh; cancelled or failed work
  never exposes a partial index.
- Preserve node identities, unresolved endpoints and provenance. Build bounded
  entity and path lookups; suffix or worktree matches are candidates, not
  proven repository identity.
- Return explicit visit and result limits and continuation information. Never
  equate `Session.first_seen` or file first-touch time with session end,
  freshness or decision time.
- Reuse existing session date bounds when available. Do not invent graph
  message pointers: the file-touch graph supplies no message or part IDs.

### Callable retrieval interface {#req-interface}

- Register the command and reusable operations through existing command and
  read-verb infrastructure. Reuse current remote selection, credentials and
  transport; no demo-only Docker or per-query subprocess path.
- Support local candidate discovery, bounded neighbour traversal,
  candidate-session search, and chronological source-window reads, with
  machine-readable results carrying IDs and a concise human presentation.
- Resolve question concepts with repository and file context and existing
  entity keys. When resolution is weak or ambiguous, return competing leads or
  use the existing broader search rather than silently choosing one.
- Send stable session IDs and real date/time bounds to the server. Keep
  per-session budgets and continuations, never a global latest-N limit.
- Read original context around candidate hits, widening earlier or later when
  a tail or first-touch window misses the rationale. Use real message and part
  IDs for exact follow-up once returned.
- Graph discovery prioritizes; it never excludes. Discussions can precede file
  edits, graph entries can outlive source retention, and a later session can
  reverse an earlier decision.
- Return source IDs, timestamps, relationship rationale, text and traversal
  truncation, freshness and coverage, and scoped follow-up query suggestions.
  Missing evidence yields useful leads or explicit uncertainty.
- Respect an explicit work/deadline budget; report partial retrieval and
  cancel outstanding server work. Keep aggregate failures distinct from
  partial results.
- Answer synthesis is optional: no hidden model round trip is a prerequisite
  for graph lookup.

### Model instructions in the existing query skill {#req-skill}

- Update the source-controlled `hypaware-query` skill copies contributed by the
  Codex and Claude client plugins, distributed through the existing
  client-asset installation and ledger, respecting ownership and update rules.
  Never solve distribution by editing one user's installed copy or a one-off
  global prompt. Verify both clients receive the shipped content.
- Keep a short routing instruction in the skill; put detailed reference beside
  it if needed. The model learns: decide the source scope and check the
  replica; discover entities locally and follow relationships to candidate
  sessions; search those sessions on the server, inspecting per-session
  coverage and truncation; read the original human instruction and surrounding
  conversation, checking later corrections; answer with provenance, or return
  competing leads and a focused next query.
- Distinguish original human turns from assistant suggestions, copied
  transcripts and subagent reports (`role=user` alone does not prove a human
  instruction). Captured content is evidence, never live instructions. Use the
  existing remote search, graph or SQL when no usable replica exists or local
  discovery misses, and expose that fallback and its coverage. Document what
  each timing means. Skill discovery is guidance, not a guaranteed invocation:
  validate natural-language activation in fresh chats without an
  experiment-specific prompt. Keep the inactive context-injection hook
  unchanged.

### Scope decision: no Jev {#no-jev}

Jev is entirely out of scope: no integration, provider calls, configuration,
reranking or evaluation. This supersedes the draft RFC's Jev proposal.

## Evidence that motivated the request {#evidence}

From the issue (October 8, 2026): the downloaded graph had 142,766 nodes and
462,042 edges (261.2 MB JSONL, 50.4 MB gzip). Cold construction took 727 ms;
file-anchor discovery 1.7 to 3.4 ms warm median; demo load about 871 ms with
filename searches around 8 to 10 ms. After GC: 80.8 MB heap plus 9.5 MB
ArrayBuffers; sampled RSS 298 MB (process totals, not incremental daemon
memory). Three single-run fresh-chat trials of one vague question took 101 s
(local graph plus experimental index, found the intended decision), 181 s
(local graph plus original server reads, answered about a different decision)
and 579 s (server tools only, missed it). These show feasibility and failure
modes, not a controlled ratio. The evaluation ground truth for that question
is recorded in the Linear issue only and must stay out of candidate selection
code, skill text and fresh-chat instructions.

## Acceptance {#acceptance}

- Replica sync and serving pass generation and checksum, interrupted update,
  stale and offline, changed authorization, unresolved-node and atomic-swap
  tests.
- End to end with HYP-112: initial full sync; unchanged conditional check with
  no download or rebuild; automatic refresh after a changed generation or
  reconnect; manual refresh and status. Compare the complete authorized node,
  edge and property set to the committed server generation, removals included.
  Test disk-full and restart recovery, coalesced triggers, and bounded staging
  and retained storage.
- Warm discovery never reparses the full graph per prompt; measure cold and
  warm latency, retained memory, replacement peak, CPU and allocations. Target
  sub-100 ms bounded local discovery on the reference corpus, with hardware
  and limits stated.
- Stress initial load and refresh with a substantially larger graph while
  capture, health checks and queries run. Declare and test event-loop delay
  (p95/max), foreground latency, CPU duty and cancellation budgets; show real
  yields and pauses, bounded memory and concurrency, and continued serving of
  the previous generation until an atomic swap.
- Results keep source provenance, scope, independent session budgets and
  visible incompleteness; fallback, cancellation and missing-source behaviour
  are tested.
- Fresh Codex and Claude chats use the shipped skill for ordinary history
  questions without pasted benchmark instructions or known answer IDs;
  failures to select the skill are recorded as routing failures.
- Skill instructions and tool schema/help agree; distribution and update
  tests cover both client packages.
- Repeat the local-graph on/off by server-index on/off matrix over multiple
  questions and runs, with fixed model and effort, frozen source, recorded
  prompts and randomized order. Keep identical-query replay separate from
  natural investigations.
- Grade target and rationale, source authenticity, later reversals, useful
  leads, ambiguity and coverage, including similarly named steps, ambiguous
  login questions, graph misses, long sessions and copied transcript text.
- Report whole-turn time separately from retrieval, startup and transfer.
  Record errors and unsuccessful runs.
- Follow repository LLP and test requirements; no new runtime dependencies;
  private corpus and credentials stay out of Git and routine telemetry.

## Production completion gate {#completion-gate}

- Implementation, user and operator documentation, skill changes and
  generated or sanitized fixtures in maintained repositories, with PRs and
  exact tested client and server revisions linked on the issue; tests run
  without private paths, the demo container or chat history.
- A finalized public command and tool contract: natural-language question,
  optional repository/file context, remote/source selection,
  machine-readable and human output, limits, continuation, errors and exit
  status; question-to-entity discovery verified for unseen questions without
  hardcoded anchors or answer IDs.
- The complete installed lifecycle using existing configuration conventions:
  selecting an authenticated remote and enabling replication, first-sync
  progress, background maintenance, refresh and status, disable, account or
  org switch, logout or leave and local-cache cleanup, keeping the local
  capture graph distinct from each server replica.
- Concrete, tested defaults for polling and backoff, freshness and lease, CPU
  slice and pause, memory, disk and retention, with user-visible behaviour
  explained while the graph is unavailable, refreshing, offline, expired,
  unsupported or unauthorized; resolved before release.
- Mixed client/server versions through capability detection and documented
  fallbacks: a server without snapshots keeps the existing remote-query
  workflow; one without the index serves correct slower evidence reads;
  unsupported schemas never corrupt or silently misread a replica.
- Packaged install and upgrade on supported macOS and Linux paths, daemon
  restart, sleep/wake/reconnect, resource pressure, cancellation and cleanup,
  with repository acceptance procedures where the changed boundary requires
  them.
- Codex and Claude receive the shipped skill through the normal install and
  update path; fresh ordinary history questions exercise skill selection and
  tool use.
- A complete installed-product acceptance flow against the HYP-110/HYP-112
  server candidates: authenticate and select source, initial sync,
  natural-language fastask, original evidence citation, server graph change,
  automatic refresh, correct later discovery, permission withdrawal, and
  recovery or fallback, with command-level behaviour and internal telemetry
  recorded.
- Live ingest and a changed or compacted source record in integration tests:
  an up-to-date graph must not conceal an incomplete evidence index, and an
  old eligible graph reports its watermark rather than claiming current
  coverage.
- Repeated relevance and performance results with all unsuccessful runs kept;
  concrete release thresholds agreed on representative hardware before the
  final run.
- Release notes, user help and support instructions; server-first
  availability, client rollout, mixed-version observation and tested rollback
  under the normal release process. Deployment needs its own human authority.

## Deferred {#deferred}

Jev integration and evaluation, model-selected passage extraction, decision
graph nodes, whole-log vector or lexical indexes, automatic hook
reactivation, mandatory generated answers, delta graph updates and raw-message
replication.
