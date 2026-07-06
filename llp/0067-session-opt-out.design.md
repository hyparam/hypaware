# LLP 0067: session opt-out — technical design

**Type:** design
**Status:** Active
**Systems:** Gateway, Plugins, Sources
**Generated-by:** neutral
**Date:** 2026-07-06
**Related:** LLP 0066, LLP 0049, LLP 0050, LLP 0051, LLP 0052

> Buildable design for the ephemeral per-session opt-out.
> @ref LLP 0066 [implements] — realizes the session-opt-out spec (control route + session_id drop).
> @ref LLP 0050 [constrained-by] — the drop lives in the client adapters; the gateway stays provider-agnostic.
> @ref LLP 0051 [constrained-by] — promotes the deferred session-opt-out sketch into a built design.
>
> Satisfies [issue #220](https://github.com/hyparam/hypaware/issues/220): the
> `hypaware-ignore` skill's endpoint is finally served. The skill
> (`hypaware-core/plugins-workspace/claude/skills/hypaware-ignore/SKILL.md`) is
> the contract and is **not changed**.

## Overview

Two seams, three change sets. **(1) Gateway:** a new *local control request*
concept — requests under the reserved `/_hypaware/` prefix are handled
in-process, never proxied — serving `POST` / `DELETE /_hypaware/ignore/session`
over an in-memory `Set<string>` of opaque session ids
([LLP 0066 R1–R3](./0066-session-opt-out.spec.md#requirements)). **(2)
Adapters:** the Claude and Codex exchange projectors test their own resolved
`session_id` against that set and return the existing terminal
`USAGE_POLICY_DROP` sentinel (R4, R5) — the same seam `.hypignore` uses
([LLP 0050](./0050-ignore-enforced-in-adapters.decision.md),
[LLP 0052 §enforcement](./0052-hypignore-usage-policy.design.md#enforcement)).
**(3) Tests** covering the R8 matrix. Nothing touches the cache schema, the
recorder, backfill, or the skills.

## Gateway control path {#control-path}

Today `ai-gateway/src/source.js` compiles only an *upstream* routing table and
`proxy.js` treats every inbound request as proxiable: `handleRequest` goes
straight to `matchUpstream` and 404s or forwards. A catch-all upstream
(`path_prefix: "/"`) would ship a `POST /_hypaware/ignore/session` to a real
provider. So the control check must run **before** upstream matching (R2).

`proxy.js handleRequest` gains a short-circuit at the top:

```js
// @ref LLP 0066#control-path [implements] — the reserved /_hypaware/ prefix is
// a LOCAL control surface: handled in-process, never matched against upstreams,
// never proxied. Checked BEFORE matchUpstream so a catch-all upstream cannot
// leak a control request to a provider.
if (isControlPath(parsedUrl.pathname)) {
  req.resume()
  if (opts.onControlRequest) return opts.onControlRequest(req, res, parsedUrl)
  return sendJson(res, 404, { error: 'no control handler registered' })
}
```

- `isControlPath(p)` = `p === '/_hypaware' || p.startsWith('/_hypaware/')` —
  same segment-boundary discipline as `pathMatchesPrefix`.
- `ProxyOptions` (`ai-gateway/src/types.d.ts`) gains
  `onControlRequest?(req, res, url): void`. `proxy.js` stays single-purpose
  network code; the actual route logic lives in a new module (below).
- Control requests **never start an exchange**: no `recorder.startExchange`,
  no `onExchangeFinished`, no row — the opt-out request itself is not recorded
  and does not appear in `ai_gateway_messages`.
- The prefix is reserved for this and future control endpoints; unknown
  `/_hypaware/*` paths get a local 404, never a proxy attempt.

## Control routes: `ai-gateway/src/control.js` (new) {#endpoints}

`createControlHandler({ ignoredSessions, log })` returns the `onControlRequest`
callback. One route in V1:

| Method | Path | Effect |
|---|---|---|
| `POST` | `/_hypaware/ignore/session` | add `session_id` to the set |
| `DELETE` | `/_hypaware/ignore/session` | remove `session_id` from the set |

- Body: JSON `{"session_id": "..."}` (the skill sends exactly this). Read with
  a small size bound (64 KiB → 413); malformed JSON or a missing/empty/
  non-string `session_id` → 400. Other methods on the route → 405; any other
  `/_hypaware/*` path → 404.
- Both verbs are idempotent by `Set` semantics (R1): re-POSTing an ignored id
  or DELETEing an unknown id is a 200 no-op.
- Response (both verbs): `{ "session_id": "...", "ignored": <bool>, "total": <int> }`
  — the skill reads `.total`; `ignored` reports current membership.
- The gateway never interprets the id: it is an opaque token
  ([LLP 0066 §enforcement](./0066-session-opt-out.spec.md#enforcement)). No
  parsing of provider bodies or headers happens here, so
  [LLP 0050](./0050-ignore-enforced-in-adapters.decision.md) is untouched.

## The ignored-session set and its lifetime {#set}

```js
// api.js createGatewayState() — one per plugin activation (index.js activate())
// @ref LLP 0066#ephemeral — in-memory only: no file, no cache column; dies with
// the daemon process. Lives on GatewayState (NOT per-listener) so a config
// reload() — which tears down and relaunches the listener (source.js) — does
// not silently re-enable recording mid-session.
ignoredSessions: /** @type {Set<string>} */ (new Set()),
```

Placement is the one judgment call R3 leaves open: `source.js reload()`
rebuilds the listener on config change, and a per-listener set would drop
opt-outs on every reload — a silent privacy leak the user never asked for
(same failure shape as the resolver-cache leak LLP 0052 §matcher fixed).
`GatewayState` is created once in `activate()` (`ai-gateway/src/index.js`) and
lives exactly as long as the daemon process, which is what the skill's
"gateway restart drops the entry" note describes. Restart-drops-state stays
true (R3); reload does not count as a restart.

`status()` in `source.js` adds `ignored_sessions: state.ignoredSessions.size`
to `details` so an operator can see a live opt-out without grepping logs.

## Threading membership to the adapters {#predicate}

The drop is the adapter's (R4), but the set is gateway memory. The bridge is a
read-only predicate on the projector context — the gateway hands adapters a
membership test, never an id it resolved itself:

- `AiGatewayExchangeProjectorContext` (`hypaware-plugin-kernel-types.d.ts`)
  gains `isSessionIgnored?(sessionId: string): boolean`.
- `createAiGatewayMessageProjector(opts)` (`message_projector.js`) accepts
  `isSessionIgnored` and `dispatchProjector` folds it into the ctx it already
  builds (today `{ log }`). Absent → defaults to `() => false`, so backfill
  materialization and existing unit-test stubs are unaffected.
- `source.js launchListener` supplies
  `isSessionIgnored: (id) => state.ignoredSessions.has(id)`.

This keeps the LLP 0050 boundary exact: the gateway holds opaque tokens and
answers a set-membership question; only the adapter knows which wire/body
field is the canonical `session_id`.

## Adapter drop: keyed on the resolved `session_id` {#drop}

Both adapters already return `USAGE_POLICY_DROP`
(`src/core/usage-policy/drop.js`) for the `.hypignore` cwd match; the
dispatcher already treats it as terminal and logs `aigw.usage_policy_drop`
instead of a `no_projector_match` miss (`message_projector.js
dispatchProjector` / `projectExchange`). The session drop adds a **second
independent match key feeding the same sentinel** (R7: either match
suppresses; the checks do not merge or interact).

### Claude — `claude/src/projector.js`

The canonical id is resolved at `resolveClaudeSessionId(reqBody, headers)`
(body-first `metadata.user_id.session_id`, falling back to the
`x-claude-code-session-id` header). The check goes immediately after that
resolution — before session-context/transcript loading, so an ignored
exchange does no fs work:

```js
const sessionId = resolveClaudeSessionId(reqBody, headers)
// @ref LLP 0066#enforcement [implements] — session opt-out drop, keyed on the
// SAME resolved session_id the row is stamped with (R5): when present,
// resolveAnthropicConversationId returns exactly this value as the session_id
// column, and the hash fallback it uses otherwise can never be in the set (the
// skill only ever submits a real CLAUDE_CODE_SESSION_ID).
// @ref LLP 0050 — second match key, same adapter seam as the .hypignore drop.
if (sessionId && ctx.isSessionIgnored?.(sessionId)) {
  ctx.log.info('plugin.claude.usage_policy_drop', {
    component: 'claude',
    operation: 'usage_policy_drop',
    policy_source: 'session_opt_out',
    session_id: sessionId,
    exchange_id: input.exchange_id,
  })
  return USAGE_POLICY_DROP
}
```

For Claude `session_id == the conversation`
([LLP 0066 §scope](./0066-session-opt-out.spec.md#scope)), so the drop is
exact. The existing cwd `.hypignore` check stays where it is, unchanged.

### Codex — `codex/src/exchange-projector.js`

The stamped id is `stringValue(codexContext?.session_id) ?? conversationId`
(today computed *after* message building). `resolveConversationId(reqBody,
input, provider, path, codexContext)` needs nothing from the built messages,
so the `conversationId` / `sessionId` resolution **hoists above**
`messagesForTransport` and the check runs on the exact value the row would be
stamped with (R5), next to the existing cwd check:

```js
// @ref LLP 0066#enforcement [implements] — session opt-out drop. Keyed on the
// stamped session_id (metadata.session_id ?? thread id). NOTE the documented
// over-drop (LLP 0066#scope): one Codex session_id contains multiple
// conversation_id threads, so an ignored session suppresses ALL of them.
// Per-thread grain is a spec non-goal.
if (ctx?.isSessionIgnored?.(sessionId)) { /* log + return USAGE_POLICY_DROP */ }
```

Log shape mirrors Claude: `plugin.codex.usage_policy_drop` with
`policy_source: 'session_opt_out'` and the matched `session_id` (a UUID, not
customer content — unlike `cwd`, which stays hashed in the `.hypignore` drop
logs).

### What is deliberately not covered

- **Live LLM call untouched (R6):** the drop runs at projection time, after
  the response has streamed; only persistence is suppressed — structurally
  identical to the `.hypignore` drop (LLP 0052 §live).
- **Backfill:** the set is gateway memory; `hyp backfill` is a separate
  process reading local transcripts, so an opted-out session that Claude/Codex
  still wrote to disk **is re-imported by a later backfill**. This is the
  ephemerality contract, not a defect
  ([LLP 0066 §ephemeral](./0066-session-opt-out.spec.md#ephemeral), non-goal 2
  — no persistence): the durable mechanism is `.hypignore`. Recorded here so
  nobody "fixes" it by persisting the set.
- **Raw-proxy / OTEL traffic:** no adapter, no resolved `session_id`, so no
  session drop — the same structural blindness as `.hypignore`
  ([LLP 0050 §why-not-the-gateway](./0050-ignore-enforced-in-adapters.decision.md)).

## Test plan {#tests}

Traditional tests (root `test/`, alongside the existing suites):

- `test/plugins/ai-gateway-control-route.test.js` (new): POST adds +
  idempotent re-POST, DELETE removes + idempotent, `.total` correct across a
  sequence; 400 malformed/missing `session_id`; 405 wrong method; 404 unknown
  `/_hypaware/*` path; oversized body 413.
- `test/plugins/ai-gateway-proxy-routing.test.js` (extend): with a catch-all
  (`/`) upstream configured, `/_hypaware/ignore/session` is handled locally
  and never forwarded (R2); no exchange is started for a control request.
- `test/plugins/ai-gateway-message-projector.test.js` (extend): dispatcher
  passes `isSessionIgnored` through ctx; default predicate is false.
- `test/plugins/claude-usage-policy-drop.test.js` (extend): resolved session
  in set → `USAGE_POLICY_DROP` + drop log with
  `policy_source: 'session_opt_out'`; not in set → rows unchanged — Claude
  session == conversation (R8).
- `test/plugins/codex-exchange-projector.test.js` (extend): two
  `conversation_id` threads under one ignored `session_id` → **both** dropped
  (documents the over-drop, R8); a different session in the same run is
  unaffected.
- Independence matrix (R7): `.hypignore`d cwd + session not in set → drop;
  clean cwd + session in set → drop; both → drop; neither → rows.
- Restart/reload semantics (R3): a fresh `GatewayState` starts empty
  (restart-drops-state, R8); the set survives a `reload()` (listener rebuild
  with the same state).

Hermetic smoke (`hypaware-core/smoke/flows/session_optout_capture_drop.js`,
mirroring `hypignore_capture_drop.js`): boot the daemon, `POST` an ignore for
a fixture session id, drive one exchange with that session id and one with a
different id — assert only the clean row lands, the drop telemetry
(`aigw.usage_policy_drop` + adapter `usage_policy_drop` with
`policy_source: 'session_opt_out'`) is emitted, then `DELETE` and assert
recording resumes. Stable `DEV_RUN_ID` / `smoke_step` per the log-driven house
rules.

## Annotation map (for the implementing change set)

| Site | Annotation |
|------|-----------|
| `ai-gateway/src/proxy.js` control short-circuit | `@ref LLP 0066#control-path [implements]` |
| `ai-gateway/src/control.js` route handler | `@ref LLP 0066#control-path [implements]` |
| `ai-gateway/src/api.js` `ignoredSessions` on `GatewayState` | `@ref LLP 0066#ephemeral` |
| claude/codex projector session drop | `@ref LLP 0066#enforcement [implements]` (alongside the existing `@ref LLP 0050` at the same seam) |
| smoke `session_optout_capture_drop` | `@ref LLP 0066#requirements [tests]` |
