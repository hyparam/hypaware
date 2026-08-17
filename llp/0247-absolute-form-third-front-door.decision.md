# LLP 0247: Absolute-form requests are a third front door, restricted to intercepted hosts

**Type:** Decision
**Status:** Draft
**Systems:** Gateway
**Author:** Phil / Claude
**Date:** 2026-08-17
**Related:** LLP 0233, LLP 0234, LLP 0246

> A request whose request-line carries an absolute URL is routed by the host
> that URL names, through the same forwarding and per-path recording rules as
> a terminated tunnel. Hosts no upstream names are refused, and so are peers
> that are not the machine itself.

## Context

LLP 0233 settled two front doors: path-routed origin-form reverse-proxy
requests, and `CONNECT` tunnels. Claude Code's Remote Control bridge client
sends a third shape (LLP 0246): absolute-form plaintext HTTP
(`POST https://api.anthropic.com/... HTTP/1.1`) straight to the proxy port,
without a tunnel. The gateway routed it by pathname alone, discarded the host
the request line named, and answered a local 404 that Claude Code misread as
an account limitation.

Absolute-form to a proxy is legitimate HTTP (RFC 9112 section 3.2.2 requires
proxies to accept it), so refusing the shape outright punishes a
standards-permitted client for our listener's assumption.

## Decision

### Route by the named host

**An absolute-form request-target is routed like a terminated tunnel, not
like a reverse-proxy path.** The authority is parsed from the request line
(port defaulted by scheme) and resolved through `matchUpstreamByHost`,
exactly as a request arriving through a `CONNECT` stamp is. The forwarding
path downstream is unchanged, and recording follows the proxy-mode rule
(LLP 0234 #recording-is-opt-in-per-path): only paths inside the upstream's
declared anchor persist; everything else passes through unrecorded. The
recorded path is the origin-form remainder, so projectors see the same shape
from all three front doors.

Path matching is the wrong question here for the same reason it is under a
`CONNECT`: the client already told us the destination, and honouring it is
the only way to forward a request whose path no preset claims.

### Refuse hosts nobody registered

**A host and port no upstream names is refused with 403, never forwarded.**
Forwarding is therefore capability-equal to what the routing table already
grants reverse-proxy traffic; the listener does not become a general
absolute-form relay to arbitrary hosts. This is deliberately narrower than
the blind-tunnel degrade `CONNECT` offers: a blind tunnel exists because a
proxy-mode client points ALL egress here and refusing would break its
authentication, whereas an absolute-form miss is one request from a client
that demonstrably reaches its other endpoints by tunnel.

### Loopback peers only

**The same peer rule as `CONNECT` (LLP 0233 #loopback-peers-only).** An
absolute-form request is addressed to a third party, so serving it to
non-loopback peers would relay for the network. The peer, not the bind, is
checked, and a non-loopback peer gets 403 before the target is parsed
further.

### The control surface never answers absolute-form

The `/_hypaware/` local control prefix is scoped to the direct origin
(LLP 0066). An absolute-form target is addressed to a third party, so
`https://api.anthropic.com/_hypaware/...` is routed like any other
absolute-form path rather than answered locally, for the same reason the
tunnel path refuses it: answering would both swallow a path that is not ours
and expose the unauthenticated control surface to anything that can make the
client fetch a URL.

## Consequences

- Remote Control registration (`POST /v1/environments/bridge` on
  `api.anthropic.com`) forwards and succeeds on proxy-mode installs, and is
  not recorded because it sits outside the Claude adapter's path anchor.
- A tunnel-only listener (LLP 0233 #degrade-to-blind-tunnels) has an empty
  routing table, so it refuses absolute-form even while it blind-tunnels
  `CONNECT`. The degrade contract stays CONNECT-shaped; an absolute-form
  client on a degraded listener surfaces through the same status repair path.
- The regression test replays the exact on-the-wire shape: absolute-form
  plaintext `POST` written raw to the listener port.
- The upstream defect remains worth filing with Anthropic: the bridge client
  ignores `HTTPS_PROXY` `CONNECT` semantics for an `https://` target and
  sends its bearer token in plaintext to the proxy port.
