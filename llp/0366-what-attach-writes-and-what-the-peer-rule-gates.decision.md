# LLP 0366: What attach writes, and what the peer rule actually gates

**Type:** Decision
**Status:** Accepted
**Systems:** Gateway, Sources, Config
**Generated-by:** neutral
**Author:** Phil / Claude
**Date:** 2026-09-03
**Extends:** [LLP 0233](./0233-one-listener-two-front-doors.decision.md)
(#loopback-peers-only justified refusing the peer, not the bind, with a
parenthetical about what attach writes that is false as stated; this document
records what each attach writer actually writes and re-derives the rationale)
**Related:** LLP 0232 (proxy-mode attach, the writer whose behavior carries
the corrected rationale), LLP 0247 (#loopback-peers-only: the absolute-form
door inherits the peer rule this document re-justifies), LLP 0114 (the fixed
default port the endpoint plumbing serves)

> LLP 0233 #loopback-peers-only says "attach always writes
> `http://127.0.0.1:<port>` whatever the bind host says". That is false as a
> universal: the openclaw attach writer and the Desktop install profile both
> point a client at the configured bind host verbatim. The decision it
> justified still stands, because the writers that feed the doors the peer
> rule gates do hardcode loopback. This document replaces the overstated
> parenthetical with the per-writer facts and the rationale they actually
> support (issue #1277, deferred from PR #1271's triage).

## Context {#context}

LLP 0233 #loopback-peers-only settled that the `CONNECT` front door refuses
any peer that is not loopback, checking the *peer*, not the bind. Its stated
reason that this costs a non-loopback `listen` install nothing was a
parenthetical: "attach always writes `http://127.0.0.1:<port>` whatever the
bind host says", so the install's own client keeps working while the relay
closes to everyone else. LLP 0247 extended the same peer rule to the
absolute-form door on the same reasoning.

The parenthetical is load-bearing and it is not true as written. LLP 0233 is
Accepted, so the correction is this extending document rather than an edit in
place (CLAUDE.md, "Accepted docs are settled").

## The facts at head {#the-facts}

**The endpoint plumbing carries the configured host verbatim, end to end.**
`localEndpoint()` formats `state.listen.host` into the URL it returns
(`hypaware-core/plugins-workspace/ai-gateway/src/api.js`), `state.listen` is
the host the bound proxy took from the configured `listen`
(`ai-gateway/src/source.js`), and the CLI fallback `configuredGatewayEndpoint`
builds the URL from the same configured `listen`
(`src/core/config/gateway_endpoint.js`). `hyp session ignore` posts to that
endpoint too (`ai-gateway/src/session_command.js`). Nothing in the plumbing
rewrites a non-loopback host to `127.0.0.1`.

**The adapters split on what they do with that endpoint.**

- The **claude** writer takes *only the port* from the endpoint and hardcodes
  the host, in both of its gateway modes: `base_url` mode writes
  `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>` and proxy mode writes
  `HTTPS_PROXY=http://127.0.0.1:<port>`
  (`hypaware-core/plugins-workspace/claude/src/settings.js`).
- The **codex** writer does the same: `base_url =
  http://127.0.0.1:<port>/backend-api/codex`
  (`hypaware-core/plugins-workspace/codex/src/index.js`).
- The **opencode** writer is not handed the gateway endpoint at all. It is
  registered `requiresEndpoint: false` (LLP 0306 endpoint-free clients) and
  builds `http://127.0.0.1:<port>` from its own `opencode.listen_port`, the
  separate loopback SDK snapshot listener this plugin starts, so no gateway
  `listen` reaches it in any form
  (`hypaware-core/plugins-workspace/opencode/src/index.js`,
  `opencode/src/config.js`, `opencode/src/listener.js`).
- The **openclaw** writer takes the endpoint *verbatim* (trimmed only) and
  writes it into both provider `baseUrl` fields
  (`hypaware-core/plugins-workspace/openclaw/src/attach.js`).
- The **claude-desktop** profile is not an attach writer at all: Desktop
  registers no client (LLP 0115 #no-attach-on-join), so nothing hands it an
  endpoint. The attended `hyp client claude-desktop install` reads the
  configured `listen` out of the config itself, and a `claude_desktop.endpoint`
  override, when set, wins over `listen` outright. What it renders is
  `http://<listen>` verbatim, by design and for the same reason as openclaw: a
  deliberately non-loopback bind is one Desktop should be able to reach. Its
  one guard is on the *port*, refusing an ephemeral `:0` that a managed config
  could not chase; it does not judge the host
  (`hypaware-core/plugins-workspace/claude-desktop/src/profile.js`).

So "attach always writes `http://127.0.0.1:<port>`" is true of the claude and
codex writers and false of openclaw, the one attach writer that passes the
host through. It is not a statement about opencode, which is handed no
endpoint, nor about the Desktop install profile, which is not attach at all
but is the other surface that points a client at the configured host.
"Whatever the bind host says" was never a property of the plumbing, only of
the two writers that take the endpoint and discard its host.

## Decision {#decision}

<a id="the-rationale-re-derived"></a>**The peer rule stands, on a narrower and
true premise: every client that can reach a door the peer rule gates was
pointed at loopback by its writer.** The rule refuses non-loopback *peers* on
the `CONNECT` door (LLP 0233) and the absolute-form door (LLP 0247). Origin-form
reverse-proxy traffic is not gated by it. The only clients that send `CONNECT`
or absolute-form requests are proxy-mode attached, and the proxy-mode writer
hardcodes `HTTPS_PROXY=http://127.0.0.1:<port>`, so those clients always
arrive from a loopback peer. The surfaces that do pass the configured host
through (openclaw's writer and the Desktop install profile) point base-URL
clients at the gateway, and the peer rule never judges an origin-form
request. Refusing the peer therefore still costs the machine's own attached
clients nothing, on any bind, and still closes the relay to the network.
Nothing about the check changes.

<a id="what-the-old-sentence-overstated"></a>**What LLP 0233's parenthetical
overstated, in two ways, for the record.** First, "always": openclaw's writer
and the Desktop install profile write the configured host verbatim, as listed
above. Second, "keeps that install working unchanged for its own client":
that holds for the wildcard binds the section was actually worried about
(`0.0.0.0`, `::`, the open-relay case), where loopback still answers and a
hardcoded
`127.0.0.1:<port>` still connects. On a *specific* routable bind
(`192.168.1.5:18521`, say) nothing listens on loopback at all, so the two
writers that hardcode loopback from the gateway endpoint (claude and codex)
produce URLs that refuse the connection outright; opencode is untouched,
because it never reads the gateway `listen`. That breakage is a consequence
of the bind, not of the peer rule: the rule neither causes it (the connection
never reaches the door) nor cures it. The old sentence folded the two apart.

<a id="record-not-behavior"></a>**This document records; it changes no
behavior.** The alternative reading of issue #1277's acceptance condition,
making every writer actually hardcode `127.0.0.1` so the old sentence becomes
true, is rejected here: it would cut off both surfaces that deliberately honour
a non-loopback bind, the Desktop profile and openclaw installs configured with
one, to rescue a parenthetical whose conclusion survives on the corrected
premise anyway.

## What this does not settle {#not-settled}

**The writers do not agree on host handling, and a specific routable bind
half-breaks attach.** Of the three attach writers handed the gateway
endpoint, two hardcode loopback (claude, codex) and one passes the configured
host through (openclaw), as does the Desktop install profile, and on a
specific non-loopback bind the hardcoded two emit URLs nothing answers.
Whether attach should warn or refuse there, or the writers should converge on
one host policy, is a behavior change with its own trade-offs and is not
decided here.

**README's mechanism sentence inherits the mirror-image overstatement.** The
README section on the gateway's bind ("that same host is what `hyp client
attach` writes into each client's base URL", and the `403` it predicts for a
proxy-mode client on a routable bind) generalizes from the verbatim writers
the way LLP 0233 generalized from the hardcoded ones. Its operator-facing
conclusion (pin `listen` to loopback or a wildcard) is right either way.

*Resolved by issue #1291:* the README paragraph now carries the per-writer
facts above, and the `403` it predicted is unreachable.

## Consequences {#consequences}

- LLP 0233 #loopback-peers-only keeps its decision and its `Extended-by:`
  line now points here for the corrected justification.
- The comment above the peer check in `ai-gateway/src/connect.js`, which
  repeated the overstated sentence, now states the narrower fact.
- A future writer for a new proxy-mode client inherits the premise this
  rationale rests on: point the client at `http://127.0.0.1:<port>`, taking
  only the port from the endpoint, or the peer rule will refuse the client it
  was designed never to touch.
