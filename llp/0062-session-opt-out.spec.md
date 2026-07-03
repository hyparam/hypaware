# LLP 0062: ephemeral per-session opt-out

**Type:** Spec
**Status:** Accepted
**Systems:** Gateway, Plugins, Sources
**Author:** Brendan / Claude
**Date:** 2026-07-03
**Related:** LLP 0016, LLP 0030, LLP 0049, LLP 0050, LLP 0051

> "Don't record *this conversation*": a temporary, in-memory, session-scoped
> drop that writes no committable file and reverses when the session ends or on
> `/hypaware-unignore`. The `@hypaware/claude` `hypaware-ignore` /
> `hypaware-unignore` skills already specify the contract (`POST` / `DELETE`
> `/_hypaware/ignore/session`, keyed on `session_id`); this spec makes the code
> honor it. Promotes [LLP 0051 §session-opt-out](./0051-usage-policy-future-extensions.decision.md#session-opt-out)
> from deferred to specced. Distinct from the folder-scoped `.hypignore`
> ([LLP 0049](./0049-hypignore-usage-policy.spec.md)).

## Motivation

The `hypaware-ignore` / `hypaware-unignore` skills advertise a clear, correct
contract: stop recording the current conversation by `POST`ing its session id to
`/_hypaware/ignore/session`, and reverse with `DELETE`. **The contract is right;
the code was never built.** The endpoint, the in-memory drop set, and the
gateway control path they depend on do not exist, so a user invoking the skill
today hits a route nothing serves ([issue #220](https://github.com/hyparam/hypaware/issues/220)).

This spec closes that gap without changing the skills. The skills are the
contract; the implementation is specified here.

## Relationship to `.hypignore` {#vs-hypignore}

This is a **different product** from the folder mechanism, not a variant of it:

| | `.hypignore` ([LLP 0049](./0049-hypignore-usage-policy.spec.md)) | session opt-out (this spec) |
|---|---|---|
| Scope | a directory subtree | one client session |
| Lifetime | persistent, committable | ephemeral, in-memory |
| Audience | the whole tree, for everyone | just the current conversation |
| Match key | `cwd` (ancestor walk) | `session_id` |

Repointing the skills at `.hypignore` would over-broaden "ignore this session"
into "ignore this repo forever," which is why the two stay separate mechanisms.
They are also **independent at enforcement time**: either match suppresses; they
do not merge or interact.

## The match key is `session_id` {#scope}

The drop keys on **`session_id`**, the always-present partition key
([LLP 0030](./0030-session-id-partition-key.decision.md)). What that scope means
differs per client, and the difference is load-bearing:

| Client | `session_id` | `conversation_id` | A `session_id` drop suppresses |
|---|---|---|---|
| Claude | the whole session (`x-claude-code-session-id` / `metadata.user_id.session_id`) | `null` (the session *is* the thread) | exactly this conversation |
| Codex | the session container (`metadata.session_id` / `session-id` header) | the thread within it | **all** threads in that session |

For **Claude**, `session_id == the conversation`, so the drop is exact. For
**Codex**, `session_id` is a container of multiple `conversation_id` threads, so
a `session_id` drop is broader than "this conversation": it suppresses every
thread in the session. Per-thread (`conversation_id`) granularity is a
[non-goal](#non-goals); the over-drop is latent, not live, because the only
opt-out skill today is Claude-only and Claude has no `conversation_id`.

## Enforcement: control route in the gateway, drop in the adapter {#enforcement}

The naive reading of "gateway-resident" (as [LLP 0051](./0051-usage-policy-future-extensions.decision.md#session-opt-out)
originally phrased it) would have the gateway itself perform the drop. That would
force the gateway to obtain `session_id` from the request, either by parsing the
provider-specific body (`metadata...session_id`) or by trusting a
provider-specific header. Both push provider awareness into the gateway, which
[LLP 0050](./0050-ignore-enforced-in-adapters.decision.md) forbids, and the
header path risks diverging from the body-first canonical id the row is actually
stamped with.

**So the work splits across the same seam `.hypignore` already uses:**

1. **Control surface: gateway.** The gateway serves `POST` / `DELETE
   /_hypaware/ignore/session` and holds an in-memory set of **opaque session-id
   strings**. It never interprets them: to the gateway they are meaningless
   tokens toggled on and off. This is provider-agnostic and does not violate
   [LLP 0050](./0050-ignore-enforced-in-adapters.decision.md) (`session_id` is
   not `cwd`, and the gateway inspects nothing about the exchange).

2. **Drop: client adapter exchange projector.** The adapter already resolves the
   canonical `session_id` it stamps on the row (`resolveClaudeSessionId` for
   Claude, `metadata.session_id` for Codex). When that `session_id` is in the
   ignored set, the projector returns the terminal `USAGE_POLICY_DROP` sentinel,
   exactly as the `.hypignore` `cwd` drop does
   ([LLP 0050](./0050-ignore-enforced-in-adapters.decision.md)). The gateway
   dispatcher already recognizes that sentinel, persists nothing, and logs an
   intentional usage-policy drop rather than a `no_projector_match` miss.

This is the key reconciliation: **the session opt-out does not overturn
[LLP 0050](./0050-ignore-enforced-in-adapters.decision.md); it adds a second
match key (`session_id`) feeding the same adapter drop.** `.hypignore` matches on
`cwd`; session opt-out matches on `session_id`; both terminate in
`USAGE_POLICY_DROP` returned from the adapter. Only the *control surface* is new
and gateway-resident.

Matching on the adapter's own resolved `session_id` (not a gateway header peek)
also guarantees the dropped identity is the recorded identity: the skill sends
`CLAUDE_CODE_SESSION_ID`, which is the same value the Claude adapter resolves and
stamps, so the set membership test cannot drift from what would have been
written.

### Gateway control-path concept {#control-path}

Today `ai-gateway`'s source compiles only an *upstream* routing table (which API
to proxy to) and treats every inbound request as proxiable
(`ai-gateway/src/source.js`, `proxy.js`). Serving the endpoint requires a new
concept: requests under the reserved **`/_hypaware/`** prefix are recognized as
**local control requests**, handled in-process, and never forwarded upstream.
The prefix is reserved for this and future control endpoints.

## Ephemerality {#ephemeral}

The ignored-session set lives only in the running gateway's memory. A gateway
restart drops the set, and recording silently resumes for the affected session:
the skill notes already state this and advise re-running `/hypaware-ignore` after
a restart. This is accepted, not a defect: the opt-out is deliberately a
lightweight session convenience, and the committable, durable mechanism is
`.hypignore` ([LLP 0049](./0049-hypignore-usage-policy.spec.md)).

## Non-goals {#non-goals}

1. **Per-thread (`conversation_id`) granularity.** Deferred. `conversation_id`
   is `null` for Claude and, for Codex, is computed during projection from a
   provider-specific body, so keying on it would pull provider parsing into the
   gateway and contradict [LLP 0050](./0050-ignore-enforced-in-adapters.decision.md).
   If a Codex opt-out ever needs true per-thread grain, it follows the
   adapter-enforcement model keyed on `conversation_id` and is specced
   separately; it does not motivate moving the drop into the gateway. Until
   then, a Codex `session_id` drop over-drops to the whole session
   (see [scope](#scope)).
2. **No persistence or committable form.** That is `.hypignore`
   ([LLP 0049](./0049-hypignore-usage-policy.spec.md)). This mechanism writes no
   file and does not survive restart.
3. **Prospective-only; no purge.** Only exchanges arriving while the session is
   ignored are dropped. Rows already recorded before the opt-out are left
   untouched; retroactive deletion is out of scope, matching
   [LLP 0049](./0049-hypignore-usage-policy.spec.md#prospective-only).
4. **No central/config interaction.** The opt-out is a local, in-memory toggle.
   It is not layered config ([LLP 0031](./0031-layered-config.decision.md)) and
   is not pushed by central.

## Requirements {#requirements}

- **R1.** `POST /_hypaware/ignore/session` with `{"session_id": "..."}` MUST add
  that id to the gateway's in-memory ignored-session set; `DELETE` with the same
  body MUST remove it. Both MUST be idempotent and MUST return the current total
  count (the skill reads `.total`).
- **R2.** The gateway MUST recognize `/_hypaware/*` as local control paths and
  MUST NOT proxy them upstream (see [control path](#control-path)).
- **R3.** The ignored-session set MUST be in-memory only: no file, no cache
  column, lost on gateway restart (see [ephemerality](#ephemeral)).
- **R4.** Enforcement MUST be a capture-seam drop in the client adapter exchange
  projector, returning the same `USAGE_POLICY_DROP` sentinel as the `.hypignore`
  drop ([LLP 0050](./0050-ignore-enforced-in-adapters.decision.md)), so nothing
  is written and the gateway logs an intentional drop, not a projector miss.
- **R5.** The match key MUST be the `session_id` the adapter resolves and stamps
  on the row (body-first canonical resolution), NOT a gateway-side header peek,
  so the dropped set matches the recorded identity.
- **R6.** The opt-out MUST NOT alter the live LLM call: the response has already
  been streamed by projection time, so only persistence is suppressed (matching
  [LLP 0049 R2](./0049-hypignore-usage-policy.spec.md#requirements)).
- **R7.** session opt-out and folder `.hypignore` MUST be independent: either
  match suppresses; they do not merge.
- **R8.** Tests MUST cover Claude (session equals conversation), Codex (whole
  session versus a single thread, documenting the over-drop), and
  restart-drops-state.

## `@ref` annotations code will carry {#refs}

- The gateway control route and the ignored-session set:
  `@ref LLP 0062#control-path [implements]` and `@ref LLP 0062#ephemeral`.
- The adapter projector drop keyed on `session_id`:
  `@ref LLP 0062#enforcement [implements]`, alongside the existing
  `@ref LLP 0050` on the same drop site.
