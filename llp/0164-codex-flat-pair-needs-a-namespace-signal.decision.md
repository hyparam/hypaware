# LLP 0164: a Codex user-agent may name the client, not key the row

**Type:** Decision
**Status:** Active
**Systems:** Plugins, Sources, Gateway
**Author:** Claude
**Date:** 2026-07-31
**Related:** LLP 0030, LLP 0083, LLP 0141, LLP 0151

> Carries the two deferred review findings from
> [LLP 0151](./0151-codex-lineage-from-body-client-metadata.decision.md)'s
> implementing PR (#467, follow-up issue #473). LLP 0151 is Active and
> immutable, so the tightening and the factual correction land here as new
> findings that ref it, not as edits to it.

## Context

LLP 0151 moved Codex lineage off header names onto the request body's flat
`client_metadata` map, and gated the map's non-Codex-exclusive `session_id` +
`thread_id` pair on the transport having already identified the exchange as
Codex ([#body-is-a-codex-signal](./0151-codex-lineage-from-body-client-metadata.decision.md#body-is-a-codex-signal)).
The predicate it gated on, `hasCodexTransportSignal`, answered four signals: the
`chatgpt` upstream, the `/backend-api/codex/` route namespace, an `x-codex-*`
compatibility header, and a `codex`-prefixed user-agent product.

Two findings against that shape, both raised on the PR and deferred as
non-blocking:

1. **One of the four signals is a naming convention, not a namespace.** A
   forged `user-agent: codex_cli_rs/1.0` plus a body `client_metadata` carrying
   only the flat pair satisfied the predicate, and the pair then dictated
   `conversation_id` and `session_id`, the latter being the partition key
   ([LLP 0030](./0030-session-id-partition-key.decision.md)). The other three
   signals need Codex's proprietary route or header vocabulary; the user-agent
   needs only a product string any process on the machine can copy. This is
   residual rather than introduced: the pre-LLP-0151 projector let the same
   user-agent reach a header fallback with no body gate at all, so LLP 0151 was
   already a net tightening. It is worth closing anyway because the value it
   steers is a privacy-adjacent partition key in a traffic-capture product.
2. **The header audit overstated its case.** LLP 0151
   [#real-header-names](./0151-codex-lineage-from-body-client-metadata.decision.md#real-header-names)
   records `thread-id`, `session-id` and `parent-thread-id` as names no Codex
   version emits. Two of the three are real on paths the audit did not reach.

## Decision

<a id="flat-pair-corroboration"></a>**"May be called Codex" and "may have its
flat identity pair trusted" are two predicates, and the user-agent answers only
the first.** The loose predicate keeps all four signals and keeps deciding
`client_name`, `client_version` and whether a codex context resolves at all: a
description of the client, revisable on the next row, costing nothing if wrong.
The strict predicate is the three Codex-namespaced signals only (`chatgpt`
upstream, `/backend-api/codex/` namespace, `x-codex-*` header), and it alone
corroborates a `client_metadata` map that carries no `x-codex-*` key of its own.
An identity is not revisable: it clusters rows on disk (LLP 0030 §Breaking) and
scopes the fallback `message_id`, so it may rest only on a name the client had
to learn from Codex rather than one it could guess from a release note.

Real Codex loses nothing today. Its map carries `x-codex-installation-id` and
`x-codex-window-id` on every request (LLP 0151
[#context](./0151-codex-lineage-from-body-client-metadata.decision.md#context)),
which is the self-naming branch and never needed corroboration. The accepted
cost is narrow and deliberate: a hypothetical future Codex build that stops
writing any `x-codex-*` map key, sends no compatibility header, posts to a
generic path, and is therefore reachable only by user-agent, loses lineage until
this file is updated. That build would already be a version drift LLP 0151 exists
to make visible, and it surfaces as an absent `lineage_source`
([#lineage-source](./0151-codex-lineage-from-body-client-metadata.decision.md#lineage-source))
rather than as silence.

Rejected: dropping the user-agent from the loose predicate too. It is good
enough to label a client and it is the only signal the API-key route's generic
`/v1/responses` carries when the body map is absent, so removing it would cost
real capture to buy nothing, since labelling was never the exposure.

<a id="header-audit-correction"></a>**Correction to LLP 0151's header audit:
`session-id` and `thread-id` are real Codex header names on two paths.**
`codex-rs/codex-api/src/requests/headers.rs::build_session_headers` inserts
headers literally named `session-id` and `thread-id`. It has two call sites in
`codex-rs/core/src/client.rs`: `compact_conversation_history` (the
`/responses/compact` endpoint, which HypAware's `isOpenAiResponsesPath` matches)
and `build_websocket_headers` (the `stream_responses_websocket` handshake). So
LLP 0151's "nothing emits them" is wrong for those two paths. It stands for
`parent-thread-id`, which remains a name nothing produces and was simply the
wrong spelling of `x-codex-parent-thread-id`, and it stands for the primary HTTP
turn-streaming path (`build_responses_request` / `stream_responses_api`), which
is the path essentially all ordinary Codex traffic uses.

**The projector still does not read them, and that stays right.** The
correction is to the justification, not to the decision. The compaction requests
that carry the two headers are `CodexResponsesRequestKind::Compaction`, which
Codex marks `has_turn_identity = true`, so their `x-codex-turn-metadata` blob
independently states the same `session_id` and `thread_id` that
`readCodexTurnMetadata` already reads. `Memory` requests (`summarize_memories`)
state identity on no surface at all by Codex's own design, so there is nothing
for any reader to find. Reading the two bare names would therefore add no id
HypAware does not already have, while reopening exactly what LLP 0151 closed:
they are unnamespaced names any proxy hop or hand-rolled client may set, and a
wrong value there dictates row identity. The audit row's verdict ("removed")
survives its stated reason being corrected.

The websocket handshake was not investigated further. HypAware's HTTP-proxy
gateway model does not surface it as a request/response exchange, so no
projector path reads its headers either way.

## Consequences

- `hasCodexTransportSignal` is now the union of `hasCodexNamespaceSignal` and
  the user-agent branch, and only the narrow one is passed to
  `readCodexClientMetadata`. That single argument is the whole of the split.
- Row identity does not move for any shape HypAware has recorded from real
  Codex traffic, because every such request either carries an `x-codex-*` map
  key or arrives on a namespaced route. The pinned-literal identity test in
  `test/plugins/codex-exchange-projector.test.js` is unchanged and still passes.
- A user-agent-only exchange whose map states only the flat pair now records the
  content-hash fallback identity and no `lineage_source`, and is still stamped
  `client_name: 'codex'`. That asymmetry is the decision, so it is asserted as
  one test with both halves rather than two tests.
- LLP 0151 gains `Extended-by` forward-refs at the two affected sections. Its
  text is otherwise untouched.

## References

- Code: `hypaware-core/plugins-workspace/codex/src/exchange-projector.js`
  (`hasCodexNamespaceSignal`, `hasCodexTransportSignal`,
  `readCodexClientMetadata`, `resolveCodexContext`).
- Tests: `test/plugins/codex-exchange-projector.test.js` (the user-agent
  asymmetry, and the namespace-corroborated flat-pair case).
- [LLP 0151](./0151-codex-lineage-from-body-client-metadata.decision.md) - the
  decision this extends and corrects.
- [LLP 0030](./0030-session-id-partition-key.decision.md) - why an identity is
  not revisable the way a client label is.
