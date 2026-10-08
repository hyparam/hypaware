# LLP 0475: Implement everyday installed Ollama collection

**Type:** plan
**Status:** Active
**Systems:** Onboarding, CLI, Config, Gateway, Plugins, Sources, Observability
**Author:** HypForge designer
**Date:** 2026-10-07
**Depends-on:** sink-instance-bound-2226
**Related:** LLP 0473, LLP 0474, LLP 0472, LLP 0466, LLP 0430
**Extends:** LLP 0470 (everyday installed journey and running-client recording proof)
**Extended-by:** LLP 0476 (#t4: bounded settlement ownership, sequencing and proof)

@ref LLP 0473#requirements: deliver the installed discovery-to-persistence and reversible recording journey
@ref LLP 0474: implement scoped native routing, bounded default evidence and a processor-confirmed stop

## Change set and execution {#execution}

Slug `ollama-everyday-collection`; integration branch
`integration/ollama-everyday-collection`. Authoring branch
`codex/ollama-everyday-collection-design` starts at
`9e53cf4c096de091b4ff700dc2ce2c384fcf0849`. Request commit `784a88e5`
and design commit `4c67ca96` precede this plan. This is mission HYP.0.71,
source HYP-71, parent `hypforge-linear-b3a15c80-6744-47c1-ae6b-f25d9e93dc6d`,
admission 2293 and design child `hyp071-llp-design-20261007`.
The completed HYP.0.39 pilot remains complete.

Fresh pre-design source verification is `source-check-20261007-design.json`,
22:37:55Z; pre-plan verification is `source-check-20261007-plan.json`,
22:49:47Z. Both retain the immutable issue/workspace, revision
2026-10-07T22:28:19.870Z, full scope, Ready label and current Phil ownership.
Before implementation advancement the owner obtains the next fresh source check.
The owner checks actionability and advances routine stages; there is no human
document-approval gate. This plan creates no native dispatch or extra slot.

Integrate the committed LLPs before task work. The orchestrator records each
actual native seat, owned cwd, task ref, HEAD/base and unexpected dirty work,
then integrates verified task commits serially with `--no-ff`. Use the exact
integrated dependency SHA rather than the designer's working tree. Preserve task
refs and merge evidence. T1/T2 are independent contracts, not a direction to
spawn concurrent writers; activation files may overlap, so serialize if needed.
No implementation touches the designer checkout or authenticated owner install.

`Depends-on` names a real delivery dependency: before T3, consume the verified
integrated sink-instance-bound-2226 T1-T4 candidate and obtain an explicit
steward/orchestrator seam agreement for daemon completion, shutdown and status.
Record that SHA and agreement in the native task. T1/T2 and doc preparation may
proceed before that base, avoiding shared daemon/status files. The observer may
report the whole change set blocked while these disjoint tasks are workable;
native owner disposition governs that staged work. No synthetic readiness refs.
Held inherited PRs stay held and are not task implementations to adopt.

## Tasks

- id: T1  branch: codex/ollama-everyday-collection-tasks/T1  deps: []  -- native chat/generate admission and bounded media-safe snapshots
- id: T2  branch: codex/ollama-everyday-collection-tasks/T2  deps: []  -- picker, repeatable setup and resolved native routing capability
- id: T3  branch: codex/ollama-everyday-collection-tasks/T3  deps: [T1, T2]  -- running-client recording gate, processor barrier and bounded outcomes
- id: T4  branch: codex/ollama-everyday-collection-tasks/T4  deps: [T3]  -- normal status and correlated persisted first-check command
- id: T5  branch: codex/ollama-everyday-collection-tasks/T5  deps: [T4]  -- complete hermetic journey, maintained guidance and installed native-client proof

## T1: native protocol and projection {#t1}

@ref LLP 0474#projection [implements]: preserve supplied text and ordered omission markers without broadening thinking/tools
@ref LLP 0474#resources [constrained-by]: bound expansion and release raw exchange state

Primary homes: `ollama/src/projector.js` in the existing plugin workspace,
required adapter activation registrations and existing gateway message-projector
tests. Keep normal gateway session projection and other providers unchanged.

1. Extend path normalization to the verified native alias and legacy chat route;
   admit chat and generate only at valid complete exchange boundaries. Retain
   snapshot identity, positional links, repeated context and current-response
   single usage carrier. Generate never invents history from context token arrays.
2. Handle known native defaults, `think: false`, stream true/false and actual CLI
   empty controls. Nonempty thinking/tool semantics and unsupported native shapes
   still reject whole capture. Load/unload completion is an intentional control
   outcome, never a conversation or first-check success.
3. Emit supplied text and ordered existing image markers, including media-only
   messages; strip all inline payloads before rows/attributes. Exercise existing
   nested tool-result stripping in its shared supported representation without
   adding native tool support. No media decoding, fetch or guessed metadata.
4. Enforce raw ceilings and the 4096-message/image-marker, 8192-part expansion
   limits before costly row expansion. Keep outcome classification adapter-local
   for T3 to expose, without a new persisted dataset column.

Proof uses the observed CLI0.35.1 and Python SDK0.6.1 serialized shapes from the
mission's probes. Exercise JSON and fragmented NDJSON, UTF-8 boundaries, CRLF,
terminal newline variations, content-bearing terminal, empty valid response,
model conflict/fallback and missing/zero/inconsistent usage. Check actual expanded
rows, indexes, IDs/links, exactly one usage carrier and absent media payloads.
Include mixed text/images, media-only and data-URI text, supported shared
tool-result omission, repeated context, generation with system/prompt/images and
opaque context. Actual thinking, nonempty tools, malformed/trailing/error records,
missing terminal, abort, non-2xx and byte/part ceilings must emit zero rows and an
honest bounded reason while ordinary forwarded bytes/status stay intact.

Run focused adapter/projector/source tests. Repeated exchange-scoped success and
failed-append cases must not grow listener session state, seed storage, retain
large media copies or multiply response concatenation work. T1 is integrable
before activation: existing legacy chat works and other clients remain compatible.

## T2: installed setup and scoped route {#t2}

@ref LLP 0474#setup [implements]: discover without inference and preserve selected custom upstream/off state
@ref LLP 0474#routes [implements]: derive the native door from the resolved canonical route and reject fallback leakage

Homes: existing Ollama manifest/index and small plugin command implementation;
picker composition/configure homes, gateway capability registration/compilation,
proxy route selection and `hypaware-plugin-kernel-types.d.ts`. Avoid shared core
daemon/status files. Reuse config writes, backups, CLI registration and rewrite
helpers; no new runtime dependencies or durable ownership/config keys.

1. Add the visible picker row and declared gateway dependency. Detection using
   existing settings-file parent evidence is a suggestion, never executable or
   service proof. Register the probe-less client; attach receipt prints the live
   process/constructor recipe and accurately says recording was enabled.
2. Implement `hyp ollama setup [--upstream URL] [--json]` and the attended picker
   configure hook. Independently report PATH executable evidence, bounded direct
   version/tags probes and models. Check no inference/pull/service start, retries,
   redirects or scan. Keep valid selected configuration through not-ready states;
   unattended paths do not run the configure hook. Endpoint writes use existing
   validation/backup rules and saved-versus-live reload/restart receipts.
3. Extend only source-authorized selected-Ollama upstream preservation. Assert
   fresh/add/repeat/noninteractive, deselection, custom operator fields, unmanaged
   upstreams, central ownership and explicit recording false. Preserve unrelated
   clients/settings and do not broaden other rows' preset merge policy.
4. Add narrowly typed `registerUpstreamAlias` registration, validation and resolved
   compilation. Reject absent targets, collisions, self references and alias
   chains. Reuse transport and declarative rewrite fields; retain ordinary
   configured/preset ownership. Reserve `/ollama` against unsupported fallback
   before selecting competing catch-alls. Forward exactly the design's heartbeat,
   discovery and chat/generate calls; no metadata/control capture slots.
5. Print gateway host ROOT, native CLI invocation and SDK constructor using the
   actual bound port. Print explicit preserved-direct-root CLI/SDK recovery for
   detach/outage, without changing a shell profile, server or running client.
   No claim that attach already routed a process.

Proof covers method/path allowlist plus negative requests in the presence of a
competing catch-all. Inspect actual outbound pathname AND query for canonical
root, custom host/port/base path, trailing slashes and conflicting routing.
Exercise the actual compiled proxy, not just alias helper output. A malformed or
self-pointing direct endpoint cannot advertise readiness. Probes share the
3-second deadline and retain at most1MiB, display at most20 sanitized models and
truthfully report truncated inventory. Parse real supported CLI noninteractive
forms and verify no prompts or inference. Repeat produces no duplicate plugin,
alias/client/route and never resumes recording false. Run manifest/config/picker,
route-rewrite and attach compatibility tests for other clients.

T2 alone establishes routing/setup feasibility, not the T3 verified stop promise;
the owner does not release incomplete integrated behavior between these tasks.

## T3: recording lifecycle and capture evidence {#t3}

@ref LLP 0474#recording [implements]: invalidate pending generations and drain admitted appends before confirmed detach
@ref LLP 0474#diagnostics [implements]: report finite outcomes and advance persistence only after append resolves

Requires integrated T1/T2 AND the sink-maintenance base/seam agreement above.
Homes: gateway raw admission, source/projector context, existing client command
and fresh recording reader, split gateway/processor control transport and required
daemon lifecycle seams. The sink diagnostic history remains a separate concern.

1. Enforce one Ollama recording gate across native and retained legacy paths.
   Preserve local/central precedence, org refusal before all mutation and explicit
   attach-only resume. Close this gate on unreadable/missing/disabled owner state;
   forwarding still works and other clients' policy is unchanged.
2. Carry a process-local generation through the existing bounded raw handoff.
   Suppress queued/parsing/held exchanges from old generations across reattach;
   admit no new append after off enforcement. Drain already-admitted storage work
   before success acknowledgement. Previously stored rows remain history.
3. Add bounded reserved-control/IPC refresh and processor-confirmed barrier for
   split and in-process hosts. Advertise the actual control host through existing
   source details. Bound one operation per client and10seconds, clear waiters on
   disconnect/shutdown and revalidate concurrent config changes. Proven stopped
   collector needs no barrier; uncertain/live timeout keeps config false, returns
   nonzero and prints unconfirmed-stop recovery, never verified success.
4. Route typed adapter outcomes into maximum32 known route/client source-detail
   entries, finite reason enums and safe capped timestamps/IDs/counters. Coalesce
   normal stderr reason/recovery transitions. No arbitrary-name/URL history or
   per-status scan. Append failure cannot advance recent persisted activity.

Proof must use actual source/processor append seams. Hold a stream, detach, release
it, then repeat with reattach before release: inference still returns, neither old
exchange appends. Test queued and parsing work, append already in progress and
an unrelated client concurrently. Barrier waits for admitted append settlement;
after success no late write occurs. New SDK/CLI requests using unchanged gateway
host after detach forward unrecorded. Legacy `/api/chat` is also off. Repeat
detach/reconfigure/reconcile/restart stays off; explicit attach alone resumes.
Org-required refusal leaves config/routes untouched. Test absent/down/unresponsive
processor, lost acknowledgements, timeout and shutdown without stranded callbacks.
Test each reason and overflow entry; secrets, raw prompts and media never appear
in ordinary diagnostics. Prove append success/failure and sink warnings are
independent. Run affected client, config, transport, source and daemon tests.

CPU/memory proof inspects the raw active/finishing ceilings, generation/waiter
lifetimes, timers, enum maps, repeated config reads and exchange-local copying.
Repeated off traffic and failed barriers cannot create a permanent request ledger,
busy retry loop or growing queue. Stop test-owned services only.

## T4: persisted check and normal status {#t4}

@ref LLP 0474#diagnostics [implements]: correlate the check to storage and distinguish readiness, history and current recording

Homes: Ollama commands, gateway source details and existing core status/client
rendering/query seams on the integrated base. Do not introduce a SQL requirement
for users or boot/query datasets from the cheap status path.

1. Implement `hyp ollama verify --model NAME [--json]` with explicit prompt/export
   disclosure, existing-model readiness and recording/live-processor checks.
   Send one small chat with think false and fresh existing header/attribute
   correlation. Bound inference and persistence separately at30seconds each and
   at most six targeted partition reads. Print request_id and persisted result.
2. Confirm request and current completed-response rows, provider/model and order
   from actual queryable storage. HTTP completion, load-only generate, old rows or
   activity alone never pass. Off/not-ready/unsupported/append/query failure and
   timeout have distinct actionable results and non-success exit status.
3. Render configured versus actual live route, no traffic, append-resolved last
   capture, recording disabled and bounded capture failures at normal settings.
   Historical timestamps when off/restarted are labeled history. A custom saved
   endpoint awaiting reload is unconfirmed, not healthy. Use existing status
   vocabulary/seams, maintaining sink and other-client compatibility.

Proof drives real command dispatch with temp installed config and a controlled
model fixture; delay/fail append and poison storage with older successes to show
false positives cannot pass. Assert fixed deadlines/read count, no query on cheap
status and no model download. Exercise controls-only traffic, restart-reset live
state, append failure after success, detached history and fallback gateway port.
Run command/status/client/query tests and normal stderr evidence checks.

## T5: complete journey, docs and real-client proof {#t5}

@ref LLP 0474#setup [implements]: normal installed setup replaces developer configuration as the primary user path
@ref LLP 0474#resources [tests]: fixtures and installed-client evidence are separate acceptance obligations

Extend `gateway_ollama_capture` or the nearest existing complete-flow smoke rather
than creating a harness. Hermetic flow covers picker fresh setup, adding beside
another client/custom upstream, repeat and explicit noninteractive setup, route,
stream/nonstream capture, correlated verify/query, restart/no duplicate growth,
running-host detach/reattach and direct recovery with collector stopped. Use stable
DEV_RUN_ID, smoke_name and smoke_step; assert user results plus local safe
telemetry proving route/projector/append/barrier ran. Hermetic tempHYP_HOME and
HYP_DEV_TELEMETRY are regression evidence, not installed acceptance.

Maintain README, docs/CLIENTS.md and docs/TROUBLESHOOTING.md in the candidate.
Replace the developer-temp-JSON primary Ollama recipe and stale API-only
eligibility/diagnostic statements, update README links/table and clients contents,
and qualify generic attach/history/detach/privacy guidance. Explain normal
installed picker/setup, exact supported versions, actual live `/ollama` host root,
CLI command/SDK constructor, explicit first persisted check, unchanged-running-
client unrecorded forwarding after verified detach, unconfirmed barrier recovery,
explicit resume and preserved-host direct recovery with collector absent.
Describe surviving text and ordered omitted-media markers, unsupported semantics,
context limitations, unknown directory exclusions, export sinks and no history
import/outage replay. Provide substantive incoming explanations with attached
`@ref LLP 0474#...` and `@ref LLP 0475#t5` at these maintained prose homes, rather
than a bare link list. Reconcile changed non-obvious code refs in the same task.
The documentarian retains associated coverage/accuracy on this existing parent;
give it bounded exact-candidate doc/journey readback, no new dispatch or slot.

The owner arranges actual installed-package/daemon proof at the final candidate
using an existing model and test-owned installation/state, preserving the owner's
authenticated environment. Record candidate/package hash, install method, actual
CLI/SDK versions, daemon mode and commands/results. Exercise actual CLI0.35.1
one-shot generate and interactive two-turn chat, and Python SDK0.6.1 explicit
Client host with chat/generate streaming and nonstreaming. If supported versions
change, first inventory their actual calls and adapt truthful guidance/proof;
do not infer native CLI success from curl or SDK results. Retain wire-versus-row
comparisons for ordered text, model and available usage without leaking content.

Prove correlated first capture retained after collector restart with no duplicate
growth from restart alone. Keep a CLI session and SDK object alive across detach:
fresh requests at their unchanged gateway hosts must return inference without new
Ollama rows, prior rows remain and another attached client still captures. Attach
again and prove only new-generation capture. Stop the collector, then prove the
explicit preserved-custom-host CLI and newly constructed SDK direct recipes.
Demonstrate actionable ordinary-status/default-telemetry reasons using controlled
capture/upstream failure. Record unavailable model/client/platform constraints as
missing evidence, never substitute fixtures or old pilot proof. This specific
gate lives in mission evidence under LLP0430; no docs/ACCEPTANCE.md revival.

## Review and owner handoff {#acceptance}

Each task supplies committed SHA/base, changed areas, focused tests with exit
status, honest limitations and explicit CPU/memory pass. Use npm test for the
active root suite on the integrated candidate, npm run typecheck for changed
capability contracts, npm pack --dry-run for new packaged commands/manifest and
relevant existing gateway/client/status smokes plus the complete Ollama flow.
No release tag is in this task; any later release still follows its own checklist.

The owner assigns the independent Astra reviewer the immutable candidate/base,
LLPs, source acceptance, task results and actual-client artifacts. Reviewer uses
a separate clean checkout and reproduces appropriate checks. Default two rounds,
with supported fix/defer/reject/blocker dispositions and owner-recorded bounded
extensions under FLOW. Re-observe the final SHA; changed candidate invalidates
affected proof. Guardian checks the final user journey, documentarian verifies
maintained prose coverage/accuracy, steward confirms integrated runtime/status
fit. Design/probe/plan readbacks alone are not implementation acceptance.

Return exact integration/task SHAs, all source checkpoints, independent review,
CPU/memory findings, docs coverage and installed-client evidence on the same
native parent. Missing live persistence or running-client stop proof holds
acceptance. Publication/production merge remains a separate authorized step.

## Effort and remaining uncertainty {#effort}

Planning estimate, not an execution deadline: T1 3-5 hours, T2 4-6 hours,
T3 6-9 hours, T4 3-5 hours, T5 4-7 hours, plus independent review/fixes and
external sink integration wait. The recording barrier across split ownership is
the largest uncertainty; route alias validation and existing query availability
are smaller concrete gaps. Keep task startup-plus2h checkpoints with the owner.

The three versioned mock probes establish host-prefix/control feasibility only.
Installed daemon permissions, actual model responses and durable/query visibility
remain unproved. A different client version, missing owned test service/model or
sink-base conflict may change estimates. Surface a concrete dependency or scope
decision to the owner/mayor while unrelated work continues; do not hide it behind
new infrastructure, blanket support claims or extra approval stages.
