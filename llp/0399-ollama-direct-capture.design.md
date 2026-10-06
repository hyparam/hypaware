# LLP 0399: Direct Ollama capture through the existing gateway

**Type:** design
**Status:** Active
**Systems:** Gateway, Plugins, Sources, Query
**Author:** Neutral Next designer
**Date:** 2026-10-05
**Related:** LLP 0398, LLP 0400, LLP 0005, LLP 0010, LLP 0016, LLP 0026, LLP 0030, LLP 0035, LLP 0038, LLP 0050, LLP 0069, LLP 0193, LLP 0194, LLP 0204

@ref LLP 0398#requirements: implements the accepted direct local text API capture request

## Existing seams and alternatives {#seams}

At base `95ae33ee5d894feed272ea5f1fece33ed5b0392e`, ai-gateway `api.js`
exposes `registerUpstreamPreset` and `registerExchangeProjector`. `source.js`
merges route presets with explicit upstream config, dispatches the completed
exchange and appends normalized rows through the gateway-owned cache contract.
`proxy.js` pipes client/provider bytes unchanged. `recorder.js` captures ordinary
JSON/NDJSON as `response_body`; only SSE is event-decoded there.

Use a small bundled `@hypaware/ollama` adapter under the existing plugin
workspace. A config-only route cannot produce messages without a projector.
A separate source/listener would duplicate routing, recording, storage and
lifecycle. Putting native Ollama projection into ai-gateway conflicts with its
provider-independent ownership. Reusing Codex/OpenClaw projectors would require
false client attribution or an unrelated wire shape. The OpenAI-compatible API
is a viable separate scope but does not cover the chosen native chat path.

@ref LLP 0016#knows-nothing-about-claude-or-codex: provider projection belongs in an adapter; transport and dataset stay gateway-owned
@ref LLP 0005#declarative: reuse the existing plugin manifest and capability dependency contract
@ref LLP 0010#explicit-plugin-set: explicitly configure both gateway and adapter

The adapter requires `hypaware.ai-gateway` `^2.0.0`, registers a distinct
`ollama` upstream with provider `ollama`, default base
`http://127.0.0.1:11434`, `path_prefix: /api/chat` and an exact POST/path matcher.
It adds no source, table, managed client, picker row or config section. Add it to
`V1_EXCLUDED_FROM_DEFAULT` for discovery and explicit activation, not to default
activation. Existing gateway `upstreams` can override the named base URL for
tests/custom local services; do not invent an Ollama config block or rely on a
config rewrite, which `compileUpstreams` does not copy.

The projector must match the `ollama` upstream, provider `ollama`, POST and exact
`/api/chat` pathname (query stripped), without claiming other adapters' requests.
`proxy_mode` remains off. No CA, CONNECT interception or path rewrite is needed.
Config-owned overrides remain existing routing behavior; the documented recipe
uses the preset's exact route and only configures the listener.

## Native text admission and completion {#wire}

[Ollama chat](https://docs.ollama.com/api/chat) defines a request model/messages
and a response message, model, timestamp, `done` and `done_reason`.
[Streaming](https://docs.ollama.com/api/streaming) uses newline-delimited JSON;
`stream: false` requests one JSON response. Local Ollama 0.35.1 confirmed both
forms with gemma3:4b on 2026-10-05 Pacific. These are upstream-shape observations,
not HypAware capture acceptance.

Admit a nonempty model and ordered messages with supported roles
`system`, `user`, `assistant` and string content, including empty strings.
Require user text in the request. System entries remain ordered snapshot rows
and can also populate existing `system_text`. Reject capture of tools, tool
messages/calls, images, audio, thinking, multimodal arrays and other non-text
message forms. Ordinary generation options, stream choice, text/JSON formatting
and keep-alive do not require new projection fields. Do not spread wire objects
into projections. Unknown optional control fields must not acquire unsupported
content semantics silently.

Successful capture requires a 2xx status, no `input.error`, supported request
and response structure, and one valid `done: true` terminal record. JSON mode
requires one response object. Streaming/default mode parses nonblank NDJSON
records in order, allowing CRLF and a final newline (also a valid terminal
without a trailing newline). Require the terminal to be the last nonblank
record. Malformed lines, a truncated final object, terminal followed by another
record, embedded error records or missing terminal invalidate the exchange.
Each response message must be an assistant text message. Accumulate content
fragments and join once. Validate all records, including any text carried on the
terminal. Preserve the terminal's `done_reason`; map it through existing row
completion conventions and retain its raw value. A token-limit reason is not
a natural stop. A legitimate empty assistant response remains representable as
an empty text block.

Use the reported response model, preferring the terminal, with the request
model only as an explicit fallback when no response model exists. Conflicting
reported models or invalid present model values invalidate capture. Earlier
request-context rows describe the model selected for this exchange, not the
historical model that originally generated that context. Do not invent timestamps
for submitted history: recorder start time is observation time; the generated
response can use a valid observed creation timestamp, otherwise observation time.

Failure policy is whole-exchange drop. No failed prompt, partial assistant or
successful-looking completion row lands. Emit `plugin.ollama.capture_dropped`
with component, operation, exchange_id, status and a bounded reason such as
`http_error`, `transport_error`, `invalid_request`, `unsupported_shape`,
`invalid_response`, `malformed_stream`, `missing_terminal`, `trailing_record`.
Do not log body, prompt, response text, thinking, credential, query string or
unfiltered upstream error text. Existing `aigw.message_projection_skipped` may
accompany a decline; the adapter diagnostic gives the actual reason. Existing
`aigw.exchange_write_failed` diagnoses append failures. Transport-budget drops
remain `gateway.capture_dropped` with capture-drop counts/status. Forwarding
continues under the existing transport behavior even when capture is discarded.

## Snapshot identity and generic state lifetime {#exchange-scope}

Ollama supplies no canonical chat-session/message identity on this path. Use
the existing nonempty recorder `exchange_id` as `session_id` and `request_id`;
leave `conversation_id` absent. Set `client_name: ollama`,
`entrypoint: ollama-api`, `conversation_source: ollama`. Each request context
entry gets an explicit deterministic ID namespaced by exchange ID and request
index. The response gets a separate ID after the request context. Supply
immediate previous-message links, starting with `[]`; retain equal strings at
different positions. `part_id` remains the gateway's message-ID/part-index
composition. No client header or content hash is needed.

@ref LLP 0026#decision: prefer actual identity where it exists; this native API has none, so do not invent transcript UUIDs
@ref LLP 0030#decision: retain the required session key and nullable thread key

The generic live dispatcher gains one explicit state-scope rule: when a
**nonempty input.exchange_id equals projection.session_id and no conversation_id
is supplied**, the projection is exchange-scoped. Expand using a fresh temporary
conversation state and bypass `seedSeenMessagesForSession` entirely. Do not add
IDs or promises to shared seen sets, chains, conversation-start maps, tool
lookups, committed-session indexes or seed maps. Temporary state and any journal
live only through this exchange's expansion/append and are released after
success or failure. Attach a code ref to this predicate/branch. Document this
meaning on the existing projection contract without adding a field.

All other projections keep the current shared state, seed, dedup and rollback
paths. Source inspection found Claude fallback uses short content/exchange
hashes or canonical session IDs, Codex also supplies conversation_id, and
OpenClaw uses short prompt/content/exchange hashes. None of their fallbacks
copies raw exchange_id into session_id with no thread. Hermes/OpenCode use the
projected writer/backfill with native session IDs; this rule does not alter
those entrypoints. Test these distinctions rather than assuming compatibility.

@ref LLP 0204#fix: avoid listener-lifetime retention and history scanning for new exchange-scoped capture

Request context resubmitted on a later turn is recorded again under a new
exchange. This is an observed traffic snapshot, not once-only conversation
history. Only the new response carries usage. There is no raw retry/replay lane
and no promise to dedup a manually redelivered raw exchange. The existing proxy
finalizes once. Cache/spool restart retains already-appended IDs and must not
grow rows from restart alone. No envelope, label, cursor or schema changes.

## Usage and privacy {#usage-privacy}

[Ollama usage](https://docs.ollama.com/api/usage) describes prompt tokens,
cached prompt tokens and generated tokens, with stream counts on the terminal.
Local probes observed prompt/cache/output counts `16/0/3` and `16/11/3`.
Keep provider observations separate from normalized values:

| Observation | Existing destination/rule |
| --- | --- |
| valid prompt and cache counts | `attributes.usage.input_tokens = prompt_eval_count - prompt_eval_cached_count` |
| valid observed cached count | `attributes.usage.cache_read_tokens` |
| valid observed eval count | `attributes.usage.output_tokens` |
| observed native counts/reason | response `raw_frame` with only admitted native counter/reason fields |

Only finite nonnegative safe integers qualify as counts. Observed zero is zero;
absence is unknown. Missing cache count leaves normalized input_tokens absent,
even if the gross prompt count exists; retain that observed native count in
raw_frame. Cache greater than prompt invalidates that pair, omitting net/cache
normalization rather than clamping. Invalid present counters are omitted from
normalized usage with a structured `plugin.ollama.invalid_usage` reason; valid
independent counters may remain and valid content capture can succeed. Preserve
admitted observations for inspection. No synthesized total, cache-write or
reasoning count. Never copy entire raw frames containing unsupported content.

@ref LLP 0035#net-input: observed cache reads are subtracted from prompt tokens
@ref LLP 0035#one-carrier: only the current assistant response carries usage, on its last expanded part
@ref LLP 0050#decision: the gateway has no caller-directory knowledge
@ref LLP 0069#non-goals: directory-blind API traffic has no directory exclusion guarantee

Unknown cwd/user/repository metadata stays null. Honor the existing projector
session-ignore predicate for the computed exchange session, returning the
terminal privacy-drop sentinel when appropriate. This does not create a
practical persistent conversation opt-out: the next request has a new ID.
Stopping capture means selecting the direct URL. No-sink disposable config
keeps the recipe local; configured exports in another install may send these
directory-blind rows. Do not imply local inference automatically withholds them.

## Resources and journey {#resources-journey}

@ref LLP 0038#capture-transport-and-privacy: reuse bounded memory-only capture and preserve provider traffic on recording loss

`runDaemonRun` imports `runGatewayDaemon`; the gateway installs
`createCaptureSender`, the processing child `createCaptureReceiver`. Use this
foreground CLI path in the recipe and hermetic smoke. Existing combined raw
capture bounds are 16 MiB/exchange, 32 active/finishing slots, 32 MiB receiver
retained raw data, 4 MiB pending IPC/256 frames, 64 KiB chunk frames and a
30-minute capture lifetime. Capture-limit, queue-pressure, timeout and processor
outage abandon capture. Plain in-process recorder calls do not inherit these
limits. Do not present raw limits as a whole-processor RSS ceiling.

New work is linear in captured bytes and submitted message/record count. Parse
request once and each response record once, avoid whole-body split/object lists
when a sequential line walk suffices, and join response fragments once. Apply
a defensive combined capture-size check at projector entry before parsing so
direct test/library calls cannot bypass the documented byte ceiling. This does
not retroactively bound standalone recorder buffering. Discard line objects as
they are consumed, keep only admitted content and terminal fields, and release
temporary identity state. No polling, transcript scans, cross-request cache or
new long-running worker is needed. Existing unrelated session-state growth is
outside this change; review verifies the new lane does not add to it.

The user recipe belongs in docs/CLIENTS.md, linked narrowly from README, with
an exact live procedure in docs/ACCEPTANCE.md. Use one disposable HYP_HOME,
version-2 config with gateway+adapter only and no sinks, an explicit free loopback
listen address, config validation and foreground launch. Read actual healthy
gateway/processor status before capture; an occupied explicit port fails loudly,
so choose another and update the request URL. Use an already installed local
model; do not download one. Show exact query correlation using request_id or
attributes.gateway.exchange_id, provider/model, ordered content and nullable
usage/raw counts. Inspect schema rather than assume SQL JSON coercions.

Show diagnostics in the existing gateway/processing logs and status counters.
Use a pilot-owned refused endpoint for unavailable-upstream proof, never stop the
owner's Ollama service. Abort a pilot request for interruption proof. Restart
only the collector with the same state/config, then compare retained IDs/counts.
Restore the direct Ollama request URL and stop the foreground collector with
its normal signal; saved rows remain. Prove a fresh direct request still works.
Unsupported shapes and capture loss are named limitations, not hidden success.

## Consultation and remaining proof {#consultation}

Guardian early constraints `01M47X8EEBJ56YKXE6YAEVZ437`, concrete review
`01M47XB3ZRQ9TBG5M7QQGDKTMM` and refinement `01M47XC3CXVXFQYAK4617R76SH`
govern scope clarity, reversibility, honest context/privacy, snapshot identity
and completion/usage proof. Steward `01M47X8K526F0B2TQ0ABWP221W` and
`01M47XBX71KSTEFMY9C1G73ERK` support the adapter and transient generic rule
with ordinary-session regression coverage. Documentarian
`01M47X85EECD4CKRPA4WS6XZ3T` and `01M47XAYYBPDDHK1WDPSD820RR` supply the
exact documentation homes and unknown-counter/stop/recovery distinctions.
Owner scope and retention decisions are `01M47XAP04SQFYVNP31BDH2Q1H` and
`01M47XBZYNZ51H5CX63Y3DAXYY`. Full evidence stays in mission DESIGN-EVIDENCE.md.
These consultations settle design direction, not implementation or acceptance.

LLP 0400 assigns automated proof and documentation. Independent review and real
Ollama acceptance at the integrated SHA remain with the delivery owner, including
the mission's controlled seat-recovery checkpoint. No publication or production
integration follows from these documents.
