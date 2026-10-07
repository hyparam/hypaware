# LLP 0472: Implement bounded sink instances

**Type:** plan
**Status:** Active
**Systems:** Sinks, Daemon, Plugins
**Author:** HypForge steward
**Date:** 2026-10-07
**Related:** LLP 0471

@ref LLP 0471: implement the settled issue2226 repair through bounded independently verifiable tasks

## Tasks

- id: T1  branch: codex/sink-instance-bound-2226/T1  deps: []    -- driver instance ownership and awaited manual admission
- id: T2  branch: codex/sink-instance-bound-2226/T2  deps: []    -- central transport lifetime and shared authentication cancellation
- id: T3  branch: codex/sink-instance-bound-2226/T3  deps: [T1, T2]    -- daemon independent work, completion and abort-before-await shutdown
- id: T4  branch: codex/sink-instance-bound-2226/T4  deps: [T3]    -- bounded diagnostic retention and truthful status evidence

## Ownership and execution {#execution}

Parent `nn-maint-sink-tick-overlap-20261007`, issue #2226, owner HypForge steward.
Admission 2127 reserves one maintenance slot; disposition 2150 admits this design
and plan stage. Authoring branch `codex/sink-instance-bound-2226` starts at
`e6784482e04ce77eb2e15ed11a29f29d638f8903`. Design and plan passed the
orchestrator's actionability/overlap readback before repair. Immediate task
advancement follows the same parent's disposition; publication remains held. Existing PR #1034 is deferred with its history
preserved. OTLP and git diagnostics remain unreserved second/third priorities.

Design/plan share slug `sink-instance-bound-2226`. After stage disposition, use
`integration/sink-instance-bound-2226` and the task refs above under FLOW, recording
actual owner seat, checkout, branch and dependency/base commit before each task.
These are proposed task identities, not dispatches or reserved additional slots.
The steward can execute them serially; T1/T2 are logically independent, not an
instruction to recruit parallel workers. Integrate verified task commits with
`--no-ff`; preserve task refs and revalidate the resulting integration SHA.

Before implementation, re-read current HEAD, active writers and inherited holds.
T3 consumes integrated T1 and T2. T4 follows T3 because both touch driver completion
and status semantics. No task can substitute a global runTick guard. Keep internal
driver/registry seams separate from the unchanged public plugin Sink contract.

## T1: driver ownership and manual receipts {#t1}

@ref LLP 0471#instance-ownership [implements]: acquire before async discovery and retain one coalesced rerun
@ref LLP 0471#manual-work [implements]: a manual receipt owns the sole pending opportunity and fresh awaited progress

Files: `src/core/sinks/driver.js`, internal sink types and only required registry
metadata/lifecycle seams; existing root driver tests plus focused regressions.

1. Add private handle-keyed execution state shared by drivers using that registry
   handle. Add synchronous scheduled dispatch and stop/drain/completion seams.
   Preserve awaited sequential manual `tick`, force/filter, hold and existing
   export-result validation. Acquire before hold/discovery; retain only one active
   operation and one pending bit.
2. Upgrade a pending scheduled opportunity to one explicit manual receipt. Refuse
   later manual contention promptly using an existing failed result and bounded
   busy reason. Keep refusal/held/queued outcomes out of export diagnostics and
   success/failure counters/transitions. Clear pending receipts on stop.
3. Consume reruns with fresh time, policy and discovery, with no stale callback
   or inventory. Close/replacement invalidates old work. Observe every spawned
   operation rejection and release state on every settled path.

Proof: regression fails on base with hundreds of timer fires while blocked and
passes with maximum active one plus only one follow-up; other handles start
independently. Check two drivers sharing a handle, force/filter, fresh cron/hold
and fresh cache discovery, failure then later acquisition, and stopped replacement.
Block a daemon run, admit manual, fire many timers and a second manual request:
only the admitted manual rerun starts, it owns fresh progress and its own awaited
result, and refusal adds no outbox record/counter/transition. Stop settles its
receipt without rerun. Verify two selected manual destinations remain sequential.

Deliverable: task commit and recorded commands/results, including per-fire
allocation/state inspection. T1 is not daemon acceptance; T3 wires the host.

## T2: central lifetime and shared auth {#t2}

@ref LLP 0471#chunk-lifetime [implements]: abort actual owned transport and release failed chunk frames before the next await
@ref LLP 0471#shared-auth [implements]: cancellable leases preserve shared refresh ownership without orphaned work
@ref LLP 0471#watermarks [constrained-by]: stable ids and end-of-partition acknowledgement survive cancellation

Files: central `src/sink.js`, `src/identity_client.js`, required `src/config_client.js`
auth call sites, `src/backoff.js` and `index.js`; existing central root tests.
Reuse existing capped body/cancellation helpers in a narrow shared home if needed.

1. Give each logical chunk a 330-second elapsed budget and actual abort signal
   through authentication, upload/fetch, capped response reading and retry sleeps.
   Keep ids/content constant across retries and fresh budgets across chunks.
   Bound registration transport before chunk retention. Consume/cancel responses
   and clear all timers/listeners on every outcome. Validate response cap against
   existing central fixtures before selection; do not change accepted OTLP bodies.
2. Implement one refresh owner with removable caller leases, one owned controller
   and deadline. Thread export/config poll signals; last-consumer cancellation
   aborts and waits for resource settlement, another consumer preserves ownership.
   Already aborted callers start nothing; an aborting resource refuses replacement
   until settled. Keep cached JWT/persistence semantics and existing poll budgets.
3. Flush releases lines/body/bytes in a settlement-aware finally boundary on both
   paths. A per-partition helper converts errors into bounded safe scalar outcomes
   before another partition await, retaining truthful partial acknowledgement.
4. Initiate central abort before waiting for config-pull stop. Preserve existing
   per-partition serialization, dataset registration, stable chunk id calculation,
   unordered sequence handling and whole-partition watermark commit.

Proof: real synthetic loopback tests for stalled headers, upload and response
body; repeated 429/503, stalled lazy JWT, 401 refresh and close during retry sleep.
Use controlled clocks/timers for the exact elapsed ceiling; use actual transport
abort/settlement for cancellation proof. Assert no renewed budget on retry, later
successful acquisition, no listener/timer residue, one auth request for two live
callers, one-caller and last-caller cancellation, and cancelled identity publication.
Test config pull/export shared auth cancellation in both orders. A mocked fetch
that ignores abort is a limitation/negative control, not cancellation acceptance.

Run repeated large synthetic partition failures under a small heap, with direct
WeakRef/heap retainer evidence for original Error and chunk lines/body/encoded bytes
while the following partition waits. Compare bounded active work and heap plateau
over outage duration, not only call counts. Verify stable retry ids/bytes, partial
progress and unordered acknowledged/unacknowledged watermark behavior. No real
server refusal, installed enrollment or user recording.

Deliverable: task commit, real transport artifacts and retention evidence. The
outside-product auth lease prototype establishes feasibility only; these tests
must run actual candidate IdentityClient/sink code.

## T3: daemon completion and shutdown {#t3}

@ref LLP 0471#daemon-work [implements]: exports no longer gate health bookkeeping and success uses actual completion
@ref LLP 0471#close-order [implements]: signal every owned sink before awaiting unrelated shutdown work

Depends on integrated T1/T2. Files: `src/core/daemon/runtime.js`, required
`src/core/registry/sinks.js` close ordering and internal types, existing daemon tests.

1. Replace the interval's awaited all-sink chain with synchronous sink dispatch
   and separately gated existing bookkeeping. Retain one active bookkeeping pass
   plus one coalesced request, existing sweep/provider guard and probe deadlines.
   Audit config/self-update/network awaits: heartbeat cannot acquire an unbounded
   export dependency or another per-fire backlog.
2. Consume bounded per-instance completion directly, stamp full success after
   durable completion, and emit ordinary-install bounded secret-safe failure and
   recovery transitions. Do not stamp queued/held/refused/partial work as success.
3. Stop dispatch/reruns and pending manual receipts, initiate every sink close
   before awaiting maintenance/reconciliation/source work, then drain owned work
   and finish existing cleanup. Scope closes by registry owner, observe failures
   and preserve replacement-handle isolation.

Proof: actual disposable runtime with central blocked plus a local destination,
backfill sweep and source probes. Assert local export, sweeps and advancing
status-file heartbeat before central settles, bounded active bookkeeping and no
per-fire report/completion queue. Verify ordinary logger failure/recovery with
acknowledgement then durable completion stamps; failure written after start must
clear only on successful completion, not stale start. Test partial, equal, invalid,
future stamps and restart recovery. Stop while blocked must abort all central
resources before earlier maintenance/close waits; no rerun or normal-success claim.
Test generic uncooperative plugin limitation honestly and cooperative close proof.

Deliverable: integrated task commit, daemon lifecycle regression and disposable
running-app evidence. Installation/service behavior remains a separate release gate.

## T4: diagnostic cap and warning truth {#t4}

@ref LLP 0471#diagnostic-history [implements]: cap owned diagnostics safely without acknowledging payload or clearing warnings

Depends on T3. Files: driver outbox persistence, `src/core/daemon/status.js`, the
required existing `src/core/daemon/runtime.js` maintenance hook and existing
status/driver tests; related explanatory refs only. No cache migration.

1. Verify the current active-code outbox consumers again. Atomically write the
   existing record format, then retain the protected new record plus newest
   recognized history up to 100. Preserve unrelated names/symlinks/instances.
2. Stream initial historical selection/deletion with bounded names and batches.
   Reuse existing maintenance cadence for failed-cleanup retries; prevent full
   historical scans per failure/partition. Keep export and cleanup reasons distinct.
   If cache maintenance is disabled, do not add a replacement timer: retain the
   cleanup limitation and retry on the next explicit maintenance/restart attempt.
3. Update count wording as retained history/floor and preserve configured-instance
   unresolved warning semantics. Compare success to existing `recordedAt` read
   from a bounded metadata prefix, with legacy filename fallback, never whole
   partition inventories. Stream status entries during pending historical cleanup.
   No new status schema or assumption that pruning acknowledges rows.

Proof: more than 100 failures, large pre-existing directory, fresh write failure,
prune failure and retry, unknown files/symlinks, other instance, timestamp ties,
legacy/malformed metadata and restart. Include a success after failed batch start
but before its `recordedAt`: that failure must remain unresolved. Assert newest
unresolved failure survives cap and 24-hour aging; later
same-instance full success clears only actionable warning, retained count stays
nonzero. Assert cache, watermark, ingest ids and telemetry outbox unchanged.
Record initial cleanup work/memory and subsequent bounded scans; state explicitly
that filesystem failure may temporarily prevent the cap.

Deliverable: task commit and evidence of warning/cursor safety and bounded cleanup.

## Integration and acceptance {#acceptance}

Run relevant existing tests and each task's failing-before/passing-after regressions
once at its integrated SHA, then `npm test` and `npm run typecheck` if declared.
Validate fresh cross-branch LLP numbers and changed refs. Existing targeted baseline:
spool discovery, hostile sink results/identity, daemon sweep wiring and central
chunking, 90 passes at the base. A baseline pass is not repaired behavior.

Run the existing hermetic `daemon_foreground_start_stop`, `local_parquet_export`
and `status_diagnostics` flows when their wiring applies, retaining run-specific
logs/spans/metrics and user-visible outcomes. Add focused behavior to existing
harnesses rather than a new scheduler/test framework. Keep hermetic and running
daemon evidence distinct; no installed daemon release claim from fixtures.

The guardian's same-parent acceptance journeys are mandatory:

| Journey | Required proof |
| --- | --- |
| Two-destination manual sync | sequential awaited progress, only acknowledged rows, final durable result, preserved partial exit behavior |
| Same-process contention | one manual receipt shares timer latch, fresh forced run, prompt busy refusal with no export-failure signals, stop settles pending |
| Blocked central | local export, sweep and source/heartbeat progress before central settles, bounded retained state |
| Failure/partial then recovery | completion-based own-instance success strictly after failure, queued/partial/other-instance work cannot clear warning, restart preservation |
| More than 100 failures | finite owned retained history, newest unresolved warning past 24h, cleanup separate, no payload/cursor acknowledgement |
| Cancellation and stop | real fetch/body/auth/wait settlement, buffers/Errors released, all aborts initiated before waits, no rerun after stop |

Arrange independent Astra review of the exact integrated immutable candidate SHA
against the recorded base in a clean separate checkout. It reproduces meaningful
checks and explicitly reviews CPU/memory, shared authentication, close ordering,
watermarks, manual progress and status interactions. Record findings and dispositions
under the same parent; implementing owner fixes them and reviews the new SHA under
FLOW's bounded review path. Acceptance requires the candidate's actual running-app
evidence and supported findings dispositions. Queue closure, doc status and green
unrelated tests do not establish product acceptance or landing authority.

## Checkpoint and limits {#checkpoint}

The documentation checkpoint was due 2026-10-07T22:19:49Z: committed doc SHA/base,
affected clauses/forward refs, parsed tasks/dependencies, concrete test matrix,
guardian journeys, cancellation feasibility and current effort/impact on this same
parent. It was returned to the orchestrator before product repair. These documents express
settled issue intent; no choice-only RFC or fresh human approval is requested.

Remaining delivery estimate is 6-10 focused hours, accepted as planning uncertainty,
not a promised finish. Auth integration, retainer proof and cleanup/shutdown are
the principal uncertainties. Other three slots remain available; the first Ready
Linear trial retains priority. No known feature delay or public contract replacement
is required by this plan. Escalate through the mayor before expanding into a major
refactor, changing product intent or materially delaying that trial. Do not borrow
this slot for the unreserved OTLP/git candidates or rereview historical PRs.
