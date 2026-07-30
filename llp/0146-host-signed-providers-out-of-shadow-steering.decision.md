# LLP 0146: Host-signed providers are deferred, not solved

**Type:** Decision
**Status:** Accepted
**Systems:** Plugins, Gateway
**Author:** Phil / Claude
**Date:** 2026-07-29
**Related:** LLP 0152 (plugin-steered shadow providers), LLP 0144 (shadow provider per API shape), LLP 0145 (shadow providers borrow the shadowed credential)

> Bedrock and Vertex are out of scope for the first cut of shadow steering.
> This is a scope choice, not a technical verdict: we are not shipping them
> either way, so we do not need to know first whether their request signing
> survives a retargeted `baseUrl`.

## Context

LLP 0144 makes coverage a function of API shape. That holds for transport
but not for authentication. Two provider families in OpenClaw's catalog
authenticate in a way that is tied to where the request is sent:

- `amazon-bedrock` — AWS SigV4, where the signature covers the `Host` header
  and the credential scope derives from the endpoint's region and service.
- `anthropic-vertex` and Google providers — GCP credentials scoped to the
  Vertex endpoint.

There is reason to expect retargeting `baseUrl` at a local gateway breaks
these, since the client would sign for the local host. Making them work
would likely mean HypAware holding AWS/GCP credentials and reproducing each
vendor's signing algorithm at the gateway.

The earlier draft of this decision treated that expectation as the
*reason* for exclusion, which made an untested premise load-bearing: the
decision could not be Accepted without first testing signing behavior we
have no intention of supporting yet. Inverting it removes that dependency.
The scope choice stands on its own.

## Options considered

1. **Steer them and re-sign at the gateway.** Deferred, not rejected —
   this is what "support Bedrock/Vertex" would eventually mean. Out of
   scope for the first cut on cost grounds alone.
2. **Steer them and find out what happens.** Attractive while the installed
   base is small, and correct for providers we intend to support. Not
   correct here: we are deferring these regardless of the answer, so the
   experiment buys nothing now and risks broken turns for anyone who does
   run them.
3. **Declare them out of scope, pass them through, log it.** Chosen.

## Decision

- The plugin maintains an explicit **deferred set** naming host-signed
  provider families — `amazon-bedrock`, `anthropic-vertex`, and Google
  providers — and passes them through unsteered and uncaptured.
- Each pass-through emits the uncaptured-provider warning, so a deferred
  provider is visible in logs rather than silently absent. (The general
  pass-through-vs-refuse rule is not settled here; see Open questions.)
- The set is a declared list, not a heuristic. A provider is steered unless
  it is named. If a new host-signed provider appears and is steered by
  default, the symptom is confined to that provider, and the fix is a list
  entry.
- Any HypAware surface reporting OpenClaw coverage must be able to say
  "these providers are not captured yet", distinguishing a deferral from a
  gap.

## Consequences

- "All providers" means "all bearer-token providers". That is most of
  OpenClaw's catalog, but docs and coverage reporting must say it
  accurately. Overstating coverage is worse than the deferral.
- Users on Bedrock or Vertex get no OpenClaw capture from this path.
- The list is maintenance the shape-based design was meant to avoid, but it
  is bounded and it fails loudly.
- Nothing here depends on an untested claim, so this decision can be
  Accepted on its own terms.

## Open questions

- Does signing in fact break under a retargeted `baseUrl`? Worth knowing
  **before picking this work up**, not before accepting this decision. Some
  SDKs sign for a configured service endpoint independent of the transport
  target, which would make part of this cheaper than expected.
- ~~`cloudflare-ai-gateway` and `vercel-ai-gateway`~~ — resolved: deferred,
  for a mechanical reason rather than a signing one. Their base URLs are
  per-user (Cloudflare's is built from the user's `accountId` +
  `gatewayId`, verified in OpenClaw's `extensions/cloudflare-ai-gateway/
  onboard.ts`), so no static gateway preset can represent them; they fall
  into LLP 0149's `no_preset` pass-through automatically and join the
  deferred set. Supporting them would need per-user preset registration —
  same revisit trigger as the host-signed families.
- What is the revisit trigger? Fleet volume on these providers is the
  obvious candidate, and HypAware can measure it once anything is captured.

## References

- LLP 0152, 0144, 0145
- `openclaw` repo: `extensions/amazon-bedrock/`,
  `extensions/anthropic-vertex/provider-catalog.ts`
- https://docs.openclaw.ai/concepts/model-providers
