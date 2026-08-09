# Review of LLP 0175: OpenClaw live captures skip settlement, misattributing and duplicating sessions

**Reviewer:** Claude (Fable 5)
**Date:** 2026-08-03
**Round:** 1
**LLP Status at review time:** Draft

## Overall assessment

The issue is real, well-evidenced, and correctly scoped as a data-integrity
bug with a hard ordering constraint against LLP 0176. The evidence section is
strong enough that a fixer can reproduce the observation from the local cache
alone. However, the review pass located what is very likely the actual root
cause in code, and it is NOT where the draft points: the settle path never
missed, because the openclaw projector never ran at all. The draft should be
revised to carry this finding, which converts fix step 1 ("isolate why the
settle match misses") from an investigation into a one-line-diff diagnosis.

## Strengths

- The evidence section pins both copies of the duplicated exchange with
  session ids, timestamps, attribution, and a rerunnable survey query. This
  is the right bar for an issue doc.
- The full-history aggravator (one unsettled capture replays the entire
  conversation) is called out explicitly; a fixer who only tested single-turn
  sessions would miss it.
- The ordering constraint against LLP 0176 is stated in both docs, in both
  directions, with the reason (decoding without settlement upgrades silent
  non-capture into active corruption). This is the most operationally
  important sentence in either document.
- "Safe operating mode is sweep-only (detached)" gives operators an
  immediate mitigation rather than only a future fix.

## Concerns

- **[Definitely wrong, and fixable] The root-cause section points one layer
  too deep.** `projector.js` (`createOpenclawExchangeProjector`) matches
  exchanges on the `x-hypaware-client: openclaw` request header, and its own
  doc comment says attach injects that header. It does not:
  `attach.js:286` writes `headers: { 'x-hypaware-upstream': upstream }` and
  nothing else. With no client header, `match()` never fires, the claude
  projector (priority 100, matches the shared `/v1/messages` shape) claims
  the exchange, and settlement is never consulted, exactly the observed
  `client_name: claude` + `identity_source: gateway_fallback` rows. The
  draft's framing ("settle.js / match_key.js never matched") sends the fixer
  to the wrong file. Resolve by rewriting the root-cause section around the
  attach/projector header contract mismatch, citing both code sites, and
  keeping the settle-path question only as a residual to verify after the
  header is fixed.
- **[Possibly missing] No remediation for rows already written.** The issue
  is entirely forward-looking; the corrupted session
  (`fbe6c615e2b31ab1`, every row a duplicate) stays in the cache and in any
  fleet-forwarded copies. Resolve by adding a remediation section: identify
  spurious gateway-fallback sessions attributable to this bug and purge or
  re-key them.
- **[Possibly understated] The bug class is wider than OpenClaw.** The
  fallback behavior demonstrated here means ANY anthropic-shaped exchange
  from an unrecognized client (a curl probe, a future client, a
  misconfigured tool) is claimed by the claude projector and attributed as
  claude. The draft's first open question gestures at this; it deserves
  promotion to a named finding, since it corrupts claude analytics
  independently of OpenClaw.

## Suggestions

1. (Highest priority) Rewrite "Root cause" around the missing
   `x-hypaware-client` header; add `@ref`-able citations to
   `projector.js` (CLIENT_HEADER, match()) and `attach.js` (headers write).
2. Add a Verification section: a hermetic smoke that attaches openclaw,
   drives one exchange through the gateway, and asserts (a) `client_name =
   'openclaw'`, (b) settlement onto the native session file id, (c) a
   subsequent sweep writes zero new rows for that turn.
3. Add the remediation subsection for already-written rows.
4. Consider whether `match()` tolerating the header's absence (per the
   projector's own comment, "both tolerate its absence") is still the right
   posture once the header is load-bearing for attribution.

## Open questions

- After the header fix, does the projector's session-hash identity settle
  onto the native session file id at flush time as designed, or is there a
  second latent miss in `settle.js`? (The draft's original question,
  now residual.)
- Should the claude projector require a positive client signal rather than
  claiming any anthropic-shaped exchange by default?

## Recommended next step

Revise while still `Draft`: fold in the header-contract root cause, the
remediation section, and the verification plan. The revision is small and
makes the issue actionable enough to fix immediately. After revision, move
to `Review`; per the project's multi-model review conventions, this single
review is not sufficient for acceptance.
