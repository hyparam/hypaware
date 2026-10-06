# LLP 0470: Implement direct Ollama API capture

**Type:** plan
**Status:** Active
**Systems:** Gateway, Plugins, Sources, Query
**Author:** Neutral Next designer
**Date:** 2026-10-05
**Related:** LLP 0468, LLP 0469, LLP 0016, LLP 0035, LLP 0038, LLP 0204

@ref LLP 0469#seams: use the existing gateway capability and a narrowly scoped adapter
@ref LLP 0468#acceptance: delivery requires current-commit independent and live evidence

## Change set {#change-set}

Slug: `ollama-direct-capture`; integration: `integration/ollama-direct-capture`.
Product base: `95ae33ee5d894feed272ea5f1fece33ed5b0392e`. Integrate the
request/design/plan first, retaining their commits. There are no external
change-set dependencies, so no Depends-on header is needed. The only task
dependency is T2 on T1. Neither task includes synthetic readiness files.

The owner assigns unique native seats/worktrees from the exact integration or
dependency commit, records cwd/branch/base in queues and integrates serially
with verified `--no-ff` merges. Do not redirect another seat's checkout. Preserve
task refs and clean review checkouts. Use the existing Neutral LLP/ready observers,
never its dispatcher. Owner advances routine stages; no human LLP-approval gate.

## Tasks

- id: T1  branch: codex/ollama-direct-capture/T1  deps: []  complexity: 2  -- Exchange-scoped gateway state with compatibility and retention tests
- id: T2  branch: codex/ollama-direct-capture/T2  deps: [T1]  complexity: 3  -- Ollama adapter, capture proof and reversible user documentation

## T1: Generic exchange-scoped projection {#t1}

Implement LLP 0469's nonempty exchange-ID equality/no-thread predicate in
`ai-gateway/src/message_projector.js`. The true branch uses temporary conversation
state, bypasses all committed seeding and leaves listener-lifetime identity/maps
untouched. The ordinary branch stays intact. Document the rule on the existing
`AiGatewayProjectedExchange.session_id` contract in
`hypaware-plugin-kernel-types.d.ts`, without a new field. Attach the directly
applicable `@ref` above the branch/predicate. Read touched refs before changing.

@ref LLP 0469#exchange-scope: exchange snapshots must not accumulate history or seed entries with uptime

Extend existing gateway message-projector/source test homes as appropriate.
Demonstrate the old path's retention/seed issue before fixing. Meaningful proof:

- Many unique exchange-scoped inputs cause zero committed-storage discovery or
  seed reads and no retained shared session state. Include success and failed
  append/journal lifetimes. Verify the actual state boundary, not just row count;
  use an existing seam or bounded observation rather than a new runtime debug API.
- Explicit message IDs and links retain identical text at two snapshot positions
  and identical distinct requests; links stay inside each exchange.
- Empty/missing input ID, unequal session, or any supplied thread use the normal
  path. Canonical and fallback identities keep ordinary same-session replay dedup,
  concurrent first-session seed memoization and append-failure rollback/retry.
- Representative Claude/Codex/OpenClaw fallback projections do not select the
  transient branch. Projected-writer/backfill behavior remains unchanged.

Run focused tests plus existing source, message-projector, retention and
exchange-writer tests. T1 is independently integrable: it defines a generic
contract without activating a new source or provider. Do not build an LRU or
repair all older long-lived-session state as adjacent work.

## T2: Adapter, smoke and documents {#t2}

Build on the integrated T1 commit. Keep implementation choices flexible within
LLP 0469's admission/completion, identity and resource contract. Reuse
`hypaware/core/util`, existing row expansion and manifest conventions; no new
runtime dependencies. Add the small adapter in
`hypaware-core/plugins-workspace/ollama/`, with minimal activation/projector
modules and only necessary declarations. Register its existing gateway capability
requirement, distinct upstream, narrow projector and explicit discovery through
`src/core/runtime/bundled.js`'s exclusion set. No pretend client/picker/config.

@ref LLP 0469#wire: capture supported text only after valid terminal completion
@ref LLP 0469#usage-privacy: preserve observed counters, unknown context and one response usage carrier
@ref LLP 0469#resources-journey: run bounded split-daemon capture and document its exact inverse

Traditional tests cover activation/manifest/config discovery, exact route and
projector matching, coexistence with Claude/Codex/OpenClaw, JSON and arbitrarily
chunked NDJSON reconstruction, CRLF/terminal newline/no-final-newline,
content-bearing terminal, real done_reason, model fallback/conflict and empty
text response. Preserve empty system/user/assistant context positions with explicit
text blocks, never bare empty strings, and verify their rows/indexes/links.
Cover identical context positions/requests and ordered IDs/links;
historical assistant context must have no usage. Counters cover nonzero cache,
zero, absence, invalid/noninteger/negative/inconsistent counts and exactly one
carrier. Show output rows, not just private helper results.

Failure tests cover upstream refusal/non-2xx, transport/client abort, missing or
malformed terminal, trailing/error records, UTF-8 chunk boundaries and truncated
terminal records, unsupported
tools/images/thinking/content and defensive byte ceiling. Verify no successful
message rows and the secret-safe structured reason; do not log raw payloads.
Forwarded bytes/status must remain faithful when capture is dropped. Exercise
the existing session-ignore sentinel and append-failure telemetry.

Add `gateway_ollama_capture` to the existing hermetic smoke system, using a local
fake Ollama upstream and the real split-daemon boot path (`runGatewayDaemon` or
the foreground CLI). Override only the named Ollama upstream, never egress to
the owner's service. Use stable DEV_RUN_ID, smoke_name and smoke_step. Assert
JSON and streaming forwarding, rows/model/one-carrier counts, interruption and
unsupported-shape diagnostics, retained data across collector restart and direct
fake-upstream use after collector stop. Test the actual transport route and
capture abandonment; reuse process-transport tests for queue/slot/timeout/outage
coverage rather than copy a separate transport implementation. The smoke must
assert internal telemetry and user-visible behavior. It is fixture proof only.
Set `HYP_DEV_TELEMETRY=1` in the foreground environment and assert adapter
drop/invalid-usage/write reasons in the existing
`<HYP_HOME>/hypaware/dev-telemetry/logs-<pid>.jsonl` channel. Do not infer these
reasons from daemon.log or default status. Existing transport-drop events and
counts are a separate gateway channel. Carry this exact diagnostic recipe into
user docs and live failure proof, including the default-telemetry limitation.

Document the exact disposable no-sink configuration and foreground commands in
docs/CLIENTS.md, add a narrow README link and the `ollama_direct_capture` manual
procedure in docs/ACCEPTANCE.md. Keep documentation with this behavior task and
consult the documentarian/guardian against the resulting commands. Qualify the
existing blanket raw-proxy/client-integration sentence narrowly. Reference other
docs only for surfaces actually exposed. Include scope, request snapshots,
nullable raw/normalized usage, cwd/privacy/export limits, readiness, occupied
port handling, logs, loss limits, restart and selecting the direct URL before
stopping only the collector. Do not describe attach/history/CLI capture.

## Integration checks and owners {#verification}

Workers record exact commit, commands/results, CPU/memory assessment and native
handoff in mission evidence. Original implementers own review fixes. The owner
reproduces applicable checks at each resulting integration SHA:

```sh
npm test
npm run typecheck
npm pack --dry-run
npm run smoke -- gateway_ollama_capture
npm run smoke -- gateway_codex_capture
npm run smoke -- gateway_claude_capture
npm run smoke -- daemon_foreground_start_stop
npm run smoke -- gateway_process_isolation
```

Run reference/number checks using the existing repository gates. Add other
regression smokes only if changed paths or failures justify them. Codex supplied
the existing pinned dependencies offline in a pilot-owned location during design;
mission dependency-provisioning-result.json records provenance. Verify resolution
from every actual worker/reviewer cwd before checks. Design-checkout resolution
uses .runtime/pilot-dependencies/node_modules through .runtime/worktrees/node_modules.
Do not install externally or change permissions from this plan.

Review CPU/memory explicitly: no history scans or persistent growth for the new
exchange lane, parse once/join once, raw transport limits preserved, allocations
linear in admitted body/row count, no synchronous body/storage work in forwarder.
Decoded processor copies exceed raw-byte limits; no absolute RSS guarantee.

After both task merges, the owner assigns an independent Astra reviewer a clean
checkout at the immutable candidate, target/base, LLPs and evidence. Review the
whole feature and affected interactions; fixes/re-review follow FLOW.md's
bounded rounds. Queue closure and green fixture tests do not establish acceptance.

## Real acceptance and recovery {#live}

The delivery owner, with guardian/documentarian journey verification, runs
docs/ACCEPTANCE.md's new procedure at the independently reviewed candidate.
Use the existing local Ollama service and gemma3:4b or qwen3:4b for small synthetic
conversations. Never download a model, use the cloud stub or stop/reconfigure the
owner service. Use a nonconflicting pilot gateway port and disposable state.

Record wire content/model/counters against queried ordered request snapshots and
the current-response carrier, JSON plus NDJSON, nonzero cached counts when
observed, and honest missing values. Exercise a multi-turn request with prior
assistant context and a repeated identical real request. Record unavailable
upstream via a pilot refused endpoint and interruption via a pilot client abort;
verify no failed exchange rows and actual diagnostics. Compare saved IDs/counts
before/after collector restart, including waiting-spool retention where exercised;
restart itself must not add duplicates. Restore the direct URL, stop only the
pilot collector and prove a fresh direct response. Retained rows stay queryable.

Persist commands/results, current SHA, limitations and remaining obligations in
native mission evidence. No raw replay/import has been built, so do not claim
outage recovery from local transcript history. No durable format changes are
planned; if implementation changes one, escalate that design change and the
durable-cache-upgrade gate before accepting it.

The owner coordinates the controlled native seat restart through mayor/Codex
after design integration and before task dispatch, as proposed in room
01M47X5F8JTK48YGG995XZJW6K. Persist continuation and assignment/branch/evidence
state first; Codex verifies exact Git-directory permissions and performs restart.
Re-observe identity, native mission/queue and Git before resuming. This is mission
continuity proof, separate from collector restart. Keep the parent delivery
obligation open through actual acceptance. No production merge/push/deploy or
worktree cleanup is authorized by this plan.
