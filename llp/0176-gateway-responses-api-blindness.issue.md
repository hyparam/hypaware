# LLP 0176: Gateway proxies OpenAI Responses API but records nothing, silently

**Type:** Issue
**Status:** Draft
**Systems:** Plugins, Gateway, Sources
**Author:** Brendan / Claude
**Date:** 2026-08-03
**Related:** LLP 0167, LLP 0172, LLP 0175

## Summary

The ai-gateway forwards OpenAI Responses API traffic (`/v1/responses`)
correctly as a proxy, but the recording layer has no decoder for that wire
shape, so proxied exchanges produce no rows, no recent-client entry, no error
count, and no log line. A client can route its entire OpenAI workload through
the gateway and every observability surface reports that nothing is
happening. A second, related gap: even in the supported Chat Completions
shape, exchanges whose upstream returns an error status (observed: 400) are
dropped with the same total silence.

LLP 0167 named `/v1/responses` as a seam when the OpenClaw capture was
designed; this issue is that seam observed in production on 2026-08-03.

## Evidence

From the 2026-08-03 investigation:

- OpenClaw, attached with the standard provider override
  (`models.providers.openai.baseUrl` -> `http://127.0.0.1:18521/v1`), served
  multiple API-key turns via `api: openai-responses` (model `gpt-5.6-sol`).
  A dead-endpoint falsification test (`baseUrl` -> `127.0.0.1:9`, turn fails
  with a connection error; restore gateway URL, turn succeeds) proved these
  requests transit the configured endpoint - the gateway - yet zero rows,
  zero recent-client entries, zero errors, and zero log lines resulted.
- A manual probe confirmed forwarding: `POST /v1/responses` against the
  gateway with an invalid key returned OpenAI's own 401 through the proxy.
  The probe also left no trace in any HypAware surface.
- Error-shape sub-case: with the overlay forced to `api: openai-completions`,
  OpenClaw sent Chat Completions requests through the gateway and OpenAI
  answered `400 Function tools with reasoning_effort are not supported for
  gpt-5.6-sol in /v1/chat/completions`. The 400 round-tripped through the
  gateway to the client, and again nothing was recorded and `recent errors`
  stayed 0.
- Consequence during diagnosis: hours of investigation proceeded on the
  false premise that OpenClaw was bypassing the gateway, because "recorded
  nothing" and "never arrived" are indistinguishable in every surface the
  daemon exposes.

## Impact

- OpenClaw's OpenAI traffic (and any future Responses-API client) cannot be
  live-captured even when routing works perfectly; only the Lane B sweep
  covers it.
- Failed exchanges are invisible even in supported shapes, so upstream
  errors (quota, schema rejections, auth failures) leave no diagnostic trail
  in the dataset or logs.
- Silent passthrough breaks the Log-Driven Development contract this repo
  documents: a failure should identify the broken step, not present as a
  healthy no-op. The attach surface compounds it by reporting "attached"
  based on settings written rather than traffic observed.

## Fix direction {#fix-direction}

1. Add a Responses API decoder to the ai-gateway recording layer: request
   schema, response schema, and streaming event shapes for `/v1/responses`,
   projecting into `ai_gateway_messages` alongside the existing Anthropic
   Messages and Chat Completions decoders.

   DONE 2026-08-03: implemented as a third parse branch of the openclaw
   exchange projector (`projector.js`: `isOpenaiResponsesExchange`,
   `openaiResponsesMessages`, `openaiResponsesAssistant`,
   `openaiResponsesSystemText`, `responsesAssistantFromStream`), dispatched
   per exchange on path/body shape since both OpenAI dialects ride one
   provider entry. Emits the shared Anthropic block vocabulary so Responses
   turns produce the same match keys the session file yields (verified by
   test against `sessionMatchKey`), request-side `reasoning` replay items
   are skipped, `instructions` plus the leading system/developer input run
   fold into `system_text`, streamed exchanges reconstruct from the
   terminal `response.completed` payload with a finished-items fallback,
   and Responses usage is re-keyed through the existing Chat Completions
   netting path (gross input minus cached read, LLP 0035). Covered by
   `test/plugins/openclaw-projector-responses.test.js`.
2. Record error-status exchanges in supported shapes (rows flagged
   `is_error` / status, or at minimum a structured log + `recent errors`
   increment). STILL OPEN, and still unverified whether matched error
   exchanges record today (the round-1 review showed the observed 400
   silence was the unmatched-drop layer, not error handling).
3. Log every proxied exchange the recorder cannot decode: upstream, path,
   status, and a wire-shape guess, so an unsupported dialect surfaces as a
   named gap instead of a silent no-op.

   DONE 2026-08-03 (narrow form): the dispatcher's existing
   `aigw.message_projection_skipped` warn now carries `path`, `method`,
   `status_code`, and `is_sse` alongside upstream and exchange id. Where
   that warn is SINKED in a production (non-dev-telemetry) install remains
   the open half: the event existed all along and still read as silence
   during the 2026-08-03 diagnosis.
4. Sequencing constraint (LLP 0175): SATISFIED before this decoder landed.
   The settlement chain was fixed and verified live the same day (client
   header + match-key timestamp normalization; see LLP 0175 fix direction),
   so Responses exchanges decode into rows that settle rather than
   duplicate.

## Scope notes

- Subscription/OAuth ceiling: OpenClaw's ChatGPT-OAuth route uses a
  hardcoded endpoint (`buildOpenAICodexStaticProviderConfig`) that never
  consults `models.providers`, so no config override can bring that traffic
  to the gateway. For subscription-based OpenClaw use the sweep is the
  ceiling, not a fallback; document as explicit scope, not a bug here.
- Overlay routing itself is NOT broken: the 2026-08-03 tests proved both the
  `openai` and `anthropic` builtin providers honor the overlay `baseUrl` for
  API-key traffic in OpenClaw 2026.7.1-2. The attach's config write is
  sound; blockers were client-side routing conditions (runtime pins, auth
  profile order, restart-pending) plus this recording gap.
- Upstream courtesy report: OpenClaw 2026.7.1-2 crashes (`openclaw models
  list`/`status`, `applyAnthropicSonnet5Cost` reading `.cost.input` of
  undefined) on any `agents.defaults.models` entry naming an Anthropic
  model. Minimal repro established; unrelated to HypAware but encountered
  while diagnosing this issue.

## Open questions

- Should unrecognized-dialect passthrough be opt-in (fail closed by
  refusing to proxy unknown shapes) or logged passthrough (current behavior
  plus the diagnostics of fix 3)?
- Does the Responses decoder need `previous_response_id` chain handling to
  avoid re-projecting replayed history once settlement (LLP 0175) lands?

## References

- LLP 0167: original capture RFC; names the `/v1/responses` seam.
- LLP 0172: two-lane design this recorder serves.
- LLP 0175: settlement miss; carries the fix-ordering constraint with this
  issue.
