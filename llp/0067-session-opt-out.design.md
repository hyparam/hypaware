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
| `GET` | `/_hypaware/ignore/session?session_id=<id>` | report membership; mutates nothing |
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

### The read route {#status-endpoint}

`GET` carries the id in the query string rather than a body, because a read has
no body. `URLSearchParams` on both ends round-trips the token byte-exactly, so
the R5 raw-token discipline (the route stores and looks up the id **verbatim**,
never trimmed or normalized) holds for reads exactly as it does for writes.
A missing or blank `session_id` is a 400; the response shape is the same
`{ session_id, ignored, total }` all three verbs return, so one client parser
serves the whole route.

`GET` joins `allow: GET, POST, DELETE` on the 405 path.

@ref LLP 0066#readable [implements]: a privacy control that can only be
written cannot be verified. Adding the reader is what turns both fail-open
transitions (restart, changed session id) from silent into detectable.

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

## The CLI surface: `hyp session ignore` / `unignore` / `status` {#cli}

The gateway plugin owns `/_hypaware/ignore/session`, so it owns the verbs over
it ([LLP 0003](./0003-core-vs-plugin-surface.spec.md)):

```
hyp session ignore   [session-id] [--json]   # POST
hyp session unignore [session-id] [--json]   # DELETE
hyp session status   [session-id] [--json]   # GET
```

Deliberately **not** `hyp ignore --session`:
[LLP 0110](./0110-hyp-policy-verb.issue.md) diagnosed exactly that shape
("the verb no longer names the action, it names the store the flag writes to")
and left bare `hyp ignore <path>` as the honest `.hypignore` dotfile author.
As a plugin-contributed group, `hyp session` also inherits LLP 0098/0099's
inactive-plugin `repair:` line when the gateway is not in the active config.

One client-agnostic verb group replaces per-client skill bodies: the Codex
plugin ships no `hypaware-ignore` skill, so before this verb a Codex user had
working enforcement and no front door.

### Exit codes make the fail-closed distinction machine-readable {#exit-codes}

`hyp session status` is a gate, not a pretty-printer, so the three answers get
three codes:

| Code | Meaning |
|---|---|
| `0` | confirmed **ignored** - the gateway is dropping this session |
| `1` | confirmed **not ignored** - this session is being recorded |
| `2` | usage error |
| `3` | **unknown** - the check could not be completed |

`--json` reports `status` as one of `ignored`, `not_ignored`, `unknown`, with
`ignored: true | false | null`. `null` is load-bearing: an unreachable gateway
must never render as `false`
([LLP 0066 R10](./0066-session-opt-out.spec.md#requirements)). Every output
mode also names `hyp policy show` as the folder governor this verb does not
cover (R11 / R7).

### The answer is validated before it is believed {#cli-response-check}

Reaching *something* on the resolved endpoint is not the same as reaching the
gateway. Both discovery paths below can land on a port another local process
now owns: a pinned `listen` whose gateway is gone, or a recycled ephemeral
port. So a `200` is not evidence on its own. The client accepts a control
response only when

- it is a JSON object (not an array, not a scalar),
- `ignored` is a real boolean and `total` a real number, and
- `session_id` comes back **byte-identical** to the token sent - the route
  echoes it verbatim (R5), so a mismatch means the reply describes a different
  session.

Anything else is `unknown` ([LLP 0066 R10](./0066-session-opt-out.spec.md#requirements)).
Without this, `200 {}` from an unrelated listener reads as "`ignored` is
absent, therefore `false`" - a confident answer nothing established - and
`200 {"session_id":"other","ignored":true}` reads as "you are covered", which
is the same fail-open shape in the more dangerous direction. The mutation verbs
apply the identical check, so `hyp session ignore` cannot print a success it
did not get.

### Endpoint resolution: disk, then config, never a guess {#cli-endpoint}

The daemon's live bound port from `status.json` wins
([LLP 0086](./0086-attach-tracks-ephemeral-port.decision.md), liveness-gated), a
pinned `listen` is the fallback, and "nothing resolvable" is an error - not the
stale hardcoded `http://127.0.0.1:8787` the skill bodies still carry (#431).
Under LLP 0114 an unpinned gateway may bind an ephemeral fallback port, so only
the running daemon knows the proven one.

### Session-id resolution {#cli-session-id}

An explicit argument wins. Otherwise `CLAUDE_CODE_SESSION_ID` (for Claude the
session *is* the conversation, so a stated id is already the drop key).
Otherwise Codex, where the answer has to be assembled from two sources because
neither one carries it alone:

| source | states | does not state |
|---|---|---|
| `CODEX_THREAD_ID` in the environment | which **thread** is running now | the session containing it |
| the rollout's first `session_meta` line | `payload.session_id` (the **container**), `payload.id` (the thread), `payload.cwd` | whether that session is still live |

So `CODEX_THREAD_ID` is used as a **selector, not an answer**: it names the live
thread, the rollout recording that thread is looked up by `payload.id`, and the
container is read out of it. Absent the variable (an old Codex, or a hand
invocation from a terminal), the rollout is selected by matching `payload.cwd`
against the invocation cwd instead, and the staleness bound below stands in for
the liveness the environment would have given.

#### The answer is the container, never the thread {#cli-drop-key}

Settled by [issue #453](https://github.com/hyparam/hypaware/issues/453). The
drop matches the `session_id` the adapter stamps
([LLP 0066 §scope](./0066-session-opt-out.spec.md#scope), R5), which for Codex is
the session container. A thread id is the same uuid on a **root** thread and a
different one on a **subagent** thread, so resolving to a thread id is a control
that works everywhere it is casually tested and silently does nothing where it
matters: `hyp session ignore` from inside a subagent tool call printed "the
gateway will drop this session" for an id the gateway never sees.

**Liveness versus the correct key.** `CODEX_THREAD_ID` is the better *liveness*
signal (Codex sets it on the process it spawns for a tool call, so a finished
thread cannot have set it, where mtime is only a proxy), but it is the *wrong
grain*. The resolution keeps both by splitting their jobs, as above: the variable
picks the rollout, the rollout supplies the key. Where only one of the two can be
had, the key wins and the verb refuses - a refusal costs the user a re-run with
an explicit id, whereas a confident wrong key costs them the recording they
believed they had stopped.

#### `session_id` absent is unresolvable, NOT the thread id {#cli-legacy-rollout}

The trap in the same issue. Codex's `SessionMetaLine` has a hand-written
`Deserialize` that **back-fills `session_id` from `id`** when the field is
absent, so a pre-field rollout parses cleanly and hands back the *thread* id
under the name `session_id`. Any reader that trusts a deserialized
`session_meta` therefore reintroduces the wrong key on exactly the files where
nothing else would reveal it.

The resolver reads the **raw JSONL line** for this reason: an absent field is
visible as absent, and absent means **refuse** (R13). It does not fall back to
the thread id, and it does not fall back to the cwd scan when a stated thread's
rollout cannot be read - that scan answers about a thread nothing tied to this
invocation, and the stated thread has already said it would be the wrong one.
The refusal names the file, says why a thread id will not do, and points at
`hyp session status <session-id>`.

`codex/src/backfill.js` reads the same field for the partition key, so both
ingestion paths key on one identifier
([§backfill-partition-key](#backfill-partition-key)).

**Two clients each stating one refuses.** Environments nest (Codex runs
`claude`, or the reverse) and the child inherits the parent's variable while
setting its own, so `CLAUDE_CODE_SESSION_ID` and `CODEX_THREAD_ID` can both be
set at once while only one names the session this invocation is in. Preferring
either is a guess that is wrong half the time.

**It refuses on ambiguity** - several cwd-matching rollouts, or none - with a
nonzero exit naming the candidates, rather than taking newest-by-mtime the way
the `hypaware-privacy` skill body does. Guessing here would opt out the wrong
session while telling the user they are covered: the same fail-open shape this
change exists to remove.

The rollout walk is bounded so a very large history cannot turn a privacy check
into a long directory scan. **A truncated walk also refuses**: "exactly one cwd
match" over a partial listing is an artefact of the bound, not a fact, since
the rollout that would have made it ambiguous may be one of the files never
looked at. Truncation is therefore reported and treated as unresolvable rather
than resolved on partial evidence. It is *not* fatal on the stated-thread path
when the thread was found: that match is an identity test on a value the client
stated, not a uniqueness claim over the listing, so a file never read cannot
invalidate a hit.

**A single STALE match refuses too**, on the cwd path only - a stated thread
needs no age bound, because the thread that set the variable is the one running
now. The ambiguity rule only fires at two or
more matches, so a cwd where Codex ran exactly once, days ago, has exactly one
match and would otherwise resolve confidently to a **dead** session id. That is
the wrong-session failure of [§cli-response-check](#cli-response-check) arriving
through the other input: `hyp session ignore` would opt out the dead id, print
"the gateway will drop this session", and the session the user is actually in
would keep being recorded. A rollout is therefore only usable as "the session I
am in" when it was written to recently (30 minutes): a running Codex session
appends on every turn, and the tool call invoking `hyp` is itself preceded by
rollout writes, so the legitimate case is seconds-to-minutes old. A stale-only
match is an error naming the file and its age, with the explicit-id escape
hatch, exactly like the ambiguous case.

The bound narrows the window; it does not close it. A session that ended a few
minutes ago is still within it, and mtime is a proxy for liveness rather than
proof of it. `CODEX_THREAD_ID` closes it for the path that matters (a `hyp` run
from inside a Codex tool call, which is how the privacy skills invoke it): a
stated thread is selected first, so the proxy is never consulted. What remains is
the residual for the cwd path only - an old Codex, or a hand invocation from a
terminal - and it stays handled by making the inference **visible** rather than
silent. The stated path has a narrower residual of its own: a process that
OUTLIVES its spawn (a server or `tmux` pane started from a tool call) inherits
the variable and keeps it after the thread ends, so the claim to make there is
"proof of provenance", not "proof of liveness".

### The verb reports the provenance of its own inputs {#cli-provenance}

An `ignored: true` rests on two claims the verb cannot always prove: *this is my
session id*, and *that endpoint is the gateway*. An explicit argument or
`CLAUDE_CODE_SESSION_ID` **states** the first; a Codex rollout only **infers**
it. A live daemon's `status.json` proves the second; a pinned `listen` only
asserts it, and [§cli-response-check](#cli-response-check) can prove the
responder saw our token but not that it is the gateway.

So the weaker evidence is named next to the answer, in every output mode:
`--json` carries `session_id_source` / `session_id_evidence` (the rollout
filename) and `endpoint_source`; the human form prints the id as `INFERRED
from <rollout>` and flags an endpoint that came from a pinned `listen` rather
than a live daemon. The write verbs print it too, where "ignored" reads as done.

This is the change's own thesis turned on its weakest inputs: a privacy control
that can be wrong must at least say where it could be wrong, so a user who is
handed the wrong session can *see* it instead of discovering it in the cache.

**The Codex answer also discloses its grain, and both ids.** The id acted on is
the session container, which is coarser than the thread the user is in
([§cli-drop-key](#cli-drop-key)), so `--json` reports `thread_id` beside
`session_id` and the human form says the drop covers every thread in the session,
sibling and subagent threads included. Two reasons, both learned from #453:
reporting one id and calling it "the session" is how the two got conflated in the
first place, and a user who asked to stop recording "this conversation" is owed
the fact that it stopped more than that. The `codex_env_rollout` source names the
split explicitly - Codex stated the thread, the container had to be read from
that thread's rollout - so nobody has to guess which half came from where.

### Backfill keys on the same identifier {#backfill-partition-key}

`codex/src/backfill.js` used to stamp `session_id` and `conversation_id` from the
one value it had, the rollout id, on the premise that "the rollout carries no
distinct session id". Current Codex writes `session_meta.session_id` beside
`session_meta.id`, so the premise expired: backfill reads the container for
`session_id` and keeps the thread in `conversation_id`, matching what the live
projector stamps from `metadata.session_id`
([LLP 0030](./0030-session-id-partition-key.decision.md) decision 1).

This is a correctness requirement for the opt-out, not tidiness (R13): if the two
paths disagreed, "the session id" would name two different things depending on
how a row arrived, and the id `hyp session ignore` reports would be right for one
of them and wrong for the other. A rollout with no container recorded still falls
back to the thread id, which is all such a file can support - and is why the CLI
resolver refuses on those rather than acting on a key it cannot establish
([§cli-legacy-rollout](#cli-legacy-rollout)).

Row identity is untouched: the fallback-hash and prior-message scope is
`conversation_id ?? session_id` (LLP 0030 decision 3), and `conversation_id`
still holds the thread, so backfilled `part_id`s are unchanged and keep deduping
against live rows.

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
  sequence; 400 malformed/missing `session_id`; 405 wrong method (`allow:
  GET, POST, DELETE`); 404 unknown `/_hypaware/*` path; oversized body 413.
- `test/plugins/ai-gateway-session-status.test.js` (new, R9-R12): `GET`
  reports membership and round-trips the token verbatim; a fresh (restarted)
  set reports `ignored: false` where before the transition was unobservable;
  `hyp session status` distinguishes ignored / not_ignored / unknown, reports
  `ignored: null` and a nonzero exit for an unreachable gateway, an
  unresolvable endpoint, and an unresolvable session id, and always names
  `hyp policy show`; the Codex rollout resolver picks the unique cwd match and
  refuses when several, none, a truncated scan, or a **single stale** match
  (backdated mtime), while the same rollout still resolves under a wider age
  bound so the refusal is provably about staleness and not the cwd match.
  [§cli-provenance](#cli-provenance): a disk-inferred id reports
  `session_id_source: 'codex_rollout'` plus the rollout filename in `--json`
  and `INFERRED from <rollout>` in the human form, from `status` and `ignore`
  alike, and a pinned-`listen` endpoint reports `endpoint_source:
  'config_listen'`. `--` ends flag parsing, so a session id beginning with `-`
  is reachable at all. An oversized response is cut off AT the byte bound
  rather than buffered whole. A rogue local listener on
  the resolved port covers [§cli-response-check](#cli-response-check): a `200`
  with no boolean `ignored`, no numeric `total`, a non-object body, an
  unparseable body, a non-200, and a reply about a different `session_id`
  (including `ignored: true`) all report `unknown`, and `hyp session ignore`
  against the same responder reports no success.
  [§cli-drop-key](#cli-drop-key) (R13, issue #453) is pinned against the code
  that performs the drop, not against a restated string: a **subagent-shaped**
  rollout (root `session_id` != own `payload.id`) resolves the container on both
  the stated-thread and cwd paths, that id makes
  `codex/src/exchange-projector.js` return `USAGE_POLICY_DROP` for a subagent
  turn, and the thread id it used to state does **not** - the silent no-op, held
  in the test so it cannot come back. A **legacy** rollout with no `session_id`
  field refuses on both paths ([§cli-legacy-rollout](#cli-legacy-rollout)) while
  the same thread in a rollout that records a container resolves, so the refusal
  is provably about the absent field; `hyp session ignore` on it prints nothing
  that reads as done, exits `unknown`, and adds nothing to the set. A stated
  thread with no rollout refuses instead of falling back to the cwd scan; a blank
  variable falls through; both client variables set at once refuses and names
  both. The grain disclosure reports `thread_id` beside `session_id` in `--json`
  and names the whole-session scope in the human form, from `status` and `ignore`
  alike.
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
- `test/plugins/codex-backfill.test.js` (extend,
  [§backfill-partition-key](#backfill-partition-key)): a subagent rollout
  partitions on `session_meta.session_id` with the thread in
  `conversation_id`, through the real materializer to the row columns; a rollout
  with no `session_id` field keeps the thread as its partition key, since that is
  all such a file records.
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
| `ai-gateway/src/control.js` `GET` read branch | `@ref LLP 0066#readable [implements]` |
| `ai-gateway/src/session_command.js` fail-closed CLI reader | `@ref LLP 0066#readable [implements]` / `@ref LLP 0067#cli [implements]` |
| `ai-gateway/src/session_command.js` `resolveSessionIdForCli` | `@ref LLP 0067#cli-session-id [implements]` (the drop key, ambiguity, truncation, staleness) |
| `ai-gateway/src/session_command.js` `readRolloutMeta` | `@ref LLP 0067#cli-session-id [implements]` (raw line, so an absent `session_id` is not the back-filled thread id) |
| `codex/src/backfill.js` `buildSession` / `projectedExchangeFromSession` | `@ref LLP 0030#decision [implements]` (container in `session_id`, thread in `conversation_id`) |
| `ai-gateway/src/session_command.js` `provenanceNotes` | `@ref LLP 0066#readable [implements]` / `@ref LLP 0067#cli-provenance [implements]` |
| `ai-gateway/src/index.js` `session` verb group | `@ref LLP 0067#cli [implements]` |
| `ai-gateway/src/api.js` `ignoredSessions` on `GatewayState` | `@ref LLP 0066#ephemeral` |
| claude/codex projector session drop | `@ref LLP 0066#enforcement [implements]` (alongside the existing `@ref LLP 0050` at the same seam) |
| smoke `session_optout_capture_drop` | `@ref LLP 0066#requirements [tests]` |
