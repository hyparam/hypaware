# LLP 0382: The control surface answers absolute-form exactly where LLP 0247 said it never would

**Type:** RFC
**Status:** Draft
**Systems:** Gateway
**Generated-by:** neutral
**Author:** Phil / Claude
**Date:** 2026-09-05
**Related:** [LLP 0247](./0247-absolute-form-third-front-door.decision.md)
(#the-control-surface-never-answers-absolute-form, the categorical rule that
the `/_hypaware/` prefix is never answered on an absolute-form target;
#only-forward-proxy-listeners-serve-it, the listener-scope rule that a pure
reverse-proxy listener lets the same shape "keep falling through to path
routing as before": the two rules this document shows cannot both hold),
[LLP 0233](./0233-one-listener-two-front-doors.decision.md)
(#proxy-mode-is-explicit, the promise the listener-scope rule rests on),
[LLP 0066](./0066-session-opt-out.spec.md) (#control-path, the unauthenticated
local control surface both rules are about),
[LLP 0366](./0366-what-attach-writes-and-what-the-peer-rule-gates.decision.md)
(the other correction deferred out of PR #1271's triage, and the precedent for
extending rather than editing what a settled gateway document recorded),
hyparam/hypaware#1274 (the deferred finding this document is minted from),
hyparam/hypaware#1238 (the DNS-rebinding hole whose fix surfaced the
contradiction), PR #1271 (where the Host barrier and its shape exemption
landed), PR #797 (where LLP 0247 and the third front door shipped)

> LLP 0247 decides in one section that the unauthenticated `/_hypaware/`
> control surface never answers an absolute-form request, and in another that
> a pure reverse-proxy listener, the default install, serves the absolute-form
> shape by letting it fall through to path routing exactly as it always has.
> Path routing answers `/_hypaware/` locally, so for
> `POST http://attacker.example/_hypaware/ignore/session` on a default
> listener the two sections prescribe opposite answers. The shipped code
> follows the listener-scope section and carries the categorical section's
> `@ref` on the very gate that narrows it. No capability changes today, but
> aligning the sections changes what a default listener answers, a design
> change on a settled decision. This document states the contradiction, shows
> the request that falls between the two rules, and lists the candidate
> resolutions with their costs. It decides nothing.

## The two sections, quoted {#the-conflict}

LLP 0247 #the-control-surface-never-answers-absolute-form, in full:

> The `/_hypaware/` local control prefix is scoped to the direct origin
> (LLP 0066). An absolute-form target is addressed to a third party, so
> `https://api.anthropic.com/_hypaware/...` is routed like any other
> absolute-form path rather than answered locally, for the same reason the
> tunnel path refuses it: answering would both swallow a path that is not
> ours and expose the unauthenticated control surface to anything that can
> make the client fetch a URL.

LLP 0247 #only-forward-proxy-listeners-serve-it, the sentences at issue:

> The door exists only where the CONNECT front door does: a listener started
> with interception or `tunnelOnly`. [...] A pure reverse-proxy listener has
> no proxy-pointed clients, and LLP 0233 #proxy-mode-is-explicit promises it
> behaves exactly as it always has, so there an absolute URL on the request
> line keeps falling through to path routing as before.

The first rule is categorical: its heading says *never*, and its rationale
(exposing the unauthenticated control surface) does not scope itself to any
listener kind. The second rule says that on a listener without the door, the
default `proxy_mode`-off install, the absolute-form shape is handled by path
routing "as before". But path routing checks the control prefix before it
matches an upstream (LLP 0066 #control-path requires exactly that ordering,
so a catch-all upstream cannot leak a control request to a provider). "Falls
through to path routing" therefore *means* "the control surface answers it".
For an absolute-form target naming a control path on a doorless listener, the
two sections cannot both hold.

## The request that falls between them {#the-request}

All references are to `origin/master` (`48ea7cc4`),
`hypaware-core/plugins-workspace/ai-gateway/src/proxy.js`:

- Line 373: `absoluteFormShape = !proxyMode && /^https?:\/\//i.test(requestUrl)`,
  the shape, held apart from the door.
- Line 375: `absoluteForm = absoluteFormShape && forwardProxyDoor`, the shape
  behind the door (`interception || tunnelOnly`).
- Line 411, the Host-judgment barrier from PR #1271: scoped by
  `!absoluteFormShape`, so any absolute-form request line skips the
  misdirected-Host refusal on every listener.
- Line 431, the control gate: scoped by `!absoluteForm`, so on a doorless
  listener the absolute-form shape passes through to the control handler.

On a default listener (`proxy_mode` off, no interception, no `tunnelOnly`),
a raw

```
POST http://attacker.example/_hypaware/ignore/session HTTP/1.1
Host: attacker.example
```

has `absoluteFormShape` true and `absoluteForm` false. It skips the Host
judgment at line 411 (shape-exempt) and reaches the unauthenticated control
handler through line 431 (door-scoped), which resolves
`parsedUrl.pathname` to `/_hypaware/ignore/session` and invokes
`onControlRequest` (the session-ignore handler registered by
`session_command.js`). The categorical section says this request is never
answered locally; the listener-scope section says this listener behaves as it
always has, which answers it. The code follows the second while carrying
`@ref LLP 0247#the-control-surface-never-answers-absolute-form [implements]`
directly above the gate at line 431: even the annotation implements a
narrower rule than the section it cites.

PR #1271's regression test, "a reverse-proxy-only listener still path-routes
absolute-form under a foreign Host", pins the fall-through for `/v1/messages`
only. No test observes the control path under the absolute-form shape, so
today's answer is an accident of gate scoping, recorded nowhere.

## Why nothing is exposed today {#no-capability-change}

The contradiction is textual, not an open hole, which is why issue #1274 was
deferred rather than fixed:

- A browser cannot put an absolute URL on a request line, so the
  DNS-rebinding vector that PR #1271 closed for issue #1238 stays closed. The
  Host barrier's shape exemption at line 411 exists for exactly this reason:
  the shape is out of a rebound page's reach.
- A local process able to write absolute-form to the port can already reach
  the same control route origin-form under `Host: 127.0.0.1`. The shape adds
  no capability a loopback peer lacks.
- Non-loopback peers never reach this point on the door-open listeners where
  absolute-form is served (LLP 0247 #loopback-peers-only), and on a doorless
  listener the control handler is the same unauthenticated loopback surface
  it has always been (LLP 0066).

What is at stake is which of LLP 0247's two rules is the design, and whether
the doorless-listener exemption is intended or an oversight. Both predate
PR #1271; the barrier work only made the divergence visible.

## Candidate resolutions {#candidates}

**1. The categorical section governs: absolute-form never reaches the
control handler, on any listener.** Rescope the control gate at line 431 by
shape rather than by door, and add the control-path absolute-form test.
Two variants of what the request then gets:

- *1a, fall through:* the request proceeds to path routing minus the control
  gate, which is what the categorical section itself prescribes ("routed like
  any other absolute-form path"). On a doorless listener with no catch-all
  upstream that is a 404 by path miss; with a catch-all upstream
  (`path_prefix: "/"`) the request is forwarded and can become a recorded
  row, so the swallow the categorical rule wanted to avoid becomes a forward
  instead.
- *1b, refuse:* refuse the shape ahead of the control handler (403 or 421)
  when it names a control path. Nothing is forwarded, but the listener gains
  a refusal for a shape it otherwise still path-routes, a narrower promise
  than "behaves exactly as it always has".

Either variant changes what a default listener answers on the control path,
which is the fork against #only-forward-proxy-listeners-serve-it and the
LLP 0233 #proxy-mode-is-explicit promise it cites. Whichever variant is
chosen must also say whether the Host barrier's `!absoluteFormShape`
exemption at line 411 stands unchanged (its rebinding rationale is
independent and appears sound either way).

**2. The listener-scope section governs: the exemption is intended.** Scope
the categorical rule to the listeners where the door exists, record that a
doorless listener answers the absolute-form shape on the control path exactly
as it answers it origin-form, and pin the current behavior with the missing
control-path absolute-form test. No runtime behavior changes. The cost is in
the record: the section titled "never" becomes "never where the door exists",
its exposure rationale ("anything that can make the client fetch a URL") must
be re-derived for the doorless case (no client is proxy-pointed at a doorless
listener, so nothing external composes absolute-form at it), and the `@ref`
at line 431 must be repointed at the deciding document so the annotation and
the rule it cites agree again.

## What this document asks {#asks}

A deciding LLP, extending LLP 0247, that answers: on a listener without the
forward-proxy door, does the `/_hypaware/` control surface answer an
absolute-form request-target? The acceptance condition of issue #1274 binds
the outcome either way: the code and a control-path absolute-form test must
match the decision, whether that is a refusal ahead of the handler or the
exemption recorded as intended. This document does not choose.
