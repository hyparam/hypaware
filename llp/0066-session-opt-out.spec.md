# LLP 0066: ephemeral per-session opt-out

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
[non-goal](#non-goals).

**The over-drop is live, not latent** (revised, [issue #453](https://github.com/hyparam/hypaware/issues/453)).
The original text called it latent "because the only opt-out skill today is
Claude-only"; `hyp session ignore` ([readable](#readable)) is client-agnostic, so
a Codex user reaches the key directly.

**And the mirror-image failure is the dangerous one.** Codex has a *second*
identifier at a finer grain, the **thread id**, and it is easy to reach and easy
to mistake for the key:

- A **root** thread takes `session_id = SessionId::from(thread_id)`, the same
  uuid, so the two coincide and nothing looks wrong.
- A **subagent** thread inherits the root's `session_id` and mints its own
  `thread_id`; its shell tool calls export that thread id as `CODEX_THREAD_ID`.

An opt-out stated against a thread id therefore matches **nothing**: not now, and
not later either, since the "latent" reading of a stored id assumes something
will eventually match it. Where the over-drop suppresses more than the user
asked, this suppresses nothing at all while reporting success, which is the worse
direction for a privacy control. So the key is not merely *documented* as the
container: anything that names a session to the control route MUST name the
container or refuse (R13).

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

## The set MUST be readable, and a read that fails is `unknown` {#readable}

Ephemerality (above) has a consequence the original spec left unhandled: the
opt-out can stop applying while the user still believes it holds. Two ways:

1. **Gateway restart** drops the set (accepted, above).
2. **The session id changes under the client.** The drop keys on `session_id`
   ([scope](#scope)); if the client ever mints a new id for what the user
   experiences as the same conversation (a resume, a fork), the in-memory entry
   no longer matches and recording resumes.

Neither is a defect in the *mechanism*. Both were a defect in the *surface*: the
control route only accepted writes, so there was no way to ask "am I still
opted out?" A privacy control the user cannot verify fails open silently, which
matters most where the opt-out is load-bearing
([LLP 0100](./0100-enrollment-privacy-review.spec.md) R3 opts the session out
*before* surveying the most sensitive content on the machine).

So the set gains a reader, and the reader is **fail-closed**: a check that
cannot be completed (gateway unreachable, no endpoint resolvable, no session id
resolvable) reports **`unknown`**, never "not ignored". Conflating those two is
the specific defect ([issue #432](https://github.com/hyparam/hypaware/issues/432)):
"I could not ask" and "I asked, and you are being recorded" are different
answers, and only one of them is safe to treat as a completed check.

The reader reports **the session set only**. `.hypignore` is an independent
governor (R7), so the reader must *name* the other governor rather than omit
it: a user inside a `.hypignore`d repo must not read "not ignored" as "I am
being recorded."

This is observability of an ephemeral control, not durability. Persisting the
set remains [non-goal 2](#non-goals).

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
- **R9.** The ignored-session set MUST be readable: a non-mutating read of one
  `session_id` MUST report current membership, so an opt-out that stopped
  applying (restart, or a changed session id) is discoverable rather than
  silent (see [readable](#readable)).
- **R10.** The read MUST fail closed. When the answer cannot be established,
  the reported state MUST be `unknown` with a nonzero exit, distinct from a
  confirmed "not ignored"; it MUST NOT degrade to `ignored: false`. "Cannot be
  established" includes a reply that is not a well-formed control response, and
  a reply about a **different** `session_id` than the one asked about: reaching
  something on the endpoint is not the same as reaching the gateway, so the
  answer MUST be validated before it is believed (see
  [LLP 0067 §cli-response-check](./0067-session-opt-out.design.md#cli-response-check)).
  It also includes a session id that could only be **inferred**, and not
  credibly: a Codex rollout that nothing has written to recently is a finished
  session, so resolving it would answer confidently about a session the user is
  not in (see
  [LLP 0067 §cli-session-id](./0067-session-opt-out.design.md#cli-session-id)).
- **R12.** Where an answer rests on an inference rather than a stated fact, the
  reader MUST say so alongside the answer: which source the `session_id` came
  from (and, when inferred, from what), and whether the endpoint was proven
  bound by a live daemon or merely pinned in config. A control that can be
  wrong about *which* session it answered for must make that visible rather
  than let it be discovered in the cache (see
  [LLP 0067 §cli-provenance](./0067-session-opt-out.design.md#cli-provenance)).
- **R11.** The reader MUST name the folder governor (`.hypignore`) it does not
  cover, since either mechanism independently suppresses (R7).
- **R13.** Every surface that names a session to the control route MUST name the
  **session container** the drop matches (R5), never a finer-grained client
  identifier that happens to be easier to obtain. Specifically, a Codex
  **thread** id MUST NOT be stated as a session id: it coincides with the
  container on a root thread and diverges on a subagent one, so stating it
  reports an opt-out that suppresses nothing (see [scope](#scope)).
  - Where the container cannot be established, the surface MUST **refuse**
    (`unknown`, nonzero) rather than substitute the thread id. This includes a
    rollout that records no `session_id` field at all: Codex's own
    `SessionMetaLine` deserializer back-fills that field from the thread id, so a
    reader that trusts the parsed value silently reintroduces exactly the wrong
    key (see [LLP 0067 §cli-session-id](./0067-session-opt-out.design.md#cli-session-id)).
    A field that is **present but unusable** (blank, non-string, or carried on a
    record that does not state the container) MUST refuse the same way: reported
    as the answer it would match nothing at the drop, which is the same silent
    no-op reached by another route.
  - Backfill MUST agree with the live path about which identifier is the
    partition key, so an opt-out names one identifier rather than one per
    ingestion path
    ([LLP 0030](./0030-session-id-partition-key.decision.md) decision 1).
  - Because the acted-on key is coarser than the thread the user is in, the
    surface MUST disclose that grain alongside the answer (R12): "ignored" means
    the whole session, sibling threads included.

## `@ref` annotations code will carry {#refs}

- The gateway control route and the ignored-session set:
  `@ref LLP 0066#control-path [implements]` and `@ref LLP 0066#ephemeral`.
- The adapter projector drop keyed on `session_id`:
  `@ref LLP 0066#enforcement [implements]`, alongside the existing
  `@ref LLP 0050` on the same drop site.
- The read route and the fail-closed CLI reader: `@ref LLP 0066#readable
  [implements]`.
