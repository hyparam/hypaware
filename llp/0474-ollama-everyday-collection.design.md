# LLP 0474: Installed Ollama collection with scoped native routing

**Type:** design
**Status:** Active
**Systems:** Onboarding, CLI, Config, Gateway, Plugins, Sources, Observability
**Author:** HypForge designer
**Date:** 2026-10-07
**Depends-on:** sink-instance-bound-2226
**Related:** LLP 0473, LLP 0468, LLP 0469, LLP 0130, LLP 0131, LLP 0183, LLP 0466, LLP 0038, LLP 0164, LLP 0313, LLP 0430, LLP 0471, LLP 0472
**Extends:** LLP 0469 (native client routes, mixed content and production diagnostics), LLP 0183 (selected Ollama upstream preservation), LLP 0430 (this request's specific installed-client proof)
**Extended-by:** LLP 0476 (#diagnostics: bounded cohort settlement and non-mutating verification read context)

@ref LLP 0473#requirements: complete installed discovery, routing, persistence and reversible recording
@ref LLP 0469#exchange-scope: retain snapshot identities and temporary expansion state

## Existing seams and measured clients {#evidence}

At base `9e53cf4c096de091b4ff700dc2ce2c384fcf0849`, the adapter contributes
one route preset and one text chat projector. Gateway `mergeUpstreams` preserves
operator routing and deliberately does not copy preset match/rewrite into a
same-named configured route. `composePickerConfig` recomputes gateway upstreams.
The client registry, recording switch and disk-driven detach already exist.
`source.js` records recent entrypoints only after `appendRows` resolves. The
normal logger has no exporter without dev telemetry or an OTel endpoint; the
existing per-call-site stderr mirror works without either. Status has no dataset
boot and must not scan history to infer capture health.

Controlled probes on 2026-10-07 used installed Ollama CLI **0.35.1** and an
isolated test installation of official Python SDK **0.6.1**, against a disposable
loopback mock. They performed no inference, model download or real service change.
Both retain a host URL prefix, including `/ollama`. This establishes routing and
serialization feasibility, not HypAware persistence or real-model acceptance.

| Surface | Observed requests and controls |
| --- | --- |
| CLI one-shot `ollama run MODEL PROMPT --think=false` | `HEAD /`, `POST /api/show`, `POST /api/generate`; empty suffix/system/template, options object, think false |
| CLI interactive, two PTY turns | heartbeat, show, empty-prompt generate to load, then `/api/chat`; the second chat resubmits earlier context |
| Python `Client(host=ROOT)` chat/generate | appends `/api/chat` or `/api/generate` to ROOT; explicit stream true/false; chat includes tools [] |

Primary references are [native chat](https://docs.ollama.com/api/chat),
[generate](https://docs.ollama.com/api/generate),
[CLI source at v0.35.1](https://github.com/ollama/ollama/blob/v0.35.1/cmd/cmd.go)
and [Python types at v0.6.1](https://github.com/ollama/ollama-python/blob/v0.6.1/ollama/_types.py).
The mission retains `client-probe-cli-design.json`,
`client-probe-cli-interactive-design.json` and `client-probe-sdk-design.json`.
Support starts with these named versions, subject to final real-client proof.
Do not infer compatibility with every version or every Ollama feature.

## Discovery and installed setup {#setup}

Add a visible `ollama` picker contribution to the existing adapter. Use existing
`detect.settings_file: .ollama/history`: the detector checks its parent directory,
so this suggests local Ollama state, not a proven installed executable or running
service. Keep the row available regardless. A stale directory is only evidence;
absence does not exclude a service installed elsewhere or an SDK-only client.
No plugin code runs to render the picker and no network/inference occurs there.

Compose `@hypaware/ollama`, `requires_gateway: true` and the existing named
`ollama` upstream. Leave proxy mode alone; no interception/CA is needed for this
lane. The client manifest declares `name: ollama` without `attach_probe`: there
is no persistent client settings file to change. Register the runtime gateway
client to supply truthful explicit attach receipts, with `defaultUpstream: ollama`.
Its attach action writes no marker, shell profile or service settings.

The source-authorized extension to LLP 0183 is narrow: when an existing local
Ollama row remains selected, preserve its same-named upstream's custom base URL
and operator fields rather than replacing them with picker defaults. Preserve
unrelated configured upstreams while adding Ollama. Deselection still removes
upstreams owned solely by deselected picker rows, including Ollama; do not
resurrect them by merging whole lists. Unmanaged explicit upstreams survive.
Other rows retain their established composition behavior. Determine ownership
from existing manifest contributions and names, not a new saved ownership key.
Honor central ownership and all existing recording false entries.

Existing noninteractive forms stay explicit: `--from-file` honors the supplied
configuration, including recording false and upstream values, and runs no
attended configure command. A source-based add/repeat over an existing install
preserves the selected Ollama entry and unrelated configuration; it never turns
recording false back on. A genuinely fresh explicit composition uses defaults.
This is the Ollama-specific preservation extension, not a new robot wizard or a
change to every preset's semantics. Test each supported invocation as actually
parsed by the installed CLI.

@ref LLP 0130#picker-block: use manifest detection and composition data
@ref LLP 0183#carry-forward: extend only the upstream preservation required by this source, retaining removal semantics
@ref LLP 0131#attended-only: unattended setup does not run configure commands or inference
@ref LLP 0466#reattach-paths: setup and reconciliation preserve an explicit recording stop

Add plugin-owned `hyp ollama setup [--upstream URL] [--json]` as a repeatable
readiness/route explanation and the picker's attended configure command.
`--upstream` is an explicit write to the existing gateway upstream base_url,
using established local-config writes/backups, and refuses inert central edits.
An endpoint change uses the existing collector reload/restart mechanism before
advertising a confirmed live route; if that cannot complete, show saved versus
live configuration separately and give the existing restart command.
It is the ordinary command for a custom local endpoint, not a new config section.
Without that argument, read and explain current settings without endpoint changes.
Missing executable, stopped service or no models is a readiness result with a
catch-up action, not a reason to erase a valid selected adapter. Never run verify
or pull/start a model automatically from this command. Skip setup for detached
rows as the walkthrough already does; show the detached state and explicit attach.

Readiness resolves the preserved direct URL, then independently checks executable
presence on PATH (no execution), `GET /api/version` and `GET /api/tags` at that
one URL. Two probes share a 3-second deadline, no retries or redirects; cap
retained response bytes at 1 MiB and displayed model names at 20 sanitized entries.
Inventory truncation is reported as incomplete, not no models. Use `OLLAMA_HOST`
only as a disclosed initial suggestion when no named upstream exists; the user
confirms it through setup. Once configured, the named upstream wins. Never read
the routed launch environment as a new direct upstream. Reject a direct target
that points back at a known collector listener, including loopback aliases.

Show installation evidence, service/version, installed models, preserved direct
upstream, live capture endpoint and the next routing command. Warn before opt-in
that export sinks can export these rows, cwd/repository are unknown and directory
exclusions cannot protect this lane. Media content is omitted, snapshots repeat
submitted context, and history import/outage replay do not exist.

## Route ownership and endpoint scope {#routes}

Use **the running gateway base plus `/ollama`** as the native client host root.
Resolve its actual bound port from the existing live status seam, including a
fallback port; a configured address alone is labeled unconfirmed. The old exact
`POST /api/chat` capture route remains supported with its existing named upstream.

Current registration cannot derive a new door from a resolved configured
upstream. Add one narrow gateway capability method:
`registerUpstreamAlias(name, canonicalName, route)`. Route carries existing
path_prefix, match, provider/priority and rewrite fields, not a persisted config
key. Resolve aliases once after ordinary `mergeUpstreams`, before compilation.
An alias inherits the canonical resolved base and applicable transport values;
its own adapter route matcher/rewrite replaces that canonical route's path rules.
Reject missing canonical targets, duplicate names, self references or alias chains.
Do not add an arbitrary route-transform pipeline or change ordinary preset merge.

Ollama registers runtime alias `ollama-native`, canonical `ollama`, prefix
`/ollama` and an exact method/path allowlist. Existing `applyPathRewrite` strips
that prefix to the configured service base pathname (or `/`), preserving the
query string. This supports a custom host, port and explicit service base path.
The compiled table must demonstrate the actual destination, including competing
catch-all routes. Explicit conflicting routing is surfaced, not hidden by a
success receipt. No alias configuration entry or additional listener is stored.
Reserve this native namespace before ordinary fallback selection: an unsupported
method/path under `/ollama` returns the local 404, even when a competing catch-all
would match. An allowlist matcher alone does not establish that boundary. Cover
capability typing/validation and exact outbound pathname/query for root, prefixed
custom base and trailing-slash cases.

| Native path after prefix removal | Forwarding | Capture |
| --- | --- | --- |
| HEAD / | heartbeat | none |
| GET /api/version, GET /api/tags | version/inventory | none |
| POST /api/show | model metadata/discovery | none |
| POST /api/chat | native chat | completed admitted snapshots |
| POST /api/generate | native generation and load/unload control | completed admitted prompt/response; load/unload is not a conversation |
| Other methods/paths | unsupported on the native door | none, actionable local 404 |

Keep discovery/control off the raw capture transport so model metadata cannot
consume capture slots or be mistaken for conversation persistence. Generate load
requests share the generation route: projection recognizes their empty prompt
and native load/unload completion and returns an intentional non-conversation
outcome. A missing model is reported; this journey does not proxy model pulls.
No embedding, mutation, cloud, OpenAI-compatible or arbitrary Ollama endpoint is
claimed. Legacy capture matches its actual inbound path as before; prefixed
projection strips only the known prefix and verifies the alias/provider pair.

Attach enables the existing recording switch and prints a recipe such as:

```sh
OLLAMA_HOST=http://127.0.0.1:<live-port>/ollama ollama run <installed-model> --think=false
```

The assignment applies to that client process only. Python uses
`ollama.Client(host='http://127.0.0.1:<live-port>/ollama')`; this is the host root,
not `/api/chat`, and explicit host avoids a global module client's old environment.
Attach must say "Recording enabled; route your next client using this URL".
It does not claim that a running process moved, or that raw `ollama run` without
this assignment is captured. API clients may explicitly use the same host root.
No environment variables are changed in the calling shell or server service.

@ref LLP 0313#the-rewrite-is-declarative-data: reuse prefix-swap machinery and retain distinct inbound/outbound path facts
@ref LLP 0466#switch: attachment controls the existing plugin recording state

Detach preserves gateway forwarding to the direct service for processes still
using the capture URL, while preventing recording. It calls this **unrecorded
gateway use**, not direct use. Print a direct next-launch recipe using the actual
preserved upstream root:

```sh
OLLAMA_HOST=<preserved-direct-root> ollama run <installed-model> --think=false
```

Print the SDK equivalent, `ollama.Client(host='<preserved-direct-root>')`.
These explicit next-launch/constructor recipes restore direct use and must work
when HypAware is stopped. Merely omitting the capture assignment is a shortcut
only when the resulting ambient/default host is verified to match that root.
Collector outage
requires that explicit recovery; no transparent failover is promised. Endpoint
changes require re-running setup/attach and re-launching or reconstructing the
client with the current URL. Existing processes retain their original host.

## Recording stop and in-flight boundary {#recording}

Reuse `recording: false` on `@hypaware/ollama`, existing fresh local/central
precedence and organization detach refusal before any mutation. Registering a
probe-less client never implies a marker or automatic route rewrite. Only explicit
attach resumes; package update, setup, apply and reconciliation do not.

The legacy route and native alias share one gate. At gateway admission, use a
freshly checked recording state to avoid body capture when off. In processing,
check again before projection and before append admission. Missing owning plugin,
disabled plugin or an unreadable/invalid recording configuration closes this
Ollama gate and leaves forwarding working. Do not silently inherit the current
reader's fail-open empty-list fallback or change unrelated clients' semantics.
Reuse the reader and precedence logic with an explicit read-failure result.

Attach/detach send a bounded control refresh/barrier through the existing reserved
`/_hypaware/` control transport and split-daemon IPC; they do not start a second
service or persist another switch. Resolve the control host from live source
advertisements. One outstanding operation per client, a 10-second deadline and
bounded request/response payloads prevent retained waiters. Advertise the control
route in existing source details. The receipt reflects the processor acknowledgement,
not merely gateway HTTP acceptance or config file write.

Associate each admitted capture with a process-local monotonically increasing
recording generation carried through the bounded raw handoff. On detach the
processor invalidates earlier generations, suppresses not-yet-admitted appends
and drains appends already admitted to the storage operation. Success means those
admitted writes settled and the gate is off: no older admitted write can land
later. An already-written row is retained. A held stream from the old generation
cannot later record when released, even after detach followed by reattach.
Newly attached requests acquire a new generation. Processor or gateway restart
invalidates all old handoffs and rebuilds state from the existing config.

If the collector is proven stopped, no live barrier is needed. If live enforcement
cannot be confirmed within the deadline, keep the saved recording false, return
nonzero and say "Recording disabled in configuration; live stop not confirmed".
Offer retry or the existing collector stop command plus direct-client recovery.
Do not hang the CLI, report success, silently resume recording or kill an unrelated
process. A simultaneous config update must be revalidated before acknowledgement.
The implementation must handle split and in-process hosts with the same boundary.

@ref LLP 0466#fresh-read: a running daemon must observe the switch without restart
@ref LLP 0466#central-refuses: org-owned detach refuses before route or recording changes
@ref LLP 0038#capture-transport-and-privacy: preserve bounded raw IPC and separate forwarding from recording loss

## Native admission and media omission {#projection}

Retain successful HTTP, error-free transport, one terminal completion and
whole-exchange failure handling. Share existing snapshot IDs, links, counters and
completion logic between chat and generate, without accumulating sessions.

Chat admits native string content and ordered images arrays on otherwise
supported system/user/assistant messages. Emit the text block, including an empty
one, then one existing image block per image in wire-array order. Native fields
separate text from images and do not encode original interleaving; do not invent
it. Media-only user messages retain their image markers and positions. Never copy
base64 image strings into blocks, attributes, raw_frame or logs; no decode, MIME
sniffing, fetching or file open. Preserve only metadata actually supplied and
supported by existing part columns. Native images supply no trustworthy filename
or MIME type. A marker with absent content means omitted bytes, not a saved image.

Native file/array/audio/video shapes unsupported by the selected protocol are not
silently normalized. Text containing a data URI still passes through the shared
projector's existing payload-strip rule and explicit stripped marker. For native
tool-role/media or nonempty tool calls, emit unsupported semantics and no rows;
that is a separate boundary from media omission. Include shared-projector nested
tool-result payload-strip fixtures where that representation already exists,
without claiming new native tool support. Empty tools/tool_calls and empty
thinking fields observed as defaults have no semantics to capture.

Admit `think: false` and absent/null default controls only while validating that
no nonempty thinking output occurs anywhere in request history or response. True
or level controls and actual thinking remain unsupported. Allow known ordinary
format/options/keep_alive/stream controls and observed empty CLI defaults; validate
present types. Unknown semantic fields remain an unsupported shape, not discarded
meaning. Do not persist a spread of native request/response objects.

Generate records only supplied system/prompt text and image markers, then the
new response. Empty suffix/template/default context arrays are harmless. Supplied
opaque context token arrays, if present, are not decoded, stored or represented
as historical messages; docs say earlier context is unavailable in this shape.
Nonempty unsupported template/suffix semantics are diagnosed rather than silently
invented. Empty-prompt load/unload completion produces no conversation rows and
no capture-failure warning. Validate streamed `response` strings and terminal
fields as strictly as chat messages. Response context token arrays are discarded.

Usage stays on the current response's last part. Missing counters remain unknown;
valid zero remains zero, net input requires observed cache counts, and inconsistent
counts keep the existing warning/omission policy. Repeated text at different
positions and repeated requests remain distinct. Unknown cwd/repository stays
unknown. A valid media omission is a successful supported snapshot with markers,
not a malformed/interrupted/over-budget drop.

@ref LLP 0469#wire: retain complete exchange admission and no partial failed history
@ref LLP 0469#usage-privacy: observed usage, one carrier and unknown directory context remain authoritative

## Persisted first check and default diagnostics {#diagnostics}

Provide `hyp ollama verify --model <installed-name> [--json]`. It first establishes
readiness, an existing listed model, recording enabled and live gateway/processor;
then explicitly sends one small native chat request with think false. Inference
occurs only for this user-invoked check. Explain the fixed check prompt and that
configured sinks may export it. Never select a downloadable model or pull one.

Generate a fresh opaque check token, reuse existing `x-hyp-dev-run-id` metadata
correlation and its `attributes.dev_run_id` projection, and discard token state
on completion. This header is correlation metadata, not permission or a bypass
of recording/usage policy. Use the existing local query machinery to await the
correlated persisted request and new-response rows, checking shared request_id,
provider/model, order and completed assistant. A load-only response, old rows,
a terminal HTTP response or general recent-activity counter cannot satisfy it.
Bound inference at 30 seconds and persistence wait at 30 seconds, with at most
six targeted reads, a short time-partition predicate and no unbounded history
scan. Report the actual request_id on success; no SQL is needed from the user.
If correlation/query is unavailable, return an honest unconfirmed result.

Normal status reads live source snapshots, client descriptors and config only.
Reuse `recent_entrypoints` for append-resolved rows, existing `recording`,
`capture_ready`/capture-drop counters, `lastError` and diagnostics rendering.
Source `details` may carry the required bounded capture-outcome summaries: a
maximum of 32 known route/client entries with counts and last observed/persisted/
failed timestamp, exchange ID and enumerated reason. This is required default
capture evidence, not a dataset/config schema or per-exchange log store. Names
and identifiers are sanitized/capped; failures never advance persistence stamps.
Control forwarding and intentional omission are distinct from capture failures.

Required reasons include upstream unavailable/http error, unsupported shape or
semantics, malformed/missing-terminal/interrupted response, capture budget or
processor unavailable, append failure and unconfirmed recording barrier. Map
adapter admission outcomes to source evidence through a narrowly typed callback
in the projector context; keep provider semantics in the adapter. Transport and
append own their existing outcomes. Do not infer failure merely from zero rows.
Use the existing stderr mirror for bounded reason transitions in the normal
service log, regardless of exporter settings. Emit run/exchange correlation,
operation and enum fields, never prompts, media payloads, credentials, query
strings or raw upstream errors. Rate-limit repeats with finite reason counters;
do not append a full diagnostic on every failed request forever.

| Evidence | User-facing meaning |
| --- | --- |
| plugin configured, no live endpoint/processor | configured; collector not ready, with recovery |
| live route and recording on, no traffic this run | ready; route a client or run verify |
| admitted traffic but no confirmed append | observed; capture pending/failed/unconfirmed |
| append-resolved recent entrypoint | persisted capture at timestamp, not inference alone |
| recording false | Not recording; retain any historical evidence as history |
| explicit failure evidence | reason, time and next step; old success is not current health |

Restart resets process-local observations; old status is labeled historical and
is not proof of this run's traffic. Existing rows stay queryable. The verify
command's targeted persisted read is intentionally separate from cheap status.

@ref LLP 0164#gateway-tracks-what-core-cannot-name: activity starts after append and stays bounded
@ref LLP 0164#status-reads-it-from-the-status-file: status does not boot datasets or walk history

## Resources, fit and proof {#resources}

Reuse the split-daemon transport ceilings from LLP 0469. Parse each request and
response record once, join response fragments once and release raw strings after
projection. Strip media before canonical row serialization, avoiding payload
copies and exchange-wide duplicated text. Add an exchange-local 4096-message/
image-marker limit and 8192-part limit before expansion, so many tiny empty parts
cannot multiply a 16 MiB raw budget into excessive row state. Diagnose this as
capture budget loss; forwarding remains unchanged. No listener-lifetime session,
request-token or media map is added. Existing raw active/finishing bounds also
bound append/barrier work; settle/clear timers and promises on every failure.

The source header/body probes, CLI verification waits, finite outcome summaries,
recording refresh and IPC barriers must receive an explicit CPU/memory review.
Avoid per-status filesystem/cache walks and repeated parsing of unchanged config
per row: refresh recording state per exchange/generation using existing file-change
and control events, with a fresh pre-append check. Never retain entire config or
provider body on each diagnostic entry. This design has no unbounded growth by
construction; implementation bounds and real heap/CPU behavior remain to prove.

Guardian dispositions `01M4C87DZ0FWC9DYSF565SQ05F` and
`01M4C8GG498G4CZD78PQNY66NV` require recipe-only attach honesty, old-generation
suppression and append drain before a stop receipt, direct recovery with the
collector absent, and append-correlated verify. Steward fit
`01M4C8FGZJAGNQ6D2M9MHNJYH7` requires resolved custom-route compilation and
preserves ordinary preset ownership. Readbacks `01M4C8V0MESHM1WJRR043C5BV3`
and `01M4C8VXD3DEAHAN5562YN7F65` add explicit custom-host direct recovery,
namespace rejection before fallback and exact base-path rewriting proof.
Owner `01M4C8FM8Y0BQP2GPR0RWE222P`
confirms the source-authorized narrow LLP 0183 extension. Full dispositions and
source checks stay with mission HYP.0.71; no human document-approval gate.

Tasks touching `src/core/daemon/runtime.js`, processor/gateway lifecycle or core
status must consume the integrated LLP 0471/0472 sink-maintenance base and obtain
an explicit seam readback from its owner. Sink diagnostic history is not capture
health. Held inherited PRs remain held; they are not implementations to adopt.
Adapter/projector and documentation work can proceed without those files.

The plan must cover deterministic contracts, the complete hermetic journey and
actual versioned CLI/SDK plus installed-daemon operation at the final candidate.
This source explicitly requires that narrow proof under LLP 0430's option for a
new specific gate. Keep evidence in the mission; do not recreate docs/ACCEPTANCE.md
or a manual release-procedure tier. Normal installed user guidance belongs in
README and docs/CLIENTS.md, with troubleshooting in docs/TROUBLESHOOTING.md.

Rejected: global shell/service edits or wrapper binaries that shadow ollama;
a dedicated proxy/listener; generic capture of all native endpoints; automatic
model pull/inference during readiness; SDK/API-only acceptance; whole-list config
merging; new media storage; persisted raw replay; status history scans. Each adds
scope or fails the explicit reversible installed journey. The small alias method
and recording/outcome hooks address demonstrated gaps in the existing seams.
