# LLP 0175: OpenClaw live captures skip settlement, misattributing and duplicating sessions

**Type:** Issue
**Status:** Draft
**Systems:** Plugins, Gateway, Sources
**Author:** Brendan / Claude
**Date:** 2026-08-03
**Related:** LLP 0167, LLP 0170, LLP 0171, LLP 0172, LLP 0176

## Summary

When an OpenClaw exchange is captured live through the gateway (Lane A), the
settlement step that should re-key it onto the OpenClaw session file's native
identity does not match. The exchange lands under a synthetic gateway session
id with `client_name: claude`, and because an Anthropic Messages request
carries the whole conversation, one unsettled capture projects the entire
session history as new rows. The Lane B sweep later imports the same turns
under the true native identity, and with no shared `part_id` between the two
copies the pre-write dedupe has nothing to collapse. Net effect: live capture
actively corrupts the dataset (wrong client, duplicate rows, inflated claude
token totals) instead of improving it.

Observed live on 2026-08-03. Until fixed, the safe operating mode for the
OpenClaw adapter is sweep-only (detached), which loses only latency.

## Evidence

All from the 2026-08-03 investigation on this machine, queryable in the local
cache:

- A live-captured turn ("What is the speed of a horse?", 22:00:25Z) landed as
  session `fbe6c615e2b31ab1`, `client_name: claude`, provider `anthropic`,
  model `claude-sonnet-4-6`. The same turn was later imported by the sweep as
  session `e10e0488-7db5-4875-8b93-ffced3fc59a9`, `client_name: openclaw`.
  Both copies persist; nothing links them.
- The `fbe6c615e2b31ab1` session contains claude-attributed copies of the
  entire OpenClaw conversation history (turns from 12:02 PDT onward), all
  timestamped at the single capture moment, because the request body replayed
  the full conversation and no native identity was available to dedupe
  against.
- Several turns now exist three times: sweep-native (`openclaw`), genuinely
  delegated claude-cli captures (`claude`/`sdk-cli`), and the spurious
  gateway snapshot (`claude`/`fbe6c615e2b31ab1`).
- Post-header-fix capture (22:33:06Z, after `attach.js` began writing
  `x-hypaware-client` and the client re-attached): the exchange was correctly
  claimed as `client_name: openclaw`, but landed under a NEW synthetic
  session `1403b03cbdcf468f` instead of the native
  `e10e0488-7db5-4875-8b93-ffced3fc59a9`, and replayed the full conversation
  history as rows again. This is fix-direction item 2's verification run: the
  header fix is necessary but not sufficient, and the residual is a real
  settle-path miss (`settle.js` / `match_key.js`), now reproducible with
  correctly-claimed input.
- Duplicate survey query used during the investigation:

  ```sql
  select substr(content_text,1,50) as excerpt, count(*) as copies,
         count(distinct session_id) as sessions
  from ai_gateway_messages
  where date = '2026-08-03'
    and (client_name = 'openclaw' or session_id = 'fbe6c615e2b31ab1')
  group by substr(content_text,1,50) having count(*) > 1
  ```

## Impact

- Wrong `client_name` on every live-captured OpenClaw exchange (counted as
  claude usage in any per-client analysis).
- Unbounded duplication: each live-captured turn re-projects the whole
  conversation, so duplicates grow with session length and turn count.
- Token usage double-counting across clients.
- The two-lane contract of LLP 0171/0172 (Lane A and Lane B reconcile onto
  one identity) is silently violated; the same contract holds for the claude
  and codex adapters, so operators reasonably assume it holds here.

## Root cause {#root-cause}

A header-contract mismatch between attach and the exchange projector, found
during round-1 review by reading both sides:

- The openclaw exchange projector matches on the request header
  `x-hypaware-client: openclaw`
  (`hypaware-core/plugins-workspace/openclaw/src/projector.js`,
  `CLIENT_HEADER`, `match()`), at priority 110 precisely so the Claude
  projector (priority 100, same `/v1/messages` shape) cannot claim OpenClaw
  traffic. Its doc comment states attach injects that header.
- Attach never wrote it: `attach.js`'s `providerEntry()` emitted only
  `headers: { 'x-hypaware-upstream': <upstream> }`.

With no client header, the openclaw projector never matches. Anthropic-shaped
exchanges fall through to the Claude projector (observed: `client_name:
claude`, `identity_source: gateway_fallback`), and settlement, which runs on
openclaw-claimed exchanges, is never consulted at all. The settle path
(`settle.js` / `match_key.js`) is therefore UNTESTED rather than broken; it
was starved of input. The same missing header is why OpenAI-shaped exchanges
matched no projector at all, which is LLP 0176's silent-passthrough layer.

The corollary finding: any anthropic-shaped exchange from an unrecognized
client (a curl probe, a future client) is claimed by the Claude projector and
attributed as claude. That default corrupts claude analytics independently of
OpenClaw and deserves its own consideration (see open questions).

## Fix direction {#fix-direction}

1. DONE (with this issue): `attach.js` writes
   `x-hypaware-client: openclaw` alongside the upstream marker in both
   provider entries. Ownership (`isOwnedProviderEntry`) keys on the marker
   alone, so pre-fix entries still detach, and a re-attach over a pre-fix
   entry upgrades it in place (covered by tests in
   `test/plugins/openclaw-attach.test.js`).
2. Verify settlement end-to-end now that the projector can claim exchanges:
   drive one live exchange and assert native-identity settlement plus a
   zero-row sweep afterward (the Tier 2 verification this issue's evidence
   makes reproducible). If settlement holds, this issue closes; if not, the
   residual is a real `settle.js` / `match_key.js` bug of its own.

   RAN 2026-08-03 (the 22:33Z Venus exchange). Result: settlement works
   where content matches - every assistant row settled onto the native
   session and the sweep's dedupe added nothing (single-copy convergence
   verified on `part_id`), and full-history replay does NOT need
   suppression, the designed convergence absorbs it. One residual found
   and FIXED: OpenClaw prepends `[Mon 2026-08-03 15:33 PDT] ` to user
   messages on the wire while the session file stores the bare text, so
   every user turn content-missed and stayed at fallback identity (20
   stray user rows, 0 stray assistant rows). Fix: `match_key.js`
   normalizes the wire-only timestamp prefix out of text identity,
   symmetrically on both builders (`normalizeMatchText`), with match-key
   and settlement tests covering the prefixed-user case.
3. Until (2) passes, treat Lane A as unsafe for OpenClaw: do not recommend
   `hyp attach --client openclaw`, or gate the attach behind the settlement
   verification.
4. Sequencing constraint with LLP 0176: this issue MUST be verified fixed
   before the Responses-API decoder ships. Decoding OpenAI exchanges without
   settlement would extend this duplication to the OpenAI path (Responses
   requests also replay full history), turning silent non-capture into
   active corruption.

## Remediation of rows already written

The forward fix does not clean the cache. Rows written while the bug was
live, on this machine the gateway-fallback session `fbe6c615e2b31ab1`
(2026-08-03, every row a claude-attributed duplicate of a sweep-captured or
sdk-cli-captured turn), should be purged or re-keyed, and the same survey
query in the evidence section identifies equivalents on any other affected
install. Fleet-forwarded copies need the same treatment server-side.

## Non-goals

- The Responses-API recording gap and error-exchange silence are LLP 0176.
- The subscription-OAuth routing ceiling (hardcoded ChatGPT endpoint that no
  config override reaches) is an OpenClaw-side constraint, documented in the
  LLP 0176 scope notes.

## Open questions

- Should the recorder refuse to persist an exchange whose settle match
  misses when the marker header names a client with a registered settle path,
  rather than falling back to another client's attribution?
- Should attach (LLP 0174 context) verify observed traffic and settlement,
  not just settings written, before reporting "attached"?

## References

- LLP 0171 / LLP 0172: the two-lane contract this violates.
- LLP 0170: sweep design (the lane that behaves correctly).
- LLP 0176: recorder wire-shape gaps; carries the fix-ordering constraint.
