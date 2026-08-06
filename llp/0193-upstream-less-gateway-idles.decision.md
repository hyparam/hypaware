# LLP 0193: an upstream-less gateway idles, and a gateway missing an upstream says so

**Type:** Decision
**Status:** Accepted
**Systems:** Sources, Plugins, CLI
**Author:** Phil / Claude
**Date:** 2026-08-05
**Related:** LLP 0016 (the gateway), LLP 0114 (fixed default listen, and the precedent that an exception to normal binding is visible in status), LLP 0119 / LLP 0120 (hermes needs the gateway plugin but must never be proxied), LLP 0139 (a repair must be runnable)

> `@hypaware/ai-gateway` starting with an empty routing table is a valid
> install, not a failure: the source binds no listener and idles. The
> invariant it replaces ("at least one upstream") stays where it is still
> true, inside `startProxy`. Because idling can also be the shape of a
> misconfiguration, `hyp status` warns whenever the config asked for
> upstreams the routing table did not get.

## Context {#context}

The gateway plugin does two separable jobs. At activation it contributes the
`ai_gateway_messages` dataset and the shared `ai_gateway.projected_exchange`
materializer; at source start it runs the proxy. A config can legitimately
want the first alone.

`@hypaware/hermes` is exactly that config, and both halves of it are settled.
[LLP 0119](./0119-hermes-pull-from-state-db.decision.md) considered attaching
hermes to the gateway and rejected it: HypAware pulls from hermes's own
`state.db`, and hermes is "never modified, configured, or proxied". So the
hermes picker row contributes no `gateway_upstream`, by design.
[LLP 0120](./0120-hermes-rows-are-ai-gateway-messages.decision.md) makes the
gateway plugin a hard `requires.plugins` dependency of hermes anyway, because
its rows land in `ai_gateway_messages` through the gateway's materializer.

Together those rule out the two obvious ways to avoid an upstream-less
gateway. Dropping the gateway from the hermes manifest leaves hermes's hard
dependency unsatisfied, so hermes is eliminated at dependency resolution and
captures nothing. Omitting the gateway when no picked row contributes an
upstream removes the same plugin for the same reason, and also mis-handles
presets, which adapter plugins register at activation, after composition.

That left the invariant `startProxy` had always carried: at least one upstream
before start. It appeared nowhere in `llp/`. A hermes-only picker run, a
reachable first-run choice, therefore composed a config whose source start
threw `ai-gateway: at least one upstream must be configured before start`
(issue #649).

## Decision {#decision}

<a id="idle-not-throw"></a>**An empty routing table idles the source rather
than failing it.** `launchListener` compiles config upstreams together with
adapter presets first and, if the result is empty, binds nothing and returns
no proxy.

The invariant moves rather than disappearing. `startProxy` keeps it: binding a
listener that can route nothing is still a bug at that layer. What changes is
who decides, and the source is the layer that knows an upstream-less gateway
is a legitimate config.

Three properties follow from binding nothing at all:

- `state.listen` stays unset, so `AiGatewayCapability.localEndpoint()` keeps
  throwing instead of handing an attach a URL nothing is listening on.
- `status()` reports `state: 'ready'` with `listening: false` and a message
  saying why. An idle gateway is not an error state.
- `reload()` runs the same path, so idling is recoverable: adding an upstream
  binds a listener with no daemon restart.

<a id="visible-when-unintended"></a>**The same idle state is also what a
broken config looks like, so status distinguishes them by what the config
asked for.** `compileUpstreams` drops an entry missing either `name` or
`base_url`, silently, per entry. Nothing else checks that: the gateway plugin
registers no config section, so `hyp config validate` prints `config ok`, and
`diagnoseV1Config` matches an upstream by its `provider` field, which a
nameless entry still has.

The source therefore publishes the raw configured entry count and the number
of entries that fell out alongside the compiled names, and `hyp status` warns
on the difference. One comparison, two kinds, mutually exclusive:

- `gateway_idle_no_upstreams` when nothing survived: no listener, and every
  client gets connection refused.
- `gateway_upstreams_dropped` when some did: the proxy is bound and looks
  healthy, and traffic for the dropped upstream is silently unrouted and
  uncaptured.

Counts carry the signal and names only decorate it, because `name` is itself
one of the two keys whose absence drops an entry: the config that most needs
the warning can be the one with no name left to print.

## Consequences {#consequences}

- A picker run that selects hermes and nothing else produces a working
  install. That was the point.
- **The warning does not degrade `overall`.** It follows the
  `gateway_port_fallback` precedent from
  [LLP 0114](./0114-gateway-default-listen-port-fixed.decision.md#fallback-is-visible):
  loud in `diagnostics`, not a flip of the health verdict. The accepted cost
  is that a fully broken gateway-only install now reports
  `overall: 'healthy'`, where before this change its daemon failed to start
  loudly. Tooling that gates on `overall === 'healthy'` without reading
  `diagnostics` will not notice it. Whether that trade is the right one for a
  gateway-only install is a product-policy question this document does not
  settle; it records only that the diagnostic exists and is non-degrading.
- The per-entry drop stays silent inside `compileUpstreams`, which has no
  logger and cannot tell a typo from an entry the caller meant to skip. The
  count comparison at the source is what makes it visible, so a new caller of
  `compileUpstreams` that skips the comparison reopens the blind spot.
- The repair points at the config file and the two required keys, never at
  `hyp config validate`, which affirms this config
  ([LLP 0139](./0139-desktop-picker-consent.decision.md#repair-must-be-runnable):
  a repair has to be a step that changes something).
