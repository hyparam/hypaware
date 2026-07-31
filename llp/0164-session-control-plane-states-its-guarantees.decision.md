# LLP 0164: the session control plane states its guarantees rather than proving them

**Type:** Decision
**Status:** Accepted
**Systems:** Gateway, Plugins
**Author:** Phil / Claude
**Date:** 2026-07-31
**Related:** LLP 0066, LLP 0067, LLP 0086

> Two questions were asked of the `hyp session` control plane in the same week,
> and they have the same answer. **#451:** can the CLI prove that whatever
> answers on the resolved port *is* the gateway? No, and it never will at this
> layer. **#460:** can a caller learn from `ignored: true` that the opt-out will
> actually match live traffic? No, only that the token it sent is in the drop
> set. Both are **accept and document**: the control plane keeps the behaviour
> it has and states the limit of the guarantee in its own output, in human form
> and in `--json`, rather than letting silence read as assurance.
>
> @ref LLP 0067#cli-response-check [constrained-by]: extends the recorded dead
> end into a stated contract - the residual is disclosed, not closed.

## Context

`hyp session status | ignore | unignore` resolves a control endpoint
(`status.json` from a live daemon, else the pinned `listen`), POSTs / GETs
`/_hypaware/ignore/session`, and reports the answer. It is a **privacy**
control: the answer a user acts on is "this session is not being recorded".

Two independent things stand between that answer and the truth, and neither is
a defect in the code that was written:

1. **Nobody authenticated the responder** (issue #451). PR #439's
   `validateControlResponse` refuses a reply that is not an object, whose
   `ignored` is not a boolean, or whose `session_id` is not echoed
   byte-for-byte. A local process that binds the port and *echoes the token
   back* satisfies every one of those checks by construction, and the user is
   told they are opted out while nothing is dropping anything.
2. **The route confirms a write, not a match** (issue #460). `control.js` adds
   the token to a `Set` and answers `ignored: true`; the drop consumer is a bare
   `Set.has`. A caller that registered the wrong key - a Codex *thread* id
   rather than the session container, say - gets the identical happy answer. A
   `GET` afterwards does not help: it asks the same `Set` the same question.

## Why authentication is not the fix for #451 {#why-not-authenticate}

Costed in [LLP 0067 §cli-response-check](./0067-session-opt-out.design.md#cli-response-check)
and unchanged by this document:

- **A gateway-written secret defends nothing.** Any process able to bind that
  port runs as the same uid as the daemon, and can therefore read whatever file
  the secret lives in. It raises the cost of the attack by one `read()`.
- **Peer-process identity is the only real signal, and it is not portable.**
  `status.json` already carries a liveness-gated daemon pid, so the check would
  be "is the process on the other end of this socket that pid" -
  `/proc/net/tcp` plus `/proc/<pid>/fd` on Linux, `lsof` on macOS,
  `GetExtendedTcpTable` (native addon or `netstat -o` scraping) on Windows.
  Three implementations and a native dependency for one check.
- **A non-squattable transport is a redesign.** A unix socket in a
  daemon-created directory would carry the property in the namespace itself, but
  it changes the control-plane transport, the skills' shell path, and Windows
  support all at once.

**The trigger condition is what settles it.** The attack requires a process on
this machine that can bind the gateway's port before or instead of the daemon,
which means the attacker already has local code execution as this user. At that
point they can read the cache, the config, and the credentials directly; a
spoofed opt-out answer is not the marginal capability worth a native dependency
in three platform flavours. The guarantee `hyp session` can honestly offer is
bounded by the machine it runs on, so that is the guarantee it states.

## The contract, stated in the output {#stated-not-proved}

**The responder is never authenticated, and every confirmed answer says so.**

- **Human output** carries a `trust:` note beside the answer, on `status` and on
  both mutation verbs: nothing proves the responder **at the named endpoint** is
  the HypAware gateway, any process on this machine could bind that port and
  answer, and the answer is only as trustworthy as this machine. The endpoint is
  named in the note itself because on the `daemon_status` path it is the only
  line about the endpoint at all.
- **`--json`** carries `endpoint_authenticated: false`, so a consumer acts on
  the guarantee without parsing prose.
- The existing `endpoint_source` disclosure (`daemon_status` / `config_listen`)
  **stays** and keeps its own note for the weaker source. The two say different
  things: `endpoint_source` grades the evidence that the *port* is the
  gateway's, `endpoint_authenticated` reports that the *responder* was never
  checked at all.

Three properties of the statement are load-bearing:

**It is unconditional.** The verb cannot tell the gateway from the impostor, so
a note printed only "when spoofed" would be a claim it cannot make. It rides
the `daemon_status` path too, where a live daemon reported the port it bound:
that is evidence about a bind in the past, not about who answers now.

**`endpoint_authenticated` is `false` by contract, not by outcome.** It is not a
check result that might come back `true` on a good day, and it is `false` on
`unknown` reports as well. Should a peer-identity check ever be adopted, that is
a new decision superseding this section, and it would need a distinct field
rather than quietly flipping this one - a consumer that has learned "false means
unauthenticated" must not have to relearn "false now means the check ran and
failed".

**Fail-closed behaviour is untouched.** `validateControlResponse` keeps every
refusal it has (LLP 0067 §cli-response-check): a malformed answer, an answer
about a different session, a non-200, an oversized body are all still `unknown`.
This document adds a disclosure to the answers that *are* believed; it does not
believe anything new.

## The companion contract: membership is not a match {#membership-not-grain}

The same decision was taken on issue #460, and the two read as one story: the
control plane answers exactly what it knows and names what it does not.

**`ignored: true` means "this token is in the drop set", and nothing more.** It
is not a statement that live traffic will match it. **The caller is responsible
for resolving the correct key before calling** - which is the shape PR #458
already established for `hyp session` ([LLP 0067
§cli-session-id](./0067-session-opt-out.design.md#cli-session-id): the session
container, never the thread id, and a refusal rather than a guess). This makes
that responsibility the stated contract rather than an accident of who resolved
first, and it is why option 1 there (the gateway resolving and echoing the
grain) was declined: the route treats the token as opaque
([LLP 0066 §enforcement](./0066-session-opt-out.spec.md#enforcement)), and
teaching it Codex grain would move provider knowledge into the one component
that has deliberately never had any.

Two consequences carried by that decision, realized in the change set for #460
rather than here:

- The skills' shell path gains the echo check the JS resolver already has
  (`validateControlResponse`'s equivalent), for as long as that path exists.
- When #435 lands, the skills stop resolving independently and the verification
  question narrows to the single CLI resolver, which is the durable shape.

## Scope of this change set

This document is the joint record; the code lands in two places, and this half
is the **#451** half:

- **Here (#451):** `RESPONDER_TRUST_NOTE` and `endpoint_authenticated: false` in
  `hypaware-core/plugins-workspace/ai-gateway/src/session_command.js`, on
  `status` and both mutation verbs, human and `--json`.
- **In its own change set (#460):** the membership-not-grain wording on the CLI
  and skill surfaces, and the shell-path echo check.

## What would reopen this

A change in the trigger condition, not a cheaper mitigation. If the gateway ever
serves a control plane reachable by a process that is *not* already running as
this user - a shared or multi-user host, a container boundary, a network-exposed
listener - the "local code execution is a precondition" argument stops holding
and authentication becomes load-bearing again. The disclosure fields make that
reopening cheap to spot: anything consuming `endpoint_authenticated` is a caller
that already knows to ask.

## Test plan {#tests}

`test/plugins/ai-gateway-session-responder-trust.test.js` stands up an
**impostor** responder - a listener that reads the session id off the query
string or body and echoes it back with `ignored: true` - and pins both halves of
the accepted outcome:

- the impostor's answer **is** believed (exit 0, `ignored: true`), including on
  the `daemon_status` path with a live pid file and a `status.json` naming the
  impostor's port, so the residual cannot change by accident, and
- every such answer discloses that the responder was not authenticated, in the
  human text and as `endpoint_authenticated: false`, on `status`, on `ignore`,
  on the genuine control route, and on `unknown` reports.
