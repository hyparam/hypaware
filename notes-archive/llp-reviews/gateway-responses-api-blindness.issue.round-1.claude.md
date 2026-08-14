# Review of LLP 0176: Gateway proxies OpenAI Responses API but records nothing, silently

**Reviewer:** Claude (Fable 5)
**Date:** 2026-08-03
**Round:** 1
**LLP Status at review time:** Draft

## Overall assessment

The observed behavior is real and the evidence (dead-endpoint falsification,
the 401 forwarding probe, the round-tripped 400) is unusually rigorous for an
issue doc. But the review pass, cross-checked against the projector code,
shows the draft conflates two distinct layers under one "no Responses
decoder" diagnosis, and one of its claims (error exchanges dropped "even in
the supported shape") is likely misattributed. The decomposition matters
because the fixes live in different places and one of them is shared with
LLP 0175.

## Strengths

- The dead-endpoint falsification test is the strongest piece of evidence in
  either issue: it cleanly separates "traffic never arrived" from "traffic
  arrived and was not recorded", which every observability surface of the
  daemon fails to do. Recording the method, not just the conclusion, means
  it can be rerun after any fix.
- Fix 3 (log every undecodable proxied exchange) is the correct
  generalization; it addresses the class, not the instance, and aligns with
  the repo's Log-Driven Development guidance.
- The scope notes are doing real work: the OAuth ceiling is correctly framed
  as OpenClaw-side scope rather than a HypAware bug, the overlay-routing
  exoneration prevents a future team from re-litigating today's
  misdiagnosis, and the upstream OpenClaw crash report is preserved without
  polluting the issue's own scope.
- The `previous_response_id` open question anticipates a genuinely subtle
  interaction between the future decoder and settlement.

## Concerns

- **[Definitely incomplete] The silence has two layers and the draft names
  only one.** Layer 1: no projector CLAIMED the exchanges at all, because
  attach never writes the `x-hypaware-client: openclaw` header that the
  openclaw projector's `match()` requires (see LLP 0175 review; the openai
  wire shapes match no other projector, claude matches only the anthropic
  signature, codex matches only `/backend-api/codex`). An unmatched exchange
  is dropped with zero trace, that is what produced today's evidence.
  Layer 2: even once matched, the openclaw projector's openai branch parses
  only Chat Completions (`choices`, `chat.completion.chunk` deltas,
  `projector.js` ~lines 650-711); it has no parse for the Responses shape
  (`output`, response event stream). Both layers are real; the draft's fix 1
  addresses layer 2, fix 3 partially addresses layer 1. Resolve by
  restructuring the diagnosis into these two layers and cross-referencing
  the shared header root cause in LLP 0175.
- **[Possibly wrong] The error-shape sub-case is likely the same unmatched
  drop, not error-status handling.** The 400 Chat-Completions exchanges also
  carried no client header, so they too matched no projector; the draft's
  claim that supported-shape error exchanges vanish is therefore untested.
  Resolve by retesting after the header fix: drive a matched exchange to an
  upstream error and observe whether it records. Keep the claim, but marked
  unverified.
- **[Minor] "Zero log lines" was verified against `daemon.log`,
  `daemon.err.log`, and `hyp status` only; dev-telemetry surfaces
  (HYP_DEV_TELEMETRY spans/metrics) were not checked and the daemon runs
  without them in an installed home. Soften to name the surfaces checked.

## Suggestions

1. (Highest priority) Split the diagnosis into the two layers above; move
   the unmatched-exchange silent drop to primary position since it is the
   proven producer of today's evidence and its fix (log + count unmatched
   proxied exchanges) is cheap and shape-agnostic.
2. Add a Verification section: a smoke that (a) sends an unmatched-shape
   exchange through the gateway and asserts a structured
   `unrecognized_exchange` log/metric, and (b) once the decoder lands,
   drives a Responses exchange and asserts projected rows.
3. Add a metric (not just a log) for undecoded/unmatched proxied exchanges,
   so a fleet operator can alert on sustained blind proxying.
4. Consider folding the attach-verification gap ("attached" asserted from
   settings, not traffic) into LLP 0174's scope rather than leaving it
   split across both issues' open questions.

## Open questions

- Fail-closed vs logged passthrough for unrecognized shapes (draft already
  asks; the answer probably differs for marked-client traffic vs unmarked).
- After the header fix, does the gateway need per-upstream capability
  metadata (which paths it can decode) so the attach flow can warn when a
  client's known dialect is undecodable?

## Recommended next step

Revise while still `Draft`: restructure into the two-layer diagnosis, mark
the error-shape claim unverified, and add the verification plan. After
revision, move to `Review` alongside LLP 0175 (they should be reviewed and
accepted as a pair given the ordering constraint). A single AI review is
not sufficient for acceptance under the project's multi-model conventions.
