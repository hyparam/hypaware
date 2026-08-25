# LLP 0313: Codex routes by credential, not by an attach-time URL

**Type:** Decision
**Status:** Accepted
**Systems:** Gateway, Plugins
**Author:** Brendan / Claude
**Date:** 2026-08-25
**Related:** LLP 0016, LLP 0045, LLP 0099, LLP 0109, LLP 0157, LLP 0161, LLP 0234

> `hyp attach codex` writes one provider block in both auth modes, on a
> prefix that says nothing about how the user logged in. The gateway picks
> the upstream per request, from the credential the request carries as well
> as the path it arrived on, and rewrites the outbound path to that
> upstream's own shape.

## Context

Codex speaks the Responses wire against two upstreams that take two
different credentials: a ChatGPT subscription OAuth token against
`chatgpt.com/backend-api/codex/*`, and an `sk-` platform key against
`api.openai.com/v1/*`. LLP 0099 settled that attach reads `~/.codex/auth.json`
and writes the matching `base_url`, so the URL on disk is a standing claim
about which credential the user holds.

That claim goes stale the moment the user runs `codex login` the other way.
The credential changes, the URL does not, and the gateway faithfully sends
an `sk-` key to `chatgpt.com` or a subscription token to `api.openai.com`.
Every turn fails, with an upstream 401 that names nothing HypAware did.

Repairing `config.toml` is not sufficient, for two reasons that hold no
matter how good the detection is:

- A repair runs on a reconcile pass, and passes are edge driven (daemon
  boot, or a central config confirmation edge; LLP 0041). On a machine
  observed in practice that was five passes in five days.
- Codex reads its provider once at process start, so even a same-second
  repair cannot help the running `codex` or the request already in flight.

The gateway, by contrast, holds the request. It knows both upstreams and it
already reads the `Authorization` header in order to forward it.

## Decision {#decision}

The upstream is selected by path **and** credential, per request, and the
gateway rewrites the outbound path when the upstream it resolved uses a
different shape. Four parts, settled separately below.

Together they mean nothing on disk encodes the auth mode, so nothing on disk
can go stale when the mode changes: there is no re-attach, no reconcile pass,
and no `codex` restart between switching login and the next working turn.

### The neutral prefix is `/backend-api/codex` {#the-neutral-prefix}

Attach writes this, in both auth modes, permanently:

```toml
[model_providers.hypaware]
name = "HypAware Codex Gateway"
base_url = "http://127.0.0.1:<port>/backend-api/codex"
```

`attach()` stops reading `auth.json`; `readCodexAuthMode` and the two-route
table are gone.

**Why this prefix, and not a fresh one.** The gateway forwards it verbatim
today. A subscription request goes `127.0.0.1:<port>/backend-api/codex/responses`
to `chatgpt.com/backend-api/codex/responses` with no rewrite, and it keeps
doing exactly that, byte for byte. A fresh neutral prefix would put **both**
directions through the rewrite, including the one that works for every
subscription user today. Reusing this one makes the change strictly
one-directional.

Rejected: `/v1`, which already means "the openai upstream" to the routing
table, and where `/v1/messages` is registered by two other adapters and kept
apart only by prefix-length sort order.

**Migration.** Subscription machines need no re-attach: their `config.toml`
is already correct under the new rule. API-key machines still on `/v1` keep
working until their next attach, because path and credential still agree
there and `/v1` stays registered. There is no broken window.

**The readability cost.** An API-key user reading `config.toml` sees
`/backend-api/codex` and could reasonably conclude they are pointed at
ChatGPT. Neutralizing the provider `name` to `HypAware Codex Gateway` is the
answer: the path keeps a shape borrowed from chatgpt.com, but no line in the
managed block claims that is where traffic goes.

**The blocking unknown, measured.** A neutral URL is only safe if Codex does
not decide which headers to attach from the shape of its `base_url`. If it
did, a neutral URL would make it drop `chatgpt-account-id` and break
subscription mode. Measured against recorded gateway traffic on a real
machine (Codex 0.149.1, macOS), four requests with an identical path and an
unchanged `config.toml`, spanning a switch from subscription to API key:
`chatgpt-account-id` is present on the three before the switch and absent on
the first request after it. Codex builds its subscription headers from the
auth mode, not from the provider URL. The URL is ours to change. (The
residual: this proves the URL is not *sufficient* to trigger the header, not
that it is not *necessary*, which would need subscription credentials against
a non-ChatGPT URL, a combination that has never occurred.)

### The credential rung {#the-credential-rung}

A codex-owned upstream preset, `openai-codex`, matches a request that
arrives on the neutral prefix carrying an `Authorization` header whose
credential begins `sk-`, and points at `api.openai.com`. Two rungs:

1. The neutral prefix plus an api-key-shaped credential selects
   `openai-codex`, and nothing overrides it. An `x-hypaware-upstream` steer
   (LLP 0157) names a destination; this rung is not a destination preference
   but the invariant below, and an invariant takes no preferences. Deferring
   to the steer would defeat it, because the presets the steer resolves
   against are the two operator config replaces, and a replaced entry
   carries no `match()`. Claiming the request here costs a steered caller
   nothing it can want: `openai-codex` IS `api.openai.com`, at the path
   shape that host serves.
2. Anything else declines, so an unrecognized or absent credential falls
   back to path routing, which is the behavior that exists today.

**The credential test is deliberately broad**, and broader than a strict
`Bearer <token>` parse: an upper-cased prefix, a stray trailing token and a
missing scheme all still count as a key. The two ways of being wrong are not
symmetrical. A false positive sends a non-key credential to
`api.openai.com`, which answers 401. A false negative sends a real platform
key to `chatgpt.com`, which is the whole failure this document exists to
close, and per the invariant below nothing downstream catches it on a
default install.

**Why a new preset name rather than a rung on `openai`.** `openai` is a
name-keyed, last-write-wins preset slot that both `@hypaware/codex` and
`@hypaware/openclaw` register (LLP 0161), so a rung written there is only as
durable as the activation order, and the two copies would have to carry an
identical rewrite that only one of them wants. A name codex owns outright
removes the whole class. It also survives operator config, which overrides
presets by name and can express neither a `match()` nor a rewrite: the
`hyp init` picker writes `openai` and `chatgpt` upstreams, so those two
presets are routinely replaced on a real install, and `openai-codex` is not.

The preset states `priority: 10` rather than inheriting a rank from its
prefix length, and that rank is load-bearing rather than tidy: config
entries compile at priority 0 and sort ahead of presets on equal rank, so at
the inherited rank the `chatgpt` entry `hyp init` writes would win the
default install, which is the install this fix is for.

**The cost, stated rather than waved past.** An operator who declares their
own upstream on `/backend-api/codex` IS outranked, for requests carrying an
api-key-shaped credential. Nothing else is diverted (`match()` requires both
the prefix and the credential), but that one case is a real and deliberate
exception to "operator config wins the routing question": the alternative is
forwarding a platform key to a host that must never see it, and a routing
preference does not outrank a credential-safety refusal.

### An `sk-` key is never sent to chatgpt.com {#sk-never-reaches-chatgpt}

Stated as an invariant, not as a consequence of rung order. The `chatgpt`
preset's `match()` refuses a request carrying an api-key-shaped credential,
so if `openai-codex` is ever absent or outranked the turn fails at the
gateway with a 404 rather than handing the user's platform key to a host that
has no business seeing it.

**That guard is second-line, and on a default install it is not present at
all.** The `hyp init` picker composes the codex manifest's
`gateway_upstream` block, which declares an upstream named `chatgpt`;
operator config wins by name and TOML can express no credential rung, so on
a shipping machine the entry that replaced the preset routes on
`path_prefix` alone. `openai-codex` is therefore not a belt beside a
braces: it is the only thing holding the invariant up where it matters, and
two consequences follow that the design has to honour rather than note.

- Its `match()` must recognise **every** credential the guard would have
  refused, because anything it fails to recognise is forwarded rather than
  refused. Hence the broad credential test above, and hence its rung takes no
  precedence from a steering header.
- Its rank must clear operator config, not merely the sibling preset. Hence
  `priority: 10`.

Tests assert the invariant on the merged table `hyp init` actually writes,
not only on the presets: a preset-only table is the one table no shipping
machine compiles.

**Scope: one direction only.** Only the subscription-to-API-key direction is
recoverable from the request. The reverse (a subscription token arriving on
`/v1`) is not: that route also needs `chatgpt-account-id`, which Codex sends
only when it believes it is on the chatgpt provider, and which cannot be
synthesized. LLP 0099 already called that direction unsafe and this does not
change it.

### Credential inspection {#credential-inspection}

The gateway already reads and forwards `Authorization`, so prefix-matching
it adds no exposure. What is new is the obligation that comes with reading
it deliberately: no token material may reach a log line, a span attribute,
or a stored row. The match tests the first characters and returns a boolean;
the reroute log line carries the two pathnames and the upstream name, never
the query string and never a header. `authorization` was already in the
recorder's non-shrinkable redact set.

### The rewrite is declarative data, not a callback {#the-rewrite-is-declarative-data}

An upstream preset declares the rewrite as plain fields the gateway reads
and applies itself:

```js
{ base_url: 'https://api.openai.com', rewrite: { from: '/backend-api/codex', to: '/v1' } }
```

A single path-segment prefix swap: a path under `from` gets `from` replaced
by `to` and keeps the rest verbatim, query string included. Rejected: a
`rewritePath(path)` callback the gateway calls and forwards the result of.

- **The routing stays explainable.** Core can print the whole table, rule
  included. A callback reduces every explanation to "the plugin returned
  this path". This issue exists because a routing mistake stayed invisible
  for weeks, so inspectability is the property being bought.
- **The rule is validated at registration.** Whether `from` is a prefix the
  upstream owns, whether `to` is a plain path. A callback can return
  anything, including a `..` escape, an absolute URL, or a glued-on query
  string, and the gateway would forward it verbatim.
- **It is fixed at startup.** A callback runs per request on the hot path
  and can throw, hang, or answer differently each time.

The case against is flexibility: a rewrite that is not a prefix swap cannot
be expressed as data without extending the schema. That has no known use
here, and adding a callback later is easy where removing one plugins depend
on is not. Adapters already declare `match()`, arbitrary code deciding
*whether* a request reaches an upstream; arbitrary code deciding *where
within* it would leave no part of the routing decision inspectable by core.

The rewrite travels with the preset that declared it and is **not** copied
onto an operator's same-named config entry. Unlike `record_prefix`
(LLP 0234), which is a persistence anchor the adapter owns, a rewrite
decides where the bytes go, and that is the routing question config owns
outright.

### The row records where the request was sent {#the-row-records-where-the-request-was-sent}

`provider` and `upstream` name the destination the gateway resolved and
forwarded to, not the door the request arrived at. They already did; what
changes is that the two stop being the same fact.

`provider` is the column anyone groups by to ask which credential did the
work, for cost attribution or for knowing how a fleet is logged in. A value
still derived from the path would read `chatgpt` for traffic that went to
OpenAI on an API key, which is simply false, and a wrong value there yields
a confident wrong number rather than an error.

What stays keyed on the inbound path is the projector's choice of body
shape. The body's shape is determined by the request Codex built, not by
where the gateway chose to send it, and the projector already treats path
and body shape as joint signals.

So a row carries two genuinely different facts, and rather than overloading
one column with both, a rerouted request carries its own marker: the
recorder writes the outbound path to `metadata.upstream_path` when, and only
when, a rewrite moved it, and the message projector stamps it at
`attributes.gateway.upstream_path`. "How many requests did the gateway
reroute" is then a query rather than an inference from a path/provider
mismatch.

**Consequence for existing data.** Historical rows keep the values they were
written with, so a time series grouped by `provider` shows a discontinuity
at the release: API-key Codex traffic that used to record `chatgpt` starts
recording `openai`. That is a correction, not a regression, but it is not
retroactive and a saved query over that column should know the boundary
exists.

## Consequences

- A login switch needs no re-attach, no reconcile pass, and no `codex`
  restart. Both clients sharing `config.toml` (Codex CLI and Codex Desktop)
  are covered at once.
- The attach-marker freshness key proposed for issue #996 (a fourth key, so
  a reconciler re-attaches when the auth-derived route drifts) becomes
  vestigial for codex: there is no longer an auth-derived input for a marker
  to go stale on. The hook itself is generic and the next adapter with a
  client-owned input still needs it, so this retires codex's use of it and
  nothing else. That work is in flight on a separate branch and this
  document does not depend on it having landed.
- `AiGatewayUpstreamPreset` grows an optional `rewrite`. It is additive and
  the capability stays at `hypaware.ai-gateway ^2.0.0`. Operator TOML has no
  `rewrite` field: the rule is adapter-declared only, until something needs
  otherwise.
- Proxy mode and absolute-form route by the authority the client named,
  not by `match()`, so a rewriting upstream is skipped on those doors
  however it sorts. It exists to translate a foreign inbound prefix for a
  reverse-proxy door; a client that addressed the host itself is already
  speaking that host's native paths. Routing to it there would also hand
  proxy mode the wrong record anchor and silently drop capture for every
  path the host really serves.
- Header hygiene on a rerouted request is deliberately nothing: no header is
  stripped or synthesized. The credential rung fires only in API-key mode,
  where Codex does not send `chatgpt-account-id` (measured above), and
  `originator` is not mode-gated and is harmless. Stripping headers the
  client chose to send would be a second, unmeasured behavior change riding
  on this one.
- What a hermetic smoke cannot prove is whether `api.openai.com/v1/responses`
  accepts the body Codex builds for this provider block. The shared
  `wire_api = "responses"` makes it likely and nothing else can settle it, so
  the `codex_login_switch_reroute` acceptance procedure exists and is not
  substitutable by a fixture.

## References

- `hypaware-core/plugins-workspace/codex/src/index.js`
  (`matchOpenaiCodexUpstream`, `matchChatgptUpstream`, `codexProviderRoute`)
- `hypaware-core/plugins-workspace/ai-gateway/src/proxy.js`
  (`applyPathRewrite`, `compileUpstreams`)
- `test/plugins/codex-credential-routing.test.js`,
  `test/plugins/codex-attach-route.test.js`,
  `test/plugins/ai-gateway-proxy-routing.test.js`,
  `test/plugins/gateway-openai-upstream-slot.test.js`
- `docs/ACCEPTANCE.md` (`codex_login_switch_reroute`)
- LLP 0099 (superseded by this document), LLP 0157 (extended by it),
  LLP 0161 (the `openai` preset slot), LLP 0234 (`record_prefix`)
