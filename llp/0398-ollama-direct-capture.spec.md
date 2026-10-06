# LLP 0398: Direct local Ollama API text capture

**Type:** Spec
**Status:** Accepted
**Systems:** Gateway, Plugins, Sources, Query
**Author:** Neutral Next designer / delivery owner
**Date:** 2026-10-05
**Related:** LLP 0016, LLP 0026, LLP 0030, LLP 0035, LLP 0038, LLP 0069, LLP 0193, LLP 0194, LLP 0399, LLP 0400

## Intent {#intent}

A user can send a real local Ollama text conversation through an explicitly
chosen HypAware capture endpoint, query its messages, model and available usage,
then restore direct Ollama use. Mission HYP.0.39 supplies this intent. The owner
confirmed the API scope in native room message 01M47XAP04SQFYVNP31BDH2Q1H;
LAUNCH.md and SPEC.md in the pilot mission retain authorization and acceptance.

@ref LLP 0016#knows-nothing-about-claude-or-codex: reuse the gateway and dataset while keeping Ollama wire semantics in an adapter
@ref LLP 0193#consequences: existing Ollama transcript capture through OpenClaw remains a separate supported lane
@ref LLP 0194#decision: preserve accurate per-message provider attribution

## Required behavior {#requirements}

1. Support explicit API clients, including a documented curl conversation,
   using native `POST /api/chat`, both `stream: false` JSON and native NDJSON
   streaming. Capture supported system/user/assistant text context and the newly
   generated assistant response, preserving the client's upstream response.
2. The opt-in is an explicit plugin configuration and selecting the gateway URL
   for requests. Use a separate loopback gateway and the existing local Ollama
   service. Do not reconfigure that service or mutate global client settings.
3. Keep the messages in `ai_gateway_messages`, using its existing columns and
   canonical `attributes.usage`. Preserve observed model identity, nullable
   usage, reported completion reason and exchange correlation.
4. Treat each HTTP exchange as a request-context snapshot. Ordered equal-text
   messages within it are distinct. Repeated real requests are distinct. Earlier
   context submitted again appears in the new snapshot; this is not a stitched
   transcript. Usage belongs only to the current generated response.
5. Successful capture requires HTTP success, no transport/capture error and a
   valid terminal completion. Failed, interrupted, malformed or unsupported
   exchanges produce no message rows and a structured, secret-safe diagnostic.
   A successful response to the caller alone does not prove persistence.
6. Bound new capture work using the existing split-daemon transport and
   exchange-local parsing/identity state. Avoid new listener-lifetime history or
   seed entries for this lane. Preserve established session/thread deduplication
   and ordinary durable cache/spool recovery.
7. Document setup, readiness, exact capture/query commands, supported shapes,
   failure diagnosis, retention after restart and restoring the direct endpoint.
   Leave unknown repository context unknown. Explain the directory-policy limit
   and that local inference can still be exported by configured sinks.

The exchange-local retention contract in LLP 0399 extends LLP 0016's generic
gateway projection mechanics without putting provider semantics into the
gateway. It introduces no new column, config key, durable envelope or dependency.

## Scope {#scope}

This pilot covers text API requests. It does not add automatic `ollama` CLI
capture, managed attach/detach, `/api/generate`, the OpenAI-compatible API,
tools, images, audio, thinking capture, history import or OpenClaw live steering.
Unsupported content may still be forwarded, but must not be presented as a
fully captured supported exchange. Existing OpenClaw backfill is unchanged.

Raw API capture cannot establish a caller's cwd or repository. Do not borrow the
collector's cwd. The isolated recipe has no export sinks; this is the recipe's
configuration, not a privacy property of local model inference.

## Acceptance {#acceptance}

At the exact integrated candidate, independently reproduce automated checks and
follow the documented path in a disposable `HYP_HOME` with an already installed
local model. Capture a real multi-turn conversation and streaming response;
match queried content/model and available counters to the observed wire result.
Verify one current-response usage carrier and distinct equal-text positions and
requests. Demonstrate upstream unavailable and interrupted response outcomes,
retained data without row growth from collector restart, and a fresh direct
conversation after restoring the direct URL and stopping only the collector.

No durable raw exchange replay is introduced. Restart checks prove the existing
cache/spool retains captured identities; they do not promise recovery of an
exchange lost before append. Fixtures cannot replace live Ollama evidence.
Independent review includes an explicit CPU/memory pass. The mission owner
retains delivery and acceptance responsibility after design/plan handoff.
